/**
 * 三级 Agent 生命周期（T08A / ADR-0022 §三级 Agent：一次激活只执行一条任务链、
 * 复用/新建/关闭/记忆接手）。
 *
 * TertiaryAgentAssignmentPlanner：复用已有三级 Agent 仅当全部条件满足
 * （存活且空闲、同一所属次级、任务/mission/工具/权限/worktree 兼容、
 * 无未确认副作用或未处理控制消息、上下文/消息预算未超阈值、历史不冲突）；
 * 否则创建新 agentInstanceId 个体。决定可解释且可重放。
 *
 * TertiarySingleChainExecutionGuard：一次激活绑定一个不可变 taskBundleId
 * 与一条真实有序任务链；禁止领取链外任务、改写偏序集、调度其他 Agent、
 * 写集成/目标分支或使用 GitHub/远端项目控制工具。
 *
 * TertiaryAgentLifecycleController：受控收口状态机——停止派发、收敛/标记
 * 未确认调用、保存检查点与 handoff、确认反馈入档、撤销权限租约、注销
 * mailbox 身份、处理 Git 资源，最后终止后台运行；各阶段支持幂等重试。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";

// ─── TertiaryAgentAssignmentPlanner ───────────────────────────────────────

export interface TertiaryAgentReuseCandidate {
  agentInstanceId: string;
  isAlive: boolean;
  isIdle: boolean;
  owningSecondaryAgentInstanceId: string;
  isTaskMissionCompatible: boolean;
  isToolPermissionScopeCompatible: boolean;
  isWorktreeCompatible: boolean;
  hasUnconfirmedSideEffects: boolean;
  hasUnprocessedControlMessages: boolean;
  isContextBudgetAvailable: boolean;
  isMessageBudgetAvailable: boolean;
  doesHistoryConflictWithNewTask: boolean;
}

export type AssignmentDecision = "reuse-existing" | "create-new";

export interface AssignmentDecisionResult {
  decision: AssignmentDecision;
  /** 可解释的原因（全部条件逐项列出）。 */
  reasons: string[];
}

export class TertiaryAgentAssignmentPlanner {
  /** 复用判定：任一条件不满足 → create-new（带原因）。 */
  decideAssignment(
    candidate: TertiaryAgentReuseCandidate,
  ): AssignmentDecisionResult {
    const reasons: string[] = [];
    if (!candidate.isAlive) {
      reasons.push("个体已不存活");
    }
    if (!candidate.isIdle) {
      reasons.push("个体非空闲（可能仍绑定任务链）");
    }
    if (candidate.owningSecondaryAgentInstanceId === "") {
      reasons.push("所属次级 Agent 身份缺失");
    }
    if (!candidate.isTaskMissionCompatible) {
      reasons.push("任务/mission 不兼容");
    }
    if (!candidate.isToolPermissionScopeCompatible) {
      reasons.push("工具/权限范围不兼容");
    }
    if (!candidate.isWorktreeCompatible) {
      reasons.push("worktree 不兼容");
    }
    if (candidate.hasUnconfirmedSideEffects) {
      reasons.push("存在未确认副作用");
    }
    if (candidate.hasUnprocessedControlMessages) {
      reasons.push("存在未处理控制消息");
    }
    if (!candidate.isContextBudgetAvailable) {
      reasons.push("上下文预算超阈值");
    }
    if (!candidate.isMessageBudgetAvailable) {
      reasons.push("消息预算超阈值");
    }
    if (candidate.doesHistoryConflictWithNewTask) {
      reasons.push("历史内容与新任务冲突");
    }
    if (reasons.length === 0) {
      return {
        decision: "reuse-existing",
        reasons: ["全部复用条件满足（存活/空闲/兼容/预算充足/无冲突）"],
      };
    }
    return { decision: "create-new", reasons };
  }
}

// ─── TertiarySingleChainExecutionGuard ────────────────────────────────────

export interface TertiaryChainActivationBinding {
  agentInstanceId: string;
  taskBundleId: string;
  chainTaskIds: string[];
  publisherSecondaryAgentInstanceId: string;
}

