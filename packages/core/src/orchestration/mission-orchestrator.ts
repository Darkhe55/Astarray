/**
 * 任务编排运行循环（T08）。
 * 事件驱动：scheduleRound → 启动 Worker → Worker 结果唤醒循环 →
 * 处理结果（done/failed/ambiguous/permission-ask/cancelled）→ 再调度，
 * 直到 complete-mission 或取消。全程不阻塞主 Agent 输入循环。
 */
import { createHash, randomUUID } from "node:crypto";
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
import type { ToolDescriptor } from "../core/types.js";
import type { ContextPromptProvider } from "./context-prompt-assembler.js";
// COMM-01-02（2026-10-26）：发布任务时登记自己的信箱 ⇒ 反馈走发布者反向通道。
import { resolvePublisherRecipientIdForTask } from "./task-publisher-feedback-route.js";
import type { GuidanceControlQueue } from "../runtime-guidance/guidance-control-queue.js";

/**
 * 会改变本地状态的写类工具（与 `worker-agent.ts` 的 MUTATING_TOOL_NAMES 一致）：
 * 用于在权限询问被打断时登记"跨运行必需操作契约"。
 */
const MUTATING_TOOL_NAMES_FOR_RETRY = new Set([
  "createProjectFile",
  "replaceFileContent",
  "writeFileTemporary",
  "backupVault",
  "deleteBackup",
]);import type {
  GuidanceSafePointPort,
  ToolLoopDiagnosticFailure,
  ToolLoopPerfSample,
  ToolLoopProgressGuardPort,
} from "../runtime/tool-loop.js";
import type { GuidanceScopeTarget } from "../runtime-guidance/runtime-guidance.js";
import { LocalRigorPolicyEngine } from "../tools/local-rigor-policy-engine.js";
import type { ContextNodeLifecyclePort } from "./worker-agent.js";
import type { AgentWorkArchiveStore } from "./work-archive-store.js";
import { DomainError } from "../core/errors.js";
import type { MissionLeaseStore } from "../infra/mission-lease-store.js";
import { DagScheduler } from "./dag-scheduler.js";
import type { ScheduleAction } from "./dag-scheduler.js";
import { ToolFailureCounter } from "./failure-counter.js";
import { WorkerAgent } from "./worker-agent.js";
import type { WorkerAgentOptions } from "./worker-agent.js";
import type { WorkerOutcome } from "./worker-agent.js";
import type { GitIntegrationCoordinator } from "./git-integration-coordinator.js";
import { GitProcess } from "./git-process.js";

export interface OrchestratorWorkerFactories {
  runtimeFactory: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  toolPortFactory: (task: TaskDependencyNode, agentInstanceId?: string) => ToolPort;
  buildPermissionExplanation: (toolName: string) => string;
  /** T07D-R2-03：实际暴露给 Provider 的工具描述符（按任务工具子集）。 */
  toolDescriptorFactory?: (task: TaskDependencyNode) => ToolDescriptor[];
  /**
   * PERF-01-02 采集（2026-11-08，第 83 轮）：性能样本**落库端口**。
   *
   * ## 为什么是"端口 + 由编排层补身份"，而不是直接传一个 sink
   *
   * 工具循环给出的样本载荷**不含身份**（`tool-loop.ts` 的 `ToolLoopPerfSample`），
   * 而 `PerfSampleEvent` 的 `sourceAgentInstanceId` / `missionIdentifier` /
   * `taskIdentifier` 都是**必填**。身份只有**编排层**知道（它持有 `missionId`，
   * 且构造每个 worker 时知道 `agentInstanceId` 与 `task`）⇒ 由编排层补齐后再交给端口。
   *
   * **缺省 ⇒ 不采集**（沿用本仓"可选能力"口径；也让既有测试行为不变）。
   */
  perfSamplePort?: (sample: {
    sourceAgentInstanceId: string;
    missionIdentifier: string;
    taskIdentifier: string;
    operationKind: string;
    durationMilliseconds: number;
    outcome: "success" | "failure" | "cancelled" | "unknown";
  }) => Promise<void> | void;
  /**
   * DIAG-01 采集（2026-11-08，第 85 轮）：**诊断失败事件落库端口**。
   *
   * 与 `perfSamplePort` 同理：工具循环的载荷不含身份，而 `DiagnosticEvent` 的
   * `sourceAgentInstanceId` / `missionIdentifier` / `taskIdentifier` 必填
   * ⇒ 由编排层（它持有 `missionId`，且构造每个 worker 时知道 `agentInstanceId` 与 `task`）补齐。
   *
   * **只在真实执行失败时被调用**（拒绝/取消由工具循环过滤，卡内硬约束）。
   * **缺省 ⇒ 不采集。**
   */
  /** G2（第 130 轮）：守卫端口（缺省 ⇒ 不传 ⇒ 不启用）。 */
  progressGuardPort?: ToolLoopProgressGuardPort;
  /**
   * G3（2026-11-08，第 133 轮）：**高严谨性任务强制事实验证**开关。
   *
   * 打开后：被 `LocalRigorPolicyEngine` 本地规则判为 `high` 的任务，完成前**必须**
   * 成功调用过 `factVerification`（否则完成被拒、任务不结案）。**缺省关**。
   */
  isHighRigorEnforcementEnabled?: boolean;
  diagnosticEventPort?: (event: {
    sourceAgentInstanceId: string;
    missionIdentifier: string;
    taskIdentifier: string;
    errorCode: string;
    messageText: string;
    component: string;
    stage: "tool" | "provider";
    severity: "error";
  }) => Promise<void> | void;
}

