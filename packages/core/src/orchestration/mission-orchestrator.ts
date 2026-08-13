/**
 * 任务编排运行循环（T08）。
 * 事件驱动：scheduleRound → 启动 Worker → Worker 结果唤醒循环 →
 * 处理结果（done/failed/ambiguous/permission-ask/cancelled）→ 再调度，
 * 直到 complete-mission 或取消。全程不阻塞主 Agent 输入循环。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import type {
  AgentRuntime,
  AgentWorkArchiveAttachment,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  TaskStorePort,
  ToolPort,
} from "../core/types.js";
import type { GitWorkerAllocation } from "../core/types.js";
import type { GitIntegrationReport } from "../core/types.js";
import type { AgentWorkArchiveStore } from "./work-archive-store.js";
import { DagScheduler } from "./dag-scheduler.js";
import type { ScheduleAction } from "./dag-scheduler.js";
import { ToolFailureCounter } from "./failure-counter.js";
import { WorkerAgent } from "./worker-agent.js";
import type { WorkerOutcome } from "./worker-agent.js";
import type { GitIntegrationCoordinator } from "./git-integration-coordinator.js";
import { GitProcess } from "./git-process.js";

export interface OrchestratorWorkerFactories {
  runtimeFactory: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  toolPortFactory: (task: TaskDependencyNode) => ToolPort;
  buildPermissionExplanation: (toolName: string) => string;
}

/**
 * T05B → T08 接入：编排层 Git 集成配置。
 * 装配后，写入型任务（taskType 在 allowedPathsByTaskType 中）自动获得
 * 隔离 worker 分支/worktree；Worker 完成后提交由次级集成者审查，
 * 审查通过才合并；mission 完成时运行集成测试并按门禁合入目标分支。
 */
export interface GitIntegrationOrchestrationOptions {
  coordinator: GitIntegrationCoordinator;
  repositoryPath: string;
  targetBranchName: string;
  /** 任务类型 → 允许修改路径（仓库相对路径）；未列出的任务类型不做 Git 分流。 */
  allowedPathsByTaskType: Record<string, string[]>;
  /** 集成测试命令（仓库目录 shell 执行；同时作为 Worker 贡献的测试证据，实际执行）。 */
  integrationTestCommands: string[];
  /** 目标分支合并门禁（模式/用户授权由装配方注入；Ponder/Assist 默认禁止自动合并）。 */
  isTargetBranchMergeAllowed: () => boolean;
  /** 写入型任务在隔离 worktree 内工作的工具端口工厂（worktree 即 Worker 的工作区）。 */
  buildGitWorktreeToolPort: (
    task: TaskDependencyNode,
    worktreePath: string,
  ) => ToolPort;
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
  /**
   * T05B：次级 Agent 具体且不可复用的个体 ID（集成分支命名与工作存档属主）。
   * 未提供时回退 scheduler:<missionId>（仅用于无 Git 装配的旧路径）。
   */
  secondaryAgentInstanceId?: string;
  /** T05B → T08：Git 集成装配（可选；缺省时编排行为与旧版一致）。 */
  gitIntegration?: GitIntegrationOrchestrationOptions | null;
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
  /** T05B：任务 → worker 分配记录（写入型任务）。 */
  private readonly gitAllocations = new Map<string, GitWorkerAllocation>();
  private gitIntegrationSession: GitIntegrationReport | null = null;
  private gitIntegrationSessionStarted = false;
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
      await this.ensureGitIntegrationSession();
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