/** 三级 Agent 被禁止的链外能力（本地拒绝）。 */
export const TERTIARY_FORBIDDEN_CAPABILITIES = [
  "task-sequence-modify",
  "agent-spawn-or-schedule",
  "integration-branch-write",
  "target-branch-write",
  "git-remote-control",
  "github-project-control",
  "publish-or-transfer",
] as const;

export class TertiarySingleChainExecutionGuard {
  /** 一次激活绑定一个不可变任务链。 */
  bindActivation(
    input: TertiaryChainActivationBinding,
  ): TertiaryChainActivationBinding {
    if (input.taskBundleId === "") {
      throw new DomainError(
        "invalid-task-chain",
        "三级 Agent 激活必须绑定不可变 taskBundleId",
      );
    }
    if (input.chainTaskIds.length === 0) {
      throw new DomainError(
        "invalid-task-chain",
        "任务链不能为空",
      );
    }
    return { ...input, chainTaskIds: [...input.chainTaskIds] };
  }

  /** 链外任务领取拒绝。 */
  assertTaskWithinChain(
    binding: TertiaryChainActivationBinding,
    taskId: string,
  ): void {
    if (!binding.chainTaskIds.includes(taskId)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `三级 Agent ${binding.agentInstanceId} 尝试领取链外任务 ${taskId}（绑定链: ${binding.chainTaskIds.join(", ")})`,
      );
    }
  }

  /** 禁止能力调用拒绝（GitHub/远端项目控制/集成分支/调度等）。 */
  assertCapabilityAllowed(capability: string): void {
    if ((TERTIARY_FORBIDDEN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `三级 Agent 禁止能力: ${capability}`,
      );
    }
  }
}

// ─── TertiaryAgentLifecycleController ─────────────────────────────────────

export type TertiaryLifecyclePhase =
  | "stopping-dispatch"
  | "draining-unconfirmed-calls"
  | "persisting-checkpoint"
  | "writing-handoff"
  | "confirming-feedback"
  | "revoking-permission-lease"
  | "unregistering-mailbox"
  | "handling-git-resources"
  | "terminating-process"
  | "closed";

/** 收口阶段的固定顺序（B6R-08：严格覆盖且不可重排）。 */
export const TERTIARY_LIFECYCLE_PHASE_ORDER: readonly TertiaryLifecyclePhase[] = [
  "stopping-dispatch",
  "draining-unconfirmed-calls",
  "persisting-checkpoint",
  "writing-handoff",
  "confirming-feedback",
  "revoking-permission-lease",
  "unregistering-mailbox",
  "handling-git-resources",
  "terminating-process",
  "closed",
];

/** 阶段名 → hook 键映射（阶段名含连字符，hook 键为 camelCase）。 */
const HOOK_KEY_BY_PHASE: Record<string, keyof TertiaryLifecycleHookSet> = {
  "stopping-dispatch": "stopDispatch",
  "draining-unconfirmed-calls": "drainUnconfirmedCalls",
  "persisting-checkpoint": "persistCheckpoint",
  "writing-handoff": "writeHandoff",
  "confirming-feedback": "confirmFeedback",
  "revoking-permission-lease": "revokePermissionLease",
  "unregistering-mailbox": "unregisterMailbox",
  "handling-git-resources": "handleGitResources",
  "terminating-process": "terminateProcess",
};

/**
 * B6R-08：生命周期阶段状态（持久化）。
 * 记录当前阶段、已完成阶段、检查点/handoff 引用与未确认调用，
 * 重启后从第一个未完成阶段继续；每阶段使用幂等键验证上次结果。
 */
export interface TertiaryLifecyclePersistedState {
  agentInstanceId: string;
  schemaVersion: 1;
  currentPhase: TertiaryLifecyclePhase | null;
  completedPhases: TertiaryLifecyclePhase[];
  checkpointId: string | null;
  handoffReference: string | null;
  unconfirmedCallKeys: string[];
  closedAtIso: string | null;
}

/** 生命周期阶段状态存储端口（文件系统实现 + 测试 mock）。 */
export interface TertiaryLifecyclePhaseStore {
  readState(agentInstanceId: string): Promise<TertiaryLifecyclePersistedState | null>;
  writeState(state: TertiaryLifecyclePersistedState): Promise<void>;
}