/**
 * T05B → T08 接入：编排层 Git 集成配置。
 * 装配后，写入型任务（taskType 在 allowedPathsByTaskType 中）自动获得
 * 隔离 worker 分支/worktree；Worker 完成后提交由次级集成者审查，
 * 审查通过才合并；mission 完成时运行集成测试并按门禁合入目标分支。
 */
/**
 * DIAG-01（2026-11-08，第 113 轮）：**使命级诊断事件**。
 *
 * 抽成导出类型，供 `MissionOrchestratorOptions`、`MainControllerOptions` 与装配层**共用同一份定义**
 * —— 起因是第 113 轮接线时，编排器那处 `stage` 联合含 `"provider"` 而 `MainController` 新写的不含，
 * 类型不匹配被 `tsc` 拦下（**这正是"两处各写一份"的典型代价**）。
 */
export interface MissionDiagnosticEvent {
  /**
   * 所属使命；**会话级失败（如切换权限组）与使命无关 ⇒ 允许 `null`**
   * （第 115 轮放宽：`DiagnosticEventStore` 本就接受 `string | null`；**不编造身份**）。
   */
  missionIdentifier: string | null;
  /** 具体个体（不可复用）；使命级失败通常归给发起集成的次级个体。 */
  sourceAgentInstanceId: string;
  stage: "git" | "provider" | "recovery" | "dispatch" | "config" | "unknown";
  errorCode: string;
  messageText: string;
  component: string;
}

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
  /** T07D-R2-03：Provider 运行时是否强制要求本地完成控制事件。 */
  requireCompletionControlEvent?: boolean;
  /**
   * 产物对账的工作区根（2026-10-02）：必须与工具实际写入的工作区一致，
   * 缺省由装配方传入（通常 `options.workspaceRootPath ?? process.cwd()`）。
   */
  artifactWorkspaceRootPath?: string;
  /** T09A-R1-01：上下文提示词装配提供者。 */
  contextPromptProvider?: ContextPromptProvider;
  /** GUIDE-01-04：运行中指导控制队列（每个任务构造独立安全点端口）。 */
  guidanceControlQueue?: GuidanceControlQueue;
  /** T09A-R1-03：任务完成后的上下文节点收口。 */
  contextNodeLifecycle?: ContextNodeLifecyclePort | null;
  /** T09A-R1-03：当前模式（人工验收策略来源）。 */
  contextLifecycleModeKey?: string;
  feedbackTransportFactory: () => Promise<FeedbackTransportPort>;
  onMissionFinished: (status: "done" | "cancelled") => void | Promise<void>;
  /** 无法由调度层裁决、需要用户输入时回调（ambiguity / 裁决指令无法解析）。 */
  onUserEscalation: (message: string) => void;
  /**
   * DIAG-01（2026-11-08，第 105 轮）：**使命级诊断事件端口**（可选，缺省 ⇒ 不采集）。
   *
   * ## 为什么需要它
   *
   * `DiagnosticEvent.stage` 的联合类型里早有 `"git"`／`"recovery"`／`"dispatch"`／`"config"`，
   * 但**此前只有 `tool`／`provider` 两个 stage 有上报方**（工具循环那两处）。
   * 使命级的失败（例如 `ensureGitIntegrationSession()` 的 catch）**只升级成用户消息就吞掉了**
   * ⇒ 诊断存储永远学不到"这次使命的 Git 集成会话没起来"。
   *
   * ## 纪律
   *
   * - **只加观测，不改控制流**：上报失败只丢弃观测，**不得**影响既有升级/降级行为；
   * - **不取代既有提示**：原有 `onUserEscalation(...)` 照发（反例已断言）；
   * - **缺省不采集**：未提供端口时行为**逐字不变**。
   */
  missionDiagnosticEventPort?: (event: MissionDiagnosticEvent) => Promise<void> | void;
  /**
   * GUI-02-01 片①（2026-10-11）：**权限询问**的升级回调，**额外携带发起方绝对身份**。
   *
   * 为什么需要它：`PermissionAskRequestStore` 按
   * `agent-memory/<ownerAgentInstanceId>/permission-ask-requests/` 落盘 ⇒ 注册请求实体
   * **必须有 owner**。而 `onUserEscalation(message)` 只有文本，升级文本的正则也只捕获
   * `taskIdentifier`/`toolName`/`explanation`/`argumentsJson` ⇒ **身份在到达调用方前就已丢失**，
   * 调用方无法可靠构造 owner（worker 绝对 ID 形如
   * `worker:<missionId>:<taskId>:<instanceCounter>`，末段 counter 不在文本里）。
   *
   * 设计选择（**加法式，不动既有契约**）：
   * - 既有 `onUserEscalation` 及其全部调用点、以及三层转发
   *   （`mission-orchestrator` → `assist/devolve-scheduler` → `main-controller`）**完全不动**；
   * - 本回调**可选**：未提供时行为与之前**逐字一致**；
   * - **不改升级文本格式**（ADR-0011 的公开载荷形态保持不变）；
   * - 仅 `case "permission-ask"` 额外调用本回调（其余升级仍只走 `onUserEscalation`）。
   */
  onPermissionAskWithIdentity?: (input: {
    /** 该次权限询问所属任务的权威身份（不可复用个体 ID）。 */
    ownerAgentInstanceId: string;
    taskId: string;
    /** 与传给 `onUserEscalation` 的文本**逐字相同**（保持单一事实来源）。 */
    message: string;
  }) => void;
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
  /**
   * T12-02：跨进程 mission 活动租约（可选；未装配时行为与旧版一致）。
   * 装配后，运行会话持有排他租约（半周期续约），结束后释放；
   * 其他进程对同一 mission 的调度请求快速失败 mission-locked。
   */
  missionLeaseStore?: MissionLeaseStore | null;
  /** T12-02：本进程不可复用实例标识（装配租约时必填）。 */
  processInstanceId?: string;
}

