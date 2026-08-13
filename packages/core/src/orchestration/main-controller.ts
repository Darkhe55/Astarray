/**
 * 主 Agent 控制器（T08）。
 * 职责：接收用户消息、维护模式与任务概要、Ponder 直接问答、
 * Assist 召唤次级调度后立即回到输入循环、Devolve 直接调度、
 * 权限询问转达用户并记录会话授权。
 */
import { randomUUID } from "node:crypto";

import type {
  AgentMode,
  AgentRuntime,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  TaskStorePort,
  ToolPort,
} from "../core/types.js";
import type { SessionAuthorizationManager } from "../core/permission-policy.js";
import { hashToolArguments } from "../core/permission-policy.js";
import type { ModeMachine } from "../core/mode-machine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkspaceBoundary } from "../tools/workspace-boundary.js";
import type { BackupDeletionAuthorizationController, BackupVault } from "../tools/backup-vault.js";
import type { AgentWorkArchiveStore } from "./work-archive-store.js";
import { AssistScheduler } from "./assist-scheduler.js";
import { DevolveScheduler } from "./devolve-scheduler.js";
import type { MissionManager } from "./mission-manager.js";
import type { GitIntegrationOrchestrationOptions } from "./mission-orchestrator.js";

export interface MainControllerOptions {
  modeMachine: ModeMachine;
  sessionManager: SessionAuthorizationManager;
  taskStore: TaskStorePort;
  missionManager: MissionManager;
  registry: ToolRegistry;
  feedbackTransport: FeedbackTransportPort;
  workspaceBoundary: WorkspaceBoundary;
  temporaryDirectoryPath: string;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  /** 次级/主 Agent 的 LLM 运行时工厂。 */
  mainRuntimeFactory: (agentInstanceId: string) => AgentRuntime;
  workerRuntimeFactory: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  /** Worker 工具端口工厂：按任务工具子集包装权限策略。 */
  buildWorkerToolPort: (
    task: TaskDependencyNode,
    allowedToolNames: Set<string>,
  ) => ToolPort;
  buildPermissionExplanation: (toolName: string) => string;
  /** 流式输出到 UI 的回调。 */
  streamOutput: (missionId: string | null, text: string) => void;
  /** 权限询问弹窗回调（Assist）。 */
  onPermissionAsk?: (ask: {
    missionId: string;
    taskId: string;
    toolName: string;
    argumentsJson: string;
    explanation: string;
  }) => void;
  onMissionFinished?: (missionId: string, status: "done" | "cancelled") => void;
  /** T06A：自动备份库（可选；缺省时破坏性工具拒绝执行）。 */
  backupVault?: BackupVault | null;
  backupDeletionController?: BackupDeletionAuthorizationController | null;
  /** T05A：Agent 工作存档（可选）。 */
  workArchiveStore?: AgentWorkArchiveStore | null;
  /** T05B → T08：Git 集成装配（可选；缺省时编排行为与旧版一致）。 */
  gitIntegration?: GitIntegrationOrchestrationOptions | null;
  /** T05B：次级调度 Agent 具体实例 ID 工厂（每次 mission 不可复用）。 */
  secondaryAgentInstanceIdFactory?: (missionId: string) => string;
}

export class MainController {
  private readonly activeOrchestrators = new Map<
    string,
    { scheduler: AssistScheduler | DevolveScheduler; mode: AgentMode }
  >();

  constructor(private readonly options: MainControllerOptions) {}

  /** 模式切换（TUI 调用）：交由状态机校验，非法迁移抛 DomainError。 */
  transitionMode(nextMode: AgentMode): void {
    this.options.modeMachine.transition(nextMode, "user-request");
  }

  getCurrentMode(): AgentMode {
    return this.options.modeMachine.getCurrentMode();
  }

  /** 指标快照（TUI 头栏使用）；未配置指标时返回 null。 */
  getMetricsSnapshot(): {
    toolCalls: number;
    providerCalls: number;
    estimatedTokenCount: number;
    cacheHits: number;
    cacheMisses: number;
  } | null {
    return null;
  }

  /**
   * 处理用户消息。Ponder 直接问答；Assist/Devolve 创建/接管 mission
   * 后立即返回（不阻塞输入循环）。
   */
  async handleUserMessage(message: string): Promise<string> {
    const mode = this.options.modeMachine.getCurrentMode();
    if (mode === "ponder") {
      await this.respondInPonderMode(message);
      return "ponder";
    }
    const missionId = `mission-${randomUUID().slice(0, 8)}`;
    const taskNodes = this.decomposePromptForScriptedRun(message);
    await this.options.missionManager.createMission({
      missionId,
      mode,
      prompt: message,
      taskNodes,
    });
    if (mode === "assist") {
      this.launchAssistMission(missionId, taskNodes);
    } else {
      this.launchDevolveMission(missionId, taskNodes);
    }
    return missionId;
  }

  /** 用户裁决：允许（含会话级）或拒绝权限请求。 */
  async grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void> {
    this.options.sessionManager.grant(
      toolName,
      hashToolArguments(argumentsJson),
      nowUnixSeconds,
    );
  }

  async queryMissionStatus(missionId: string) {
    return this.options.missionManager.getMissionStatus(missionId);
  }