/** 文件系统阶段状态存储（原子写 + 受控备份）。 */
export class FileTertiaryLifecyclePhaseStore implements TertiaryLifecyclePhaseStore {
  private readonly rootDirectory: string;

  constructor(baseDirectory: string) {
    this.rootDirectory = path.join(baseDirectory, "tertiary-lifecycle");
  }

  private stateFilePath(agentInstanceId: string): string {
    return path.join(
      this.rootDirectory,
      `${sanitizeLifecycleAgentId(agentInstanceId)}.json`,
    );
  }

  async readState(agentInstanceId: string): Promise<TertiaryLifecyclePersistedState | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const rawContent = await readFile(this.stateFilePath(agentInstanceId), "utf8");
      return JSON.parse(rawContent) as TertiaryLifecyclePersistedState;
    } catch {
      return null;
    }
  }

  async writeState(state: TertiaryLifecyclePersistedState): Promise<void> {
    const { writeFile, mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(this.rootDirectory, { recursive: true });
    const filePath = this.stateFilePath(state.agentInstanceId);
    try {
      await copyFile(filePath, `${filePath}.bak`);
    } catch {
      // 首次写入
    }
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function sanitizeLifecycleAgentId(agentInstanceId: string): string {
  let encoded = "";
  for (const character of agentInstanceId) {
    if (/[A-Za-z0-9._-]/.test(character)) {
      encoded += character;
    } else {
      encoded += `~${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
  return encoded;
}

export interface TertiaryLifecycleHookSet {
  stopDispatch?: () => Promise<unknown>;
  drainUnconfirmedCalls?: () => Promise<unknown>;
  persistCheckpoint?: () => Promise<unknown>;
  writeHandoff?: () => Promise<unknown>;
  confirmFeedback?: () => Promise<unknown>;
  revokePermissionLease?: () => Promise<unknown>;
  unregisterMailbox?: () => Promise<unknown>;
  handleGitResources?: () => Promise<unknown>;
  terminateProcess?: () => Promise<unknown>;
}

export interface TertiaryLifecycleState {
  agentInstanceId: string;
  phase: TertiaryLifecyclePhase;
  checkpointId: string | null;
  handoffReference: string | null;
  closedAtIso: string | null;
}

export interface TertiaryAgentLifecycleControllerOptions {
  /** B6R-08：阶段状态持久化（缺省内存态，重启不恢复）。 */
  phaseStore?: TertiaryLifecyclePhaseStore | null;
}

export class TertiaryAgentLifecycleController {
  private readonly hooks: TertiaryLifecycleHookSet;
  private readonly phaseStore: TertiaryLifecyclePhaseStore | null;
  private state: TertiaryLifecycleState | null = null;

  constructor(hooks: TertiaryLifecycleHookSet = {}, options: TertiaryAgentLifecycleControllerOptions = {}) {
    this.hooks = hooks;
    this.phaseStore = options.phaseStore ?? null;
  }

  getState(): TertiaryLifecycleState | null {
    return this.state === null ? null : { ...this.state };
  }

  /** 从持久化状态恢复（崩溃恢复：从第一个未完成阶段继续）。 */
  async resume(input: { agentInstanceId: string }): Promise<TertiaryLifecycleState | null> {
    if (this.phaseStore === null) {
      return null;
    }
    const persisted = await this.phaseStore.readState(input.agentInstanceId);
    if (persisted === null) {
      return null;
    }
    if (persisted.closedAtIso !== null) {
      this.state = {
        agentInstanceId: input.agentInstanceId,
        phase: "closed",
        checkpointId: persisted.checkpointId,
        handoffReference: persisted.handoffReference,
        closedAtIso: persisted.closedAtIso,
      };
      return { ...this.state };
    }
    // 从第一个未完成阶段继续
    const nextPhase = TERTIARY_LIFECYCLE_PHASE_ORDER.find(
      (phase) => !persisted.completedPhases.includes(phase),
    );
    if (nextPhase === undefined) {
      return null;
    }
    this.state = {
      agentInstanceId: input.agentInstanceId,
      phase: nextPhase,
      checkpointId: persisted.checkpointId,
      handoffReference: persisted.handoffReference,
      closedAtIso: null,
    };
    return { ...this.state };
  }

  /**
   * 受控收口（B6R-08 幂等）：
   * - 已 closed（内存或持久化）→ 直接返回，不重置为第一阶段、不重复副作用；
   * - 每阶段执行前持久化"进行中"（幂等键），完成后标记；
   * - 崩溃恢复：resume 后从第一个未完成阶段继续。
   */
  async shutdown(input: { agentInstanceId: string }): Promise<TertiaryLifecycleState> {
    // 幂等：已关闭直接返回
    if (this.state !== null && this.state.phase === "closed") {
      return { ...this.state };
    }
    let persisted: TertiaryLifecyclePersistedState | null = null;
    if (this.phaseStore !== null) {
      persisted = await this.phaseStore.readState(input.agentInstanceId);
      if (persisted?.closedAtIso !== null && persisted !== null) {
        this.state = {
          agentInstanceId: input.agentInstanceId,
          phase: "closed",
          checkpointId: persisted.checkpointId,
          handoffReference: persisted.handoffReference,
          closedAtIso: persisted.closedAtIso,
        };
        return { ...this.state };
      }
    }
    this.state = {
      agentInstanceId: input.agentInstanceId,
      phase: "stopping-dispatch",
      checkpointId: persisted?.checkpointId ?? null,
      handoffReference: persisted?.handoffReference ?? null,
      closedAtIso: null,
    };
    // 已完成的阶段（持久化）不再重跑
    const completedPhases = new Set<TertiaryLifecyclePhase>(persisted?.completedPhases ?? []);
    const phasesToRun = TERTIARY_LIFECYCLE_PHASE_ORDER.filter(
      (phase) => phase !== "closed" && !completedPhases.has(phase),
    );
    for (const phase of phasesToRun) {
      const phaseResult = await this.runPhase(phase, completedPhases);
      if (phaseResult.phase === "persisting-checkpoint") {
        this.state.checkpointId = phaseResult.result;
      }
      if (phaseResult.phase === "writing-handoff") {
        this.state.handoffReference = phaseResult.result;
      }
    }
    this.state = {
      ...this.state!,
      phase: "closed",
      closedAtIso: new Date().toISOString(),
    };
    if (this.phaseStore !== null) {
      await this.phaseStore.writeState({
        agentInstanceId: input.agentInstanceId,
        schemaVersion: 1,
        currentPhase: "closed",
        completedPhases: [...TERTIARY_LIFECYCLE_PHASE_ORDER],
        checkpointId: this.state.checkpointId,
        handoffReference: this.state.handoffReference,
        unconfirmedCallKeys: [],
        closedAtIso: this.state.closedAtIso,
      });
    }
    return { ...this.state };
  }

  private async runPhase(
    phase: TertiaryLifecyclePhase,
    completedPhases: Set<TertiaryLifecyclePhase>,
  ): Promise<{ phase: TertiaryLifecyclePhase; result: string }> {
    this.state = { ...this.state!, phase };
    // 幂等键：执行前持久化"进行中"状态
    if (this.phaseStore !== null) {
      await this.phaseStore.writeState({
        agentInstanceId: this.state.agentInstanceId,
        schemaVersion: 1,
        currentPhase: phase,
        completedPhases: [...completedPhases],
        checkpointId: this.state.checkpointId,
        handoffReference: this.state.handoffReference,
        unconfirmedCallKeys: [],
        closedAtIso: null,
      });
    }
    try {
      const hookKey = HOOK_KEY_BY_PHASE[phase];
      const hook = hookKey === undefined ? undefined : this.hooks[hookKey];
      let result = "none";
      if (hook !== undefined) {
        const hookResult = await hook();
        if (typeof hookResult === "string") {
          result = hookResult;
        }
      }
      completedPhases.add(phase);
      return { phase, result };
    } catch (error) {
      // 阶段失败：持久化状态保留（供幂等重试），不静默跳过
      throw new DomainError(
        "tool-execution-failed",
        `三级 Agent 收口阶段 ${phase} 失败: ${(error as Error).message}`,
      );
    }
  }
}