export type WorkerOutcomeHandler = (
  taskId: string,
  outcome: WorkerOutcome,
) => void | Promise<void>;

export class MissionOrchestrator {
  private readonly dagScheduler: DagScheduler;
  private readonly failureCounters = new Map<string, ToolFailureCounter>();
  /**
   * 因权限询问被打断、且尚未成功的写类工具（按任务，2026-10-02 T07D-R2-04 修复）：
   * 重跑时作为**跨运行必需操作契约**传给 Worker 的完成门禁。
   */
  private readonly pendingMutatingToolNamesByTask = new Map<string, Set<string>>();
  private readonly inFlightTaskIds = new Set<string>();
  private readonly inFlightWorkerPromises = new Set<Promise<void>>();
  /**
   * 2026-11-08（RELIABILITY「`shutdown()` 返回即静默」修复，方向 C）：
   * 在途 worker **实例**的集合 —— 即 `inFlightWorkerPromises` 的**可控源头**。
   *
   * **为什么需要它**：`cancel()` 原来**只等待**这些 promise（2 秒上限）而不中止它们
   * ⇒ 在途 Provider 调用照常跑完，`handleWorkerOutcome → persistChain` 的落盘
   * 发生在 `shutdown()` 返回**之后**（确定性复现见
   * `docs/reports/SHUTDOWN_TIMING_REPRODUCTION_2026-10-12.md` §7）。
   * 拿不到 worker 实例就无法中止，故在此留存引用。
   *
   * `WorkerAgent.cancel()` 早已存在（abort 内部 `AbortController`，运行时收到的
   * `cancellationSignal` 即来自它）—— 本修复只补"**编排器去调用它**"这一环。
   */
  private readonly inFlightWorkers = new Set<WorkerAgent>();
  /** T05B：任务 → worker 分配记录（写入型任务）。 */
  private readonly gitAllocations = new Map<string, GitWorkerAllocation>();
  private gitIntegrationSession: GitIntegrationReport | null = null;
  private gitIntegrationSessionStarted = false;
  private stopping = false;
  private wakeResolve: (() => void) | null = null;
  private runPromise: Promise<void> | null = null;
  /** T12-02：租约会话状态。 */
  private readonly missionLeaseStore: MissionLeaseStore | null;
  private readonly leaseProcessInstanceId: string;
  private acquiredLeaseRevision: number | null = null;

