/**
 * 任务编排运行循环（T08）。
 * 事件驱动：scheduleRound → 启动 Worker → Worker 结果唤醒循环 →
 * 处理结果（done/failed/ambiguous/permission-ask/cancelled）→ 再调度，
 * 直到 complete-mission 或取消。全程不阻塞主 Agent 输入循环。
 */
import { createHash } from "node:crypto";

import type {
  AgentRuntime,
  AgentWorkArchiveAttachment,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  TaskStorePort,
  ToolPort,
} from "../core/types.js";
import type { AgentWorkArchiveStore } from "./work-archive-store.js";
import { DagScheduler } from "./dag-scheduler.js";
import type { ScheduleAction } from "./dag-scheduler.js";
import { ToolFailureCounter } from "./failure-counter.js";
import { WorkerAgent } from "./worker-agent.js";
import type { WorkerOutcome } from "./worker-agent.js";

export interface OrchestratorWorkerFactories {
  runtimeFactory: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  toolPortFactory: (task: TaskDependencyNode) => ToolPort;
  buildPermissionExplanation: (toolName: string) => string;
}

export interface MissionOrchestratorOptions {
  missionId: string;
  initialChain: TaskChainDocument;
  taskStore: TaskStorePort;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  workerFactories: OrchestratorWorkerFactories;
  feedbackTransportFactory: () => Promise<FeedbackTransportPort>;
  onMissionFinished: (status: "done" | "cancelled") => void | Promise<void>;
  /** 无法由调度层裁决、需要用户输入时回调（ambiguity / 裁决指令无法解析）。 */
  onUserEscalation: (message: string) => void;
  /** T05A：Agent 工作存档（可选；缺失时 Worker 不写存档、不附加上下文）。 */
  workArchiveStore?: AgentWorkArchiveStore | null;
  /**
   * T05A 冻结规则：默认不附加存档上下文；只有上级显式开启时才在重新调用时
   * 附加按属主选择的结果类条目（审计 S6：取消"自动附加最近五条"）。
   */
  attachArchiveContextOnRetry?: boolean;
}

export type WorkerOutcomeHandler = (
  taskId: string,
  outcome: WorkerOutcome,
) => void | Promise<void>;

export class MissionOrchestrator {
  private readonly dagScheduler: DagScheduler;
  private readonly failureCounters = new Map<string, ToolFailureCounter>();
  private readonly inFlightTaskIds = new Set<string>();
  private readonly inFlightWorkerPromises = new Set<Promise<void>>();
  private stopping = false;
  private wakeResolve: (() => void) | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(private readonly options: MissionOrchestratorOptions) {
    this.dagScheduler = new DagScheduler(options.initialChain, {
      concurrency: options.concurrency,
      taskStore: options.taskStore,
      allocateAgentId: (taskId: string) => `worker:${this.options.missionId}:${taskId}`,
    });
  }

  start(): Promise<void> {
    if (this.runPromise === null) {
      this.runPromise = this.runLoop();
    }
    return this.runPromise;
  }

