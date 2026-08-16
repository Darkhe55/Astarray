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
import type { PermissionProfileStore } from "../tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../tools/permission-profile-store.js";
import type { PermissionCapabilityCatalog } from "../tools/permission-capability-catalog.js";
import type { CurrentPermissionSelectionStore } from "../tools/current-permission-selection.js";
import type { MainAgentReadonlyToolProjection } from "../tools/main-agent-readonly-projection.js";
import type { SessionPermissionElevationStore } from "../tools/session-permission-elevation.js";
import type { SessionPermissionElevationController } from "../tools/session-permission-elevation.js";
import type { EffectiveSecondaryPermissionResolver } from "../tools/session-permission-elevation.js";
import type { SessionShutdownCoordinator } from "../tools/session-shutdown-and-export.js";
import type { CurrentPermissionConfigurationExporter } from "../tools/session-shutdown-and-export.js";
import type { RegisteredAgentDirectory } from "./registered-agent-directory.js";
import type { MainAgentReportArchiveIngestor } from "./main-agent-report-archive.js";
import type { TertiaryTerminalReport } from "./main-agent-report-archive.js";
import type { ConversationTaskInsertionController } from "./conversation-task-insertion-controller.js";
import type { TaskInsertionProposal } from "./conversation-task-insertion-controller.js";
import type { SecondaryContinuousDispatchLoop } from "./secondary-continuous-dispatch-loop.js";
import type { TertiaryAgentLifecycleController } from "./tertiary-lifecycle.js";
import type { AgentIndividualMemoryStore } from "./agent-individual-memory.js";
import type { CrossAgentContextAttachmentController } from "./cross-agent-attachment-controller.js";

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
  /** B6R-04b：认证设置控制面依赖（TUI/CLI 共用；非模型工具）。 */
  permissionProfileStore?: PermissionProfileStore | null;
  permissionCapabilityCatalog?: PermissionCapabilityCatalog | null;
  currentPermissionSelectionStore?: CurrentPermissionSelectionStore | null;
  /** B6R-03/04b：当前权限组引用（可信运行时提供）。 */
  currentPermissionProfileReference?: PermissionProfileReference | null;
  /** B6R-06：主 Agent 永久只读投影（任意 profile/提升下不变）。 */
  mainAgentReadonlyProjection?: MainAgentReadonlyToolProjection | null;
  /** B6R-06：会话临时提升控制面（TUI/CLI 认证设置控制面；非模型工具）。 */
  sessionElevationStore?: SessionPermissionElevationStore | null;
  sessionElevationController?: SessionPermissionElevationController | null;
  sessionElevationResolver?: EffectiveSecondaryPermissionResolver | null;
  sessionShutdownCoordinator?: SessionShutdownCoordinator | null;
  sessionExporter?: CurrentPermissionConfigurationExporter | null;
  /** B6R-09：Agent 注册目录（报告来源认证；不可复用身份）。 */
  registeredAgentDirectory?: RegisteredAgentDirectory | null;
  /** B6R-09：主 Agent 报告索引（只写不唤醒；来源认证）。 */
  reportArchiveIngestor?: MainAgentReportArchiveIngestor | null;
  /** B6R-09：对话任务插入控制面（主 Agent 提案；本地验证来源/优先级/锚点）。 */
  conversationTaskInsertionController?: ConversationTaskInsertionController | null;
  /** B6R-09：次级持续调度循环（生产装配；ready set 派发）。 */
  secondaryDispatchLoop?: SecondaryContinuousDispatchLoop | null;
  /** B6R-09：三级生命周期控制器（阶段持久化/幂等收口）。 */
  tertiaryLifecycleController?: TertiaryAgentLifecycleController | null;
  /** B6R-09：Worker 运行时组件（个体记忆/附件/生命周期；生产装配可达）。 */
  tertiaryRuntimeComponents?: {
    individualMemoryStore: AgentIndividualMemoryStore;
    attachmentController: CrossAgentContextAttachmentController;
    lifecycleController: TertiaryAgentLifecycleController;
  } | null;
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

  // ─── B6R-04b：认证设置控制面（只读查询 + 切换；非模型工具） ───────────

  /** 当前权限组引用（优先选择存储；否则运行时注入的默认）。 */
  async getCurrentPermissionProfileReference(): Promise<PermissionProfileReference | null> {
    const selectionStore = this.options.currentPermissionSelectionStore;
    if (selectionStore !== null && selectionStore !== undefined) {
      const selection = await selectionStore.readSelection();
      if (selection !== null) {
        return selection.selectedReference;
      }
    }
    return this.options.currentPermissionProfileReference ?? null;
  }

  /** 权限组公开列表（内置三组 + 自定义组；分页）。 */
  async listPermissionProfiles(input: { page: number; pageSize: number }) {
    const profileStore = this.options.permissionProfileStore;
    if (profileStore === null || profileStore === undefined) {
      return { profiles: [], total: 0, page: input.page, pageSize: input.pageSize };
    }
    const builtinProfiles = ["ponder", "assist", "devolve"].map((profileId) =>
      profileStore.buildBuiltinProfile(profileId as "ponder" | "assist" | "devolve"),
    );
    const customProfiles = await profileStore.listCustomProfiles();
    const allProfiles = [...builtinProfiles, ...customProfiles];
    const page = Math.max(1, input.page);
    const pageSize = Math.max(1, input.pageSize);
    const pageItems = allProfiles.slice((page - 1) * pageSize, page * pageSize);
    return {
      profiles: pageItems.map((profile) => ({
        permissionProfileId: profile.permissionProfileId,
        displayName: profile.displayName,
        isBuiltin: profile.isBuiltin,
        revision: profile.revision,
      })),
      total: allProfiles.length,
      page,
      pageSize,
    };
  }

  /** 认证用户切换当前权限组（持久化；写入自动备份）。 */
  async switchPermissionProfile(reference: PermissionProfileReference): Promise<void> {
    const selectionStore = this.options.currentPermissionSelectionStore;
    if (selectionStore === null || selectionStore === undefined) {
      throw new Error("当前权限组选择存储未装配");
    }
    const current = await selectionStore.readSelection();
    await selectionStore.switchSelection({
      selectedReference: reference,
      expectedRevision: current?.revision ?? 0,
    });
  }

  // ─── B6R-06：主 Agent 永久只读 + 会话提升控制面 ───────────────────────

  /** 主 Agent 可用工具名（任意 profile/提升下恒为只读白名单）。 */
  getMainAgentToolProjection(): string[] {
    const projection = this.options.mainAgentReadonlyProjection;
    if (projection === null || projection === undefined) {
      return [];
    }
    return projection.projectTools(
      this.options.registry.getPreviewDescriptors().map((descriptor) => descriptor.name),
    );
  }

  /** 会话级/个体级提升列表（公开字段）。 */
  async listSessionElevations(sessionId: string) {
    const elevationStore = this.options.sessionElevationStore;
    if (elevationStore === null || elevationStore === undefined) {
      return [];
    }
    return (await elevationStore.listRecords(sessionId)).map((record) => ({
      elevationId: record.elevationId,
      scope: record.scope,
      capabilityId: record.capabilityId,
      resourceScope: record.resourceScope,
      originalDecision: record.originalDecision,
      elevatedDecision: record.elevatedDecision,
      createdAtIso: record.createdAtIso,
      expiresAtIso: record.expiresAtIso,
    }));
  }

  /** 认证用户创建会话/个体提升（不提供"提升主 Agent"）。 */
  async createSessionElevation(input: {
    sessionId: string;
    agentInstanceId: string | null;
    capabilityId: string;
    resourceScope: string;
    elevatedDecision: "allow" | "ask";
    expiresAtIso: string | null;
    userDecisionReference: string;
    currentSessionPermissionRevision: number;
  }): Promise<{
    elevationId: string;
    originalDecision: string;
    elevatedDecision: string;
  }> {
    const elevationController = this.options.sessionElevationController;
    const profileStore = this.options.permissionProfileStore;
    if (
      elevationController === null ||
      elevationController === undefined ||
      profileStore === null ||
      profileStore === undefined
    ) {
      throw new Error("会话提升控制面未装配");
    }
    // 基础决定从当前 profile 快照读取（可信来源）
    const reference = await this.getCurrentPermissionProfileReference();
    if (reference === null) {
      throw new Error("未选择当前权限组");
    }
    const profile = await profileStore.readProfile(reference);
    const originalDecision =
      profile.capabilityDecisions[input.capabilityId] ?? profile.fallbackDecision;
    if (originalDecision === "allow" && input.elevatedDecision === "ask") {
      throw new Error("提升方向必须更宽");
    }
    const scope =
      input.agentInstanceId === null
        ? { scope: "all-secondary-agents-in-session" as const }
        : {
            scope: "specific-secondary-agent" as const,
            agentInstanceId: input.agentInstanceId,
          };
    const record = await elevationController.createElevation({
      sessionId: input.sessionId,
      scope,
      capabilityId: input.capabilityId,
      resourceScope: input.resourceScope,
      baseProfileReference: reference,
      baseProfileRevision: profile.revision,
      catalogVersion: profile.catalogVersion,
      originalDecision,
      elevatedDecision: input.elevatedDecision,
      expiresAtIso: input.expiresAtIso,
      userDecisionReference: input.userDecisionReference,
      sessionPermissionRevision: input.currentSessionPermissionRevision,
    });
    return {
      elevationId: record.elevationId,
      originalDecision: record.originalDecision,
      elevatedDecision: record.elevatedDecision,
    };
  }

  /** 认证用户撤销提升。 */
  async revokeSessionElevation(input: {
    sessionId: string;
    elevationId: string;
  }): Promise<boolean> {
    const elevationController = this.options.sessionElevationController;
    if (elevationController === null || elevationController === undefined) {
      throw new Error("会话提升控制面未装配");
    }
    return elevationController.revokeElevation({
      sessionId: input.sessionId,
      elevationId: input.elevationId,
    });
  }

  /** 关闭会话（收敛 → 可选导出 → 无条件撤销全部提升）。 */
  async shutdownSession(input: {
    sessionId: string;
    exportPath: string | null;
  }): Promise<{
    closed: boolean;
    revokedElevationCount: number;
    exportWrote: boolean;
    exportFailedReason: string | null;
  }> {
    const shutdownCoordinator = this.options.sessionShutdownCoordinator;
    const elevationStore = this.options.sessionElevationStore;
    const exporter = this.options.sessionExporter;
    const profileStore = this.options.permissionProfileStore;
    if (
      shutdownCoordinator === null ||
      shutdownCoordinator === undefined ||
      elevationStore === null ||
      elevationStore === undefined
    ) {
      throw new Error("会话关闭协调器未装配");
    }
    let exportSnapshot = null;
    if (
      input.exportPath !== null &&
      exporter !== null &&
      exporter !== undefined &&
      profileStore !== null &&
      profileStore !== undefined
    ) {
      const currentReference = await this.getCurrentPermissionProfileReference();
      if (currentReference !== null) {
        const baseProfile = await profileStore.readProfile(currentReference);
        exportSnapshot = await exporter.exportEffectiveConfiguration({
          sessionId: input.sessionId,
          agentInstanceId: null,
          baseProfile,
          currentProfileReference: currentReference,
          elevationStore,
          resolver: this.options.sessionElevationResolver ?? (null as never),
          nowUnixMilliseconds: Date.now(),
          isAgentRetired: () => false,
          currentSessionPermissionRevision: 1,
        });
      }
    }
    return shutdownCoordinator.shutdownSession({
      sessionId: input.sessionId,
      drainInFlightCalls: async () => {},
      exportPath: input.exportPath,
      exportSnapshot,
    });
  }

  // ─── B6R-09：编排接入（提案/报告/生命周期） ────────────────────────────

  /** 主 Agent 提交任务插入提案（本地控制面验证；提交后立即回对话循环）。 */
  async submitTaskInsertionProposal(
    proposal: TaskInsertionProposal,
  ): Promise<void> {
    const insertionController = this.options.conversationTaskInsertionController;
    if (insertionController === null || insertionController === undefined) {
      throw new Error("对话任务插入控制面未装配");
    }
    await insertionController.submitProposal(proposal);
  }

  /** 登记 Agent（报告来源认证；不可复用身份）。 */
  registerAgent(input: {
    agentInstanceId: string;
    agentRole: "secondary" | "tertiary";
    missionId: string;
    owningSecondaryAgentInstanceId: string | null;
    boundTaskBundleId: string | null;
  }): void {
    const directory = this.options.registeredAgentDirectory;
    if (directory === null || directory === undefined) {
      throw new Error("Agent 注册目录未装配");
    }
    directory.registerAgent({
      agentInstanceId: input.agentInstanceId,
      agentRole: input.agentRole,
      missionId: input.missionId,
      owningSecondaryAgentInstanceId: input.owningSecondaryAgentInstanceId,
      boundTaskBundleId: input.boundTaskBundleId,
      registeredAtIso: new Date().toISOString(),
    });
  }

  /** 三级终态报告只写主 Agent 报告索引（不唤醒主 Agent 模型/不注入对话）。 */
  async ingestTertiaryTerminalReport(
    report: TertiaryTerminalReport,
  ): Promise<void> {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      throw new Error("报告索引未装配");
    }
    await ingestor.ingestReport(report);
  }

  /** 读取报告索引（主 Agent 后续轮次只读选择用）。 */
  async listReportIndex(missionId: string) {
    const ingestor = this.options.reportArchiveIngestor;
    if (ingestor === null || ingestor === undefined) {
      return [];
    }
    return ingestor.readIndex(missionId);
  }

  /** 次级持续调度循环（生产装配可达性 + 编排接入点）。 */
  getSecondaryDispatchLoop(): SecondaryContinuousDispatchLoop | null {
    return this.options.secondaryDispatchLoop ?? null;
  }

  /** 三级生命周期控制器（生产装配可达性 + 受控收口接入点）。 */
  getTertiaryLifecycleController(): TertiaryAgentLifecycleController | null {
    return this.options.tertiaryLifecycleController ?? null;
  }

  /** Worker 运行时组件（个体记忆/附件控制器；生产装配可达性）。 */
  getTertiaryRuntimeComponents() {
    return this.options.tertiaryRuntimeComponents ?? null;
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