  constructor(private readonly options: MissionOrchestratorOptions) {
    this.missionLeaseStore = options.missionLeaseStore ?? null;
    this.leaseProcessInstanceId =
      options.processInstanceId ?? `process-${randomUUID()}`;
    this.dagScheduler = new DagScheduler(options.initialChain, {
      concurrency: options.concurrency,
      taskStore: options.taskStore,
      allocateAgentId: (taskId: string) => `worker:${this.options.missionId}:${taskId}`,
    });
  }

  start(): Promise<void> {
    if (this.runPromise === null) {
      this.runPromise = this.runWithLeaseSession();
    }
    return this.runPromise;
  }

  /**
   * T12-02：租约会话边界。装配租约时先申请排他租约（冲突即 mission-locked），
   * 运行期间按半周期续约，运行结束后（done/cancelled/异常）在 finally 释放。
   * 未装配租约时行为与旧版完全一致。
   */
  private async runWithLeaseSession(): Promise<void> {
    // 未装配租约时保持旧版同步启动时序（不做多余微任务让步）。
    if (this.missionLeaseStore !== null) {
      await this.acquireLeaseOrThrow();
    }
    let renewTimer: NodeJS.Timeout | null = null;
    if (this.missionLeaseStore !== null) {
      const renewIntervalMilliseconds = Math.max(
        1_000,
        Math.floor(this.missionLeaseStore.leaseTtlMilliseconds / 2),
      );
      renewTimer = setInterval(() => {
        void this.renewLeaseTick();
      }, renewIntervalMilliseconds);
    }
    try {
      await this.runLoop();
    } finally {
      if (renewTimer !== null) {
        clearInterval(renewTimer);
      }
      await this.releaseLeaseIfAcquired().catch(() => {});
    }
  }

  private async acquireLeaseOrThrow(): Promise<void> {
    const leaseStore = this.missionLeaseStore;
    if (leaseStore === null) {
      return;
    }
    const outcome = await leaseStore.tryAcquire({
      missionId: this.options.missionId,
      processInstanceId: this.leaseProcessInstanceId,
      purpose: "run",
      agentInstanceId: this.options.secondaryAgentInstanceId,
      claimantDescription: "mission-orchestrator-run-session",
    });
    if (outcome.status !== "acquired") {
      throw new DomainError(
        "mission-locked",
        `mission 存在其他进程的${outcome.status === "locked-stale" ? "过期待接管" : "活动"}租约（属主 ${outcome.lease.processInstanceId}）: ${this.options.missionId}`,
      );
    }
    this.acquiredLeaseRevision = outcome.lease.leaseRevision;
  }

  /** 半周期续约；续约失败/租约消失即停止调度并上报（不静默继续执行）。 */
  private async renewLeaseTick(): Promise<void> {
    const leaseStore = this.missionLeaseStore;
    const currentRevision = this.acquiredLeaseRevision;
    if (leaseStore === null || currentRevision === null) {
      return;
    }
    try {
      const renewed = await leaseStore.renewLease(
        this.options.missionId,
        currentRevision,
        this.leaseProcessInstanceId,
      );
      if (renewed === null) {
        this.stopDueToLostLease(
          `mission 租约已消失（被释放或接管），停止调度以保护一致性: ${this.options.missionId}`,
        );
        return;
      }
      this.acquiredLeaseRevision = renewed.leaseRevision;
    } catch (error) {
      this.stopDueToLostLease(
        `mission 租约续约失败（${(error as Error).message}），停止调度以保护一致性: ${this.options.missionId}`,
      );
      /**
       * DIAG-01（2026-11-08，第 113 轮）：**这条是生产可达的使命级失败路径**
       * （工作循环里会 `await this.renewLeaseTick()`，不必等定时器）——
       * 原本这里只停止调度并升级消息，诊断里同样学不到发生了什么 ⇒ 现按 `stage: "recovery"` 上报。
       */
      await this.reportMissionDiagnosticEvent({
        stage: "recovery",
        errorCode: error instanceof DomainError ? error.errorCode : null,
        fallbackErrorCode: "mission-lease-renewal-failed",
        component: "mission-lease",
        error,
      });
    }
  }