  /**
   * 取消：停止调度循环，等待在途 Worker 与循环收敛后返回。
   * 无在途 Worker 时确定性等待循环结束（保证无后台持久化写操作遗留）；
   * 存在挂起 Worker 时以 2 秒为上限（真实工具可能不可中断）。
   */
  async cancel(): Promise<void> {
    this.stopping = true;
    this.wake();
    if (this.inFlightWorkerPromises.size === 0) {
      await (this.runPromise ?? Promise.resolve());
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.inFlightWorkerPromises]),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await Promise.race([
      this.runPromise ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  getRunningTaskIds(): string[] {
    return [...this.inFlightTaskIds];
  }

  /** 供主 Agent 直接调度（Devolve）或指令处理（Assist）使用。 */
  async unblockTask(taskId: string): Promise<void> {
    await this.dagScheduler.unblockTask(taskId);
    this.wake();
  }

  async reassignTask(taskId: string): Promise<void> {
    await this.dagScheduler.reassignTask(taskId);
    this.wake();
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.dagScheduler.cancelTask(taskId);
    this.wake();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const actions = await this.dagScheduler.scheduleRound();
      for (const action of actions) {
        if (action.action === "start-task") {
          void this.launchWorker(action).catch((error: Error) => {
            this.options.onUserEscalation(
              `Worker 启动失败（任务 ${action.taskId}）: ${error.message}`,
            );
          });
        } else if (action.action === "complete-mission") {
          await this.finishMission("done");
          return;
        }
      }
      const hasActionableAction = actions.some(
        (action) => action.action !== "block-task",
      );
      if (this.inFlightTaskIds.size > 0 || !hasActionableAction) {
        await this.sleepUntilWake();
      }
    }
    await this.finishMission("cancelled");
  }

  private async launchWorker(
    action: Extract<ScheduleAction, { action: "start-task" }>,
  ): Promise<void> {
    const { missionId } = this.options;
    const task = this.dagScheduler
      .getCurrentGraph()
      .getNode(action.taskId);
    if (task === undefined) {
      return;
    }
    // 每次启动生成唯一且不可复用的 Worker 实例 ID（审计 S6：重分配不得复用同一 ID）
    const agentInstanceId = this.nextWorkerInstanceId(action.taskId);
    this.inFlightTaskIds.add(action.taskId);
    const workArchiveStore = this.options.workArchiveStore ?? null;
    const archiveAttachments =
      workArchiveStore !== null &&
      this.options.attachArchiveContextOnRetry === true
        ? await this.selectArchiveAttachmentsForTask(task.id, workArchiveStore)
        : [];
    const worker = new WorkerAgent({
      agentInstanceId,
      missionId,
      task,
      runtime: this.options.workerFactories.runtimeFactory(agentInstanceId, task),
      toolPort: this.options.workerFactories.toolPortFactory(task),
      failureCounter: this.getFailureCounter(task.id),
      feedbackTransport: await this.options.feedbackTransportFactory(),
      maxLoopIterations: this.options.maxLoopIterations,
      buildPermissionExplanation:
        this.options.workerFactories.buildPermissionExplanation,
      workArchiveStore,
      archiveAttachments,
    });
    const workerPromise = (async () => {
      const outcome = await worker.run();
      this.inFlightTaskIds.delete(action.taskId);
      await this.handleWorkerOutcome(action.taskId, outcome);
    })();
    this.inFlightWorkerPromises.add(workerPromise);
    void workerPromise.finally(() => {
      this.inFlightWorkerPromises.delete(workerPromise);
      this.wake();
    });
  }

  private getFailureCounter(taskId: string): ToolFailureCounter {
    let counter = this.failureCounters.get(taskId);
    if (counter === undefined) {
      counter = new ToolFailureCounter(this.options.failureThreshold);
      this.failureCounters.set(taskId, counter);
    }
    return counter;
  }

  /**
   * T05A 上下文选择器：重新调用任务时，按属主（Agent）分别选择结果类条目，
   * 为每个属主生成一个 provenance 正确的附件（审计 S6：不再合并后虚构 owner/revision）。
   * 仅在 attachArchiveContextOnRetry 显式开启时调用；默认不附加。
   */
  private async selectArchiveAttachmentsForTask(
    taskId: string,
    store: AgentWorkArchiveStore,
  ): Promise<AgentWorkArchiveAttachment[]> {
    const agentIds = await store.listAgentIdsWithArchive(this.options.missionId);
    const attachments: AgentWorkArchiveAttachment[] = [];
    for (const agentInstanceId of agentIds) {
      const archive = await store.readArchive(this.options.missionId, agentInstanceId);
      if (archive === null) {
        continue;
      }
      const selectedEntries = archive.entries.filter(
        (entry) =>
          entry.taskId === taskId &&
          (entry.entryType === "result" ||
            entry.entryType === "failure" ||
            entry.entryType === "decision" ||
            entry.entryType === "progress"),
      );
      if (selectedEntries.length === 0) {
        continue;
      }
      const canonical = JSON.stringify(selectedEntries);
      attachments.push({
        archiveOwnerAgentInstanceId: archive.agentInstanceId,
        archiveRevision: archive.revision,
        selectedArchiveEntries: selectedEntries,
        selectionReason: "任务重新调用：上级显式开启的选择性上下文附加",
        contentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
      });
    }
    return attachments;
  }

  private workerInstanceCounter = 0;

  private nextWorkerInstanceId(taskId: string): string {
    this.workerInstanceCounter += 1;
    return `worker:${this.options.missionId}:${taskId}:${this.workerInstanceCounter}`;
  }

  private async handleWorkerOutcome(
    taskId: string,
    outcome: WorkerOutcome,
  ): Promise<void> {
    switch (outcome.outcome) {
      case "success":
        await this.dagScheduler.finishTask(taskId, "done", outcome.resultLocation);
        break;
      case "failure":
        await this.dagScheduler.finishTask(taskId, "failed", null);
        this.options.onUserEscalation(
          `任务 ${taskId} 失败：${outcome.failureReason}（状态：${outcome.stateSummary}）`,
        );
        break;
      case "ambiguous":
        await this.dagScheduler.blockTaskForHumanDecision(taskId);
        this.options.onUserEscalation(
          `任务 ${taskId} 信息不足：${outcome.unclearPoints.join("；")}（需要：${outcome.requestedInformation}）`,
        );
        break;
      case "permission-ask":
        await this.dagScheduler.blockTaskForHumanDecision(taskId);
        this.options.onUserEscalation(
          `任务 ${taskId} 需要权限调用 ${outcome.toolName}（${outcome.explanation}），参数: ${outcome.argumentsJson}`,
        );
        break;
      case "cancelled":
        await this.dagScheduler.releaseTaskBackToPending(taskId);
        break;
    }
  }

  private async finishMission(status: "done" | "cancelled"): Promise<void> {
    await this.options.onMissionFinished(status);
  }

  private sleepUntilWake(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
    });
  }

  private wake(): void {
    const resolver = this.wakeResolve;
    this.wakeResolve = null;
    resolver?.();
  }
}