  /**
   * T05B：首次调度前启动集成会话（固定基线 + 创建集成分支）。
   * 失败不阻断调度（escalation 提示），后续写入型 Worker 分配会再次触发。
   */
  private async ensureGitIntegrationSession(): Promise<void> {
    const gitIntegration = this.options.gitIntegration;
    if (
      gitIntegration === null ||
      gitIntegration === undefined ||
      this.gitIntegrationSessionStarted
    ) {
      return;
    }
    this.gitIntegrationSessionStarted = true;
    try {
      const secondaryAgentInstanceId =
        this.options.secondaryAgentInstanceId ??
        `scheduler:${this.options.missionId}`;
      this.gitIntegrationSession =
        await gitIntegration.coordinator.startIntegrationSession({
          missionId: this.options.missionId,
          integratingAgentInstanceId: secondaryAgentInstanceId,
          repositoryPath: gitIntegration.repositoryPath,
          targetBranchName: gitIntegration.targetBranchName,
        });
    } catch (error) {
      this.options.onUserEscalation(
        `Git 集成会话启动失败: ${(error as Error).message}`,
      );
    }
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
    // T05B：写入型任务分配隔离 worker 分支/worktree，工具端口指向 worktree
    const gitIntegration = this.options.gitIntegration;
    const allowedPaths = gitIntegration?.allowedPathsByTaskType[task.taskType];
    let workerToolPort = this.options.workerFactories.toolPortFactory(task);
    if (
      gitIntegration !== null &&
      gitIntegration !== undefined &&
      allowedPaths !== undefined &&
      this.gitIntegrationSession !== null
    ) {
      try {
        const allocation =
          await gitIntegration.coordinator.worktreeAllocator().allocateWorker(
            {
              missionId,
              taskId: task.id,
              tertiaryAgentInstanceId: agentInstanceId,
              integrationBranchName:
                this.gitIntegrationSession.integrationBranchName,
              targetBaseCommit: this.gitIntegrationSession.targetBaseCommit,
              allowedPaths,
            },
            gitIntegration.repositoryPath,
          );
        this.gitAllocations.set(task.id, allocation);
        workerToolPort = gitIntegration.buildGitWorktreeToolPort(
          task,
          allocation.worktreePath,
        );
      } catch (error) {
        this.options.onUserEscalation(
          `写入型任务 ${task.id} 的 Git worktree 分配失败: ${(error as Error).message}`,
        );
        return;
      }
    }
    const worker = new WorkerAgent({
      agentInstanceId,
      missionId,
      task,
      runtime: this.options.workerFactories.runtimeFactory(agentInstanceId, task),
      toolPort: workerToolPort,
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
      case "success": {
        // T05B：写入型任务先提交并审查，审查通过才标记 done
        const gitIntegration = this.options.gitIntegration;
        const allocation = this.gitAllocations.get(taskId) ?? null;
        try {
          if (
            gitIntegration !== null &&
            gitIntegration !== undefined &&
            allocation !== null
          ) {
            const review = await this.submitGitContribution(
              taskId,
              gitIntegration,
              allocation,
              outcome.summary,
            );
            if (!review.isAccepted) {
              await this.dagScheduler.blockTaskForHumanDecision(taskId);
              this.options.onUserEscalation(
                `任务 ${taskId} 的 Git 贡献被审查拒绝（未合并）: ${review.rejectionReasons.join("；")}`,
              );
              break;
            }
          }
          await this.dagScheduler.finishTask(taskId, "done", outcome.resultLocation);
        } catch (error) {
          // Git 提交/审查异常：任务保持未完成并升级，不允许 unhandled rejection
          await this.dagScheduler.blockTaskForHumanDecision(taskId).catch(() => null);
          this.options.onUserEscalation(
            `任务 ${taskId} 的 Git 提交/审查失败（未合并）: ${(error as Error).message}`,
          );
        }
        break;
      }
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

  /**
   * T05B：Worker 在隔离 worktree 的提交 → 运行证据命令 → 次级集成者审查。
   * 无改动时视为无贡献（直接放行）；审查失败保持未合并并返回拒绝原因。
   */
  private async submitGitContribution(
    taskId: string,
    gitIntegration: GitIntegrationOrchestrationOptions,
    allocation: GitWorkerAllocation,
    workerSummary: string,
  ): Promise<{ isAccepted: boolean; rejectionReasons: string[] }> {
    const gitProcess = new GitProcess();
    // 暂存全部改动（含越界文件），由审查的 allowedPaths 校验拦截越界提交；
    // 仅暂存允许路径会让越界修改留在 worktree 而绕过审查。
    await gitProcess
      .run(allocation.worktreePath, ["add", "-A"], `暂存全部改动`)
      .catch(() => null);
    const statusResult = await gitProcess
      .run(allocation.worktreePath, ["status", "--porcelain"], `检查待提交改动`)
      .catch(() => null);
    if (statusResult === null || statusResult.stdoutText.trim() === "") {
      return { isAccepted: true, rejectionReasons: [] };
    }
    const commitMessage = `任务 ${taskId}: ${workerSummary.slice(0, 100)}`;
    await gitProcess.run(
      allocation.worktreePath,
      ["commit", "-m", commitMessage],
      `提交任务 ${taskId} 的 Worker 贡献`,
    );
    const headResult = await gitProcess.run(
      allocation.worktreePath,
      ["rev-parse", "HEAD"],
      `解析 worker 提交 head`,
    );
    const headCommit = headResult.stdoutText.trim();
    // 证据命令：在 worktree 实际执行，上报真实退出码
    const executedChecks = gitIntegration.integrationTestCommands.map(
      (command) => ({
        command,
        exitCode: this.runEvidenceCommand(allocation.worktreePath, command)
          ? 0
          : 1,
      }),
    );
    const submission = await gitIntegration.coordinator.submitContribution({
      missionId: this.options.missionId,
      taskId,
      repositoryPath: gitIntegration.repositoryPath,
      baseCommit: allocation.targetBaseCommit,
      headCommit,
      executedChecks,
    });
    const reviewSummary = `Git 审查 ${submission.reviewDecision}: ${taskId} @ ${headCommit.slice(0, 8)}${
      submission.rejectionReasons.length > 0
        ? `（${submission.rejectionReasons.join("；")}）`
        : ""
    }`;
    await this.options.workArchiveStore
      ?.appendEntry({
        missionId: this.options.missionId,
        agentInstanceId:
          this.options.secondaryAgentInstanceId ??
          `scheduler:${this.options.missionId}`,
        agentRole: "secondary",
        entry: {
          taskId,
          entryType: "decision",
          summary: reviewSummary,
          artifactReferences: [headCommit],
        },
      })
      .catch(() => null);
    return {
      isAccepted: submission.reviewDecision === "accepted",
      rejectionReasons: submission.rejectionReasons,
    };
  }

  /** 在指定目录以 shell 执行证据命令；返回是否成功。 */
  private runEvidenceCommand(workingDirectoryPath: string, command: string): boolean {
    const result = spawnSync(command, {
      cwd: workingDirectoryPath,
      shell: true,
      windowsHide: true,
      timeout: 300_000,
      encoding: "utf8",
    });
    return result.status === 0;
  }

  private async finishMission(status: "done" | "cancelled"): Promise<void> {
    // T05B：mission 完成且 Git 集成装配时，运行集成门禁并按门禁合入目标分支
    const gitIntegration = this.options.gitIntegration;
    if (
      status === "done" &&
      gitIntegration !== null &&
      gitIntegration !== undefined &&
      this.gitIntegrationSession !== null
    ) {
      try {
        await gitIntegration.coordinator.finalizeIntegration({
          missionId: this.options.missionId,
          integratingAgentInstanceId:
            this.gitIntegrationSession.integratingAgentInstanceId,
          repositoryPath: gitIntegration.repositoryPath,
          integrationTestCommands: gitIntegration.integrationTestCommands,
          isTargetBranchMergeAllowed: gitIntegration.isTargetBranchMergeAllowed(),
        });
      } catch (error) {
        this.options.onUserEscalation(
          `Git 集成收尾失败: ${(error as Error).message}`,
        );
      }
    }
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