  async cancelMission(missionId: string): Promise<void> {
    const active = this.activeOrchestrators.get(missionId);
    if (active !== undefined) {
      await active.scheduler.cancel();
    }
    await this.options.missionManager.updateMissionStatus(missionId, "cancelled");
  }

  getActiveMissionIds(): string[] {
    return [...this.activeOrchestrators.keys()];
  }

  /** 向次级调度发送裁决指令（Assist，经反馈信箱）。 */
  sendSchedulerInstruction(missionId: string, instructionText: string): void {
    void this.options.feedbackTransport.enqueue({
      protocolVersion: 1,
      messageId: randomUUID(),
      source: { sourceType: "user", sourceIdentifier: "main-controller" },
      recipientId: `scheduler:${missionId}`,
      priority: "instruction",
      createdAtIso: new Date().toISOString(),
      idempotencyKey: `main-instruction:${missionId}:${Date.now()}`,
      payload: { kind: "instruction", instructionText },
    });
  }

  private async respondInPonderMode(message: string): Promise<void> {
    const agentInstanceId = `main:ponder:${randomUUID().slice(0, 8)}`;
    const runtime = this.options.mainRuntimeFactory(agentInstanceId);
    for await (const event of runtime.run(
      {
        missionId: null,
        agentId: agentInstanceId,
        systemPrompt: "你是主 Agent（Ponder 模式）：纯问答，不调用任何工具。",
        userPrompt: message,
        availableToolDescriptors: [],
        maxLoopIterations: 1,
      },
      new AbortController().signal,
    )) {
      if (event.kind === "textDelta") {
        this.options.streamOutput(null, event.deltaText);
      }
    }
  }

  private launchAssistMission(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): void {
    const initialChain = this.buildInitialChain(missionId, taskNodes);
    const scheduler = new AssistScheduler({
      missionId,
      initialChain,
      taskStore: this.options.taskStore,
      concurrency: this.options.concurrency,
      failureThreshold: this.options.failureThreshold,
      maxLoopIterations: this.options.maxLoopIterations,
      feedbackTransport: this.options.feedbackTransport,
      feedbackTransportFactory: async () => this.options.feedbackTransport,
      workArchiveStore: this.options.workArchiveStore ?? null,
      secondaryAgentInstanceId:
        this.options.secondaryAgentInstanceIdFactory?.(missionId) ??
        `scheduler:${missionId}`,
      gitIntegration: this.options.gitIntegration ?? null,
      workerFactories: {
        runtimeFactory: this.options.workerRuntimeFactory,
        toolPortFactory: (task) =>
          this.options.buildWorkerToolPort(task, new Set(task.toolNames)),
        buildPermissionExplanation: this.options.buildPermissionExplanation,
      },
      onReportToMain: (message) => {
        if (message.payload.kind !== "instruction") {
          return;
        }
        if (message.payload.instructionText.startsWith("任务完成状态:")) {
          const status = message.payload.instructionText.includes("done")
            ? "done"
            : "cancelled";
          this.options.onMissionFinished?.(missionId, status);
          return this.options.missionManager.updateMissionStatus(missionId, status);
        }
        this.options.streamOutput(missionId, `[需要用户] ${message.payload.instructionText}`);
      },
    });
    this.activeOrchestrators.set(missionId, { scheduler, mode: "assist" });
    void scheduler.start();
  }

  private launchDevolveMission(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): void {
    const initialChain = this.buildInitialChain(missionId, taskNodes);
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore: this.options.taskStore,
      concurrency: this.options.concurrency,
      failureThreshold: this.options.failureThreshold,
      maxLoopIterations: this.options.maxLoopIterations,
      feedbackTransportFactory: async () => this.options.feedbackTransport,
      workArchiveStore: this.options.workArchiveStore ?? null,
      secondaryAgentInstanceId:
        this.options.secondaryAgentInstanceIdFactory?.(missionId) ??
        `scheduler:${missionId}`,
      gitIntegration: this.options.gitIntegration ?? null,
      workerFactories: {
        runtimeFactory: this.options.workerRuntimeFactory,
        toolPortFactory: (task) =>
          this.options.buildWorkerToolPort(task, new Set(task.toolNames)),
        buildPermissionExplanation: this.options.buildPermissionExplanation,
      },
      onMissionFinished: (status) => {
        void this.options.missionManager.updateMissionStatus(missionId, status);
        this.options.onMissionFinished?.(missionId, status);
      },
      onUserEscalation: (message) => {
        this.options.streamOutput(missionId, `[需要用户] ${message}`);
      },
    });
    this.activeOrchestrators.set(missionId, { scheduler, mode: "devolve" });
    void scheduler.start();
  }

  private buildInitialChain(
    missionId: string,
    taskNodes: TaskChainDocument["tasks"],
  ): TaskChainDocument {
    return {
      schemaVersion: 1,
      missionId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      tasks: taskNodes,
    };
  }

  /**
   * 任务分解：v0.1 使用确定性分解（单任务）。
   * 真实 LLM 分解由次级 Agent 的运行时在 T14 演进中替换。
   */
  private decomposePromptForScriptedRun(
    prompt: string,
  ): TaskDependencyNode[] {
    return [
      {
        id: "T-001",
        description: prompt,
        dependsOn: [],
        taskType: "data",
        toolNames: this.options.registry
          .getFullDescriptors()
          .map((descriptor) => descriptor.name),
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ];
  }
}