  private stopDueToLostLease(message: string): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.options.onUserEscalation(message);
  }

  private async releaseLeaseIfAcquired(): Promise<void> {
    const leaseStore = this.missionLeaseStore;
    const currentRevision = this.acquiredLeaseRevision;
    if (leaseStore === null || currentRevision === null) {
      return;
    }
    await leaseStore.releaseLease(
      this.options.missionId,
      currentRevision,
      this.leaseProcessInstanceId,
    );
    this.acquiredLeaseRevision = null;
  }

  /**
   * 取消：停止调度循环，等待在途 Worker 与循环收敛后返回。
   * 无在途 Worker 时确定性等待循环结束（保证无后台持久化写操作遗留）；
   * 存在挂起 Worker 时以 2 秒为上限（真实工具可能不可中断）。
   *
   * ⚠️ **已知风险（2026-10-12 实测，见 docs/reports/NON_TEST_LEVEL_FAILURE_ROOT_CAUSE_2026-10-12.md）**：
   * 上述 **2 秒上限意味着"本方法返回"≠"在途任务已停止写盘"**。
   * 若某个在途 Worker 超过 2 秒才走到 `handleWorkerOutcome` → `DagScheduler.finishTask`
   * → `persistChain`，则**本方法（及其上层 `shutdown()`）已返回**，
   * 而落盘**随后**才发生 ⇒ 若宿主此时已退出或已清理状态目录，
   * 会产生**无人接管的 `ENOENT`**（实测：全量测试约 30% 出现 `Errors 1 error`，退出码 1）。
   *
   * **修改此处前请先读该报告**：修复方向有两处取舍（真等待 vs 写入侧对目录消失 fail-soft），
   * 且**均需先取得确定性复现**，否则无法验证 —— 本会话曾把上限临时改为 30 秒，
   * 但**反例无法区分**（mock 任务毫秒级完成，窗口不出现），故**已回退**，不留未验证的改动。
   *
   * **✅ 2026-11-08 更新：确定性复现已取得**（见同一报告 §7）—— 用**受控慢 Provider**
   * （延迟 5 秒响应）**无需并发负载**即可在隔离环境下稳定复现：
   * `shutdown()` 返回后链文件**仍被改写**。关键前置条件是
   * **假 Provider 必须真的收到过请求**（只等"链文件落盘"或只看时间窗口会得到
   * **空洞的绿** —— 实测那时 worker 尚未派发，`inFlightWorkerPromises` 为空，
   * Provider 从未被调用）。
   *
   * **注意本方法只等待、不中止**（且本文件**没有任何** `AbortController`）⇒
   * 在途 Provider 调用不会被取消，超时后照常返回并落盘。
   * 报告 §7.5 列出三个方向（A 真等待／B 写入侧 fail-soft／C 中止在途 worker）；
   * **A 与 C 涉及产品可见的关停延迟与语义取舍，需用户/设计裁决** ——
   * 在裁决前**不要**单方面改这里。
   */
  async cancel(): Promise<void> {
    this.stopping = true;
    this.wake();
    /**
     * 2026-11-08 修复（**方向 C：中止在途 worker**，非"只等待"）：
     *
     * 原来这里**只等**在途 worker（2 秒上限）却**不中止**它们 ⇒ 在途 Provider
     * 调用照常跑完，`handleWorkerOutcome → persistChain` 的落盘发生在
     * `shutdown()` 返回**之后**；宿主若已清理状态目录则产生无人接管的 `ENOENT`
     * （确定性复现：`docs/reports/SHUTDOWN_TIMING_REPRODUCTION_2026-10-12.md` §7）。
     *
     * 中止是**必要且充分**的那一步：`WorkerAgent.cancel()` 会 abort 它自己的
     * `AbortController`，运行时据此**立即**结束在途请求 ⇒ worker 的收尾
     * （含链落盘）落在**本次 `cancel()` 返回之前** ⇒ 上层 `shutdown()` 返回即静默。
     *
     * **不新增语义**：被中止的 worker 走的是**既有**的运行时异常收敛路径
     * （`handleWorkerOutcome` 记失败），不产生"成功"产物。
     * 保留下面的有界等待作为**兜底**（万一某个 worker 不响应中止，仍不至于永久挂住）。
     */
    for (const inFlightWorker of [...this.inFlightWorkers]) {
      inFlightWorker.cancel();
    }
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
      if (this.missionLeaseStore !== null) {
        await this.renewLeaseTick();
        if (this.stopping) {
          await this.finishMission("cancelled");
          return;
        }
      }
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
      await this.reportMissionDiagnosticEvent({
        stage: "git",
        errorCode:
          error instanceof DomainError ? error.errorCode : "git-session-start-failed",
        fallbackErrorCode: "git-session-start-failed",
        component: "git-integration-coordinator",
        error,
      });
    }
  }

  /**
   * DIAG-01（2026-11-08，第 105／113 轮）：**使命级失败上报**的统一入口。
   *
   * ## 纪律（三处 catch 共用，避免各写一份而漂移）
   *
   * - **只加观测**：上报**不取代**既有的用户升级消息，也不改控制流；
   * - **观测失败只丢弃**：`catch` 吞掉（与既有 sink 纪律一致），绝不让观测拖垮业务；
   * - **缺省不采集**：端口未提供时**什么都不做**（行为逐字不变）。
   */
  private async reportMissionDiagnosticEvent(input: {
    stage: "git" | "recovery" | "dispatch" | "config" | "unknown";
    errorCode: string | null;
    fallbackErrorCode: string;
    component: string;
    error: unknown;
  }): Promise<void> {
    const diagnosticEventPort = this.options.missionDiagnosticEventPort;
    if (diagnosticEventPort === undefined) {
      return;
    }
    try {
      await diagnosticEventPort({
        missionIdentifier: this.options.missionId,
        sourceAgentInstanceId:
          this.options.secondaryAgentInstanceId ?? `scheduler:${this.options.missionId}`,
        stage: input.stage,
        errorCode: input.errorCode ?? input.fallbackErrorCode,
        messageText: (input.error as Error).message,
        component: input.component,
      });
    } catch {
      // 观测失败不得阻塞业务（与既有 sink 纪律一致）
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
    let workerToolPort = this.options.workerFactories.toolPortFactory(task, agentInstanceId);
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
    /**
     * 注意：**发布者登记在 `buildWorkerAgent` 内部完成**（不变量放在那里，
     * 任何经该方法构造的 Worker 都带发布者信箱，调用点无法漏掉）。
     */
    const worker = this.buildWorkerAgent({
      agentInstanceId,
      missionId,
      task,
      availableToolDescriptors:
        this.options.workerFactories.toolDescriptorFactory?.(task) ?? [],
      requireCompletionEvent: this.options.requireCompletionControlEvent ?? false,
      ...(this.options.artifactWorkspaceRootPath === undefined
        ? {}
        : { artifactWorkspaceRootPath: this.options.artifactWorkspaceRootPath }),
      contextPromptProvider: this.options.contextPromptProvider,
      guidanceSafePointPort:
        this.options.guidanceControlQueue === undefined
          ? undefined
          : buildWorkerGuidanceSafePointPort({
              queue: this.options.guidanceControlQueue,
              target: {
                missionIdentifier: missionId,
                taskIdentifier: task.id,
                resourceIdentifier: null,
              },
            }),
      contextNodeLifecycle: this.options.contextNodeLifecycle ?? null,
      contextLifecycleModeKey: this.options.contextLifecycleModeKey,
      runtime: this.options.workerFactories.runtimeFactory(agentInstanceId, task),
      toolPort: workerToolPort,
      failureCounter: this.getFailureCounter(agentInstanceId, task.id),
      feedbackTransport: await this.options.feedbackTransportFactory(),
      maxLoopIterations: this.options.maxLoopIterations,
      buildPermissionExplanation:
        this.options.workerFactories.buildPermissionExplanation,
      workArchiveStore,
      archiveAttachments,
      ...(this.pendingMutatingToolNamesByTask.get(task.id) === undefined
        ? {}
        : {
            requiredMutatingToolNames: [
              ...(this.pendingMutatingToolNamesByTask.get(task.id) ?? []),
            ],
          }),
      /**
       * G3（2026-11-08，第 133 轮）：**高严谨性 ⇒ 完成前必须成功调用 `factVerification`**。
       *
       * 对象字面量**后者胜** ⇒ 本条覆盖上面的 `requiredMutatingToolNames`；
       * 即"标记"（本地规则）与"强制"（必须调用）都在本地完成，不经模型判断。
       * 开关缺省关 ⇒ 该 spread 为空对象 ⇒ 行为逐字不变。
       */
      ...(this.options.workerFactories.isHighRigorEnforcementEnabled === true &&
      new LocalRigorPolicyEngine().classifyRigor(task.description).rigorLevel === "high"
        ? {
            requiredMutatingToolNames: [
              ...(this.pendingMutatingToolNamesByTask.get(task.id) ?? []),
              "factVerification",
            ],
          }
        : {}),
      /**
       * PERF-01-02 采集（2026-11-08，第 83 轮）：把工具循环的样本**补齐身份**后
       * 交给落库端口。端口缺省 ⇒ 不传 sink ⇒ 不采集。
       */
      ...(this.options.workerFactories.perfSamplePort === undefined
        ? {}
        : {
            perfSampleSink: (sample: ToolLoopPerfSample) =>
              this.options.workerFactories.perfSamplePort!({
                sourceAgentInstanceId: agentInstanceId,
                missionIdentifier: missionId,
                taskIdentifier: task.id,
                operationKind: sample.operationKind,
                durationMilliseconds: sample.durationMilliseconds,
                outcome: sample.outcome,
              }),
          }),
      /**
       * DIAG-01 采集（2026-11-08，第 85 轮）：把工具循环上报的**真实执行失败**
       * 补齐身份后交给落库端口。端口缺省 ⇒ 不传 sink ⇒ 不采集。
       * （拒绝/取消已在工具循环侧过滤，此处不再判断。）
       */
      ...(this.options.workerFactories.diagnosticEventPort === undefined
        ? {}
        : {
            diagnosticEventSink: (failure: ToolLoopDiagnosticFailure) =>
              this.options.workerFactories.diagnosticEventPort!({
                sourceAgentInstanceId: agentInstanceId,
                missionIdentifier: missionId,
                taskIdentifier: task.id,
                errorCode: failure.errorCode,
                messageText: failure.messageText,
                /**
                 * 组件标识按**阶段**给（第 86 轮）：工具失败＝`tool:<工具名>`；
                 * Provider 失败没有工具名 ⇒ `provider-runtime`。
                 * 这样同一错误码在不同组件下**指纹不同**（卡内：相同文本不保证同因）。
                 */
                component:
                  failure.toolName === null
                    ? "provider-runtime"
                    : "tool:" + failure.toolName,
                stage: failure.stage,
                severity: "error",
              }),
          }),
    /** G2（第 130 轮）：守卫端口透传。缺省 ⇒ 不传 ⇒ 不启用。 */
    ...(this.options.workerFactories.progressGuardPort === undefined
      ? {}
      : { progressGuardPort: this.options.workerFactories.progressGuardPort }),
    });
    const workerPromise = (async () => {
      try {
        const outcome = await worker.run();
        this.inFlightTaskIds.delete(action.taskId);
        await this.handleWorkerOutcome(action.taskId, outcome, agentInstanceId);
      } catch (error) {
        // 运行时/工具异常必须收敛为任务失败，不得变成未处理拒绝（T07D-R2-02）。
        this.inFlightTaskIds.delete(action.taskId);
        await this.handleWorkerOutcome(action.taskId, {
          outcome: "failure",
          toolName: null,
          failureReason:
            error instanceof Error ? error.message : "运行时异常",
          stateSummary: "运行时异常终止",
        }, agentInstanceId);
      }
    })();
    this.inFlightWorkerPromises.add(workerPromise);
    this.inFlightWorkers.add(worker);
    void workerPromise.finally(() => {
      this.inFlightWorkerPromises.delete(workerPromise);
      this.inFlightWorkers.delete(worker);
      this.wake();
    });
  }

  /**
   * 构造执行任务的 Worker（COMM-01-02，2026-10-27）。
   *
   * **为什么抽成一个可覆写方法**：此前这里是内联的 `new WorkerAgent({...})`，
   * `workerFactories` **不提供** worker 注入口，且全仓没有构造 `MissionOrchestrator`
   * 的测试 ⇒ "编排器发布任务时**确实把发布者信箱登记到任务上**"这件事
   * **无法被端到端断言**（只能靠类型检查 + 纯函数测试）。抽成方法后，
   * 集成测试可覆写它以**捕获真实编排路径产出的 Worker 配置**并逐项断言。
   *
   * **发布者登记放在本方法内部**（而不是调用点）：这样"本编排器即发布者"
   * 这条不变量**无法被绕过** —— 任何经本方法构造的 Worker 都带着发布者信箱；
   * 若放在调用点，覆写本方法或新增调用点都会悄悄丢掉它
   * （实测：放在调用点时，直接调用本方法产出的任务**没有**发布者字段）。
   *
   * 覆写者必须返回一个可 `run()` 的 Worker（见 `WorkerAgentOptions`）。
   */
  protected buildWorkerAgent(options: WorkerAgentOptions): WorkerAgent {
    return new WorkerAgent({
      ...options,
      task: {
        ...options.task,
        publishedByRecipientId: resolvePublisherRecipientIdForTask({
          task: options.task,
          publisherRecipientId: `scheduler:${options.missionId}`,
        }),
      },
    });
  }

  /**
   * 工具连续失败计数器（T05，默认阈值 3，任意一次成功后清零）。
   *
   * 键必须是**具体 Agent 实例 + 任务**，不能只用 `taskId`（2026-10-02 真实实测缺陷）：
   * 两个并行 mission 各自都有一条 `T-001`，若共用同一计数器，A 的失败会累加到 B 头上、
   * 反之亦然，导致"并发第二条任务 readFile 连续失败达到阈值"的误判（u2-flash 实测稳定复现）。
   */
  private getFailureCounter(agentInstanceId: string, taskId: string): ToolFailureCounter {
    const counterKey = agentInstanceId + "|" + taskId;
    let counter = this.failureCounters.get(counterKey);
    if (counter === undefined) {
      counter = new ToolFailureCounter(this.options.failureThreshold);
      this.failureCounters.set(counterKey, counter);
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
    /**
     * GUI-02-01 片①：该任务的**权威个体身份**（与 `new WorkerAgent({ agentInstanceId })`
     * 同源，在同一作用域内取得）—— 权限询问的身份传递依赖它。
     */
    ownerAgentInstanceId: string,
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
          // 跨运行必需操作契约已满足：清除记录，避免后续运行被旧契约挡住。
          this.pendingMutatingToolNamesByTask.delete(taskId);
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
        /**
         * 记录"被打断的写类工具"（2026-10-02，T07D-R2-04 正向闭环修复）：
         * 用户批准后 `unblock` 会重跑该任务，但重跑对模型而言是一次全新任务，
         * 可能**根本不请求该工具**就直接宣称完成。把工具名留在调度侧，
         * 由完成门禁按**跨运行契约**要求它真正成功，否则不得结案。
         */
        if (outcome.toolName !== null && MUTATING_TOOL_NAMES_FOR_RETRY.has(outcome.toolName)) {
          const pending = this.pendingMutatingToolNamesByTask.get(taskId) ?? new Set<string>();
          pending.add(outcome.toolName);
          this.pendingMutatingToolNamesByTask.set(taskId, pending);
        }
        await this.dagScheduler.blockTaskForHumanDecision(taskId);
        {
          const permissionAskMessage =
            `任务 ${taskId} 需要权限调用 ${outcome.toolName}（${outcome.explanation}），参数: ${outcome.argumentsJson}`;
          // 既有回调**照旧**（未提供新回调时行为逐字不变）。
          this.options.onUserEscalation(permissionAskMessage);
          /**
           * GUI-02-01 片①：权限询问**额外**上报发起方绝对身份，供调用方注册请求实体
           * （`PermissionAskRequestStore` 按 owner 分目录，必须有 owner）。
           * 可选回调：未提供时此处不产生任何行为差异。
           */
          this.options.onPermissionAskWithIdentity?.({
            ownerAgentInstanceId,
            taskId,
            message: permissionAskMessage,
          });
        }
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

/**
 * GUIDE-01-04：把控制队列绑定到具体任务，构造 worker 的安全点端口。
 * 安全点消费发生在模型调用前与工具执行前，busy 期间即可应用。
 */
export function buildWorkerGuidanceSafePointPort(input: {
  queue: GuidanceControlQueue;
  target: GuidanceScopeTarget;
  nowIso?: () => string;
}): GuidanceSafePointPort {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  return {
    consumeAtSafePoint: async ({ safePointKind }) =>
      input.queue.consumeAtSafePoint({
        safePointKind,
        target: input.target,
        nowIso: nowIso(),
      }).applied,
  };
}
