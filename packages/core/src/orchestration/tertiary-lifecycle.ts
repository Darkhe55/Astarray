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
import { randomUUID } from "node:crypto";

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

export class TertiaryAgentLifecycleController {
  private readonly hooks: TertiaryLifecycleHookSet;
  private state: TertiaryLifecycleState | null = null;

  constructor(hooks: TertiaryLifecycleHookSet = {}) {
    this.hooks = hooks;
  }

  getState(): TertiaryLifecycleState | null {
    return this.state === null ? null : { ...this.state };
  }

  /**
   * 受控收口：按固定阶段顺序执行，每阶段幂等可重试；
   * 不允许仅以杀进程代替状态收口（terminateProcess 是最后阶段）。
   */
  async shutdown(input: { agentInstanceId: string }): Promise<TertiaryLifecycleState> {
    this.state = {
      agentInstanceId: input.agentInstanceId,
      phase: "stopping-dispatch",
      checkpointId: null,
      handoffReference: null,
      closedAtIso: null,
    };
    await this.runPhase("stopping-dispatch", this.hooks.stopDispatch);
    await this.runPhase("draining-unconfirmed-calls", this.hooks.drainUnconfirmedCalls);
    const checkpointId = await this.runPhase(
      "persisting-checkpoint",
      this.hooks.persistCheckpoint,
      async () => `checkpoint-${randomUUID()}`,
    );
    const handoffReference = await this.runPhase(
      "writing-handoff",
      this.hooks.writeHandoff,
      async () => `handoff-${randomUUID()}`,
    );
    await this.runPhase("confirming-feedback", this.hooks.confirmFeedback);
    await this.runPhase("revoking-permission-lease", this.hooks.revokePermissionLease);
    await this.runPhase("unregistering-mailbox", this.hooks.unregisterMailbox);
    await this.runPhase("handling-git-resources", this.hooks.handleGitResources);
    await this.runPhase("terminating-process", this.hooks.terminateProcess);
    this.state = {
      ...this.state,
      phase: "closed",
      checkpointId,
      handoffReference,
      closedAtIso: new Date().toISOString(),
    };
    return { ...this.state };
  }

  private async runPhase(
    phase: TertiaryLifecyclePhase,
    hook: (() => Promise<unknown>) | undefined,
    fallback: () => Promise<string> = async () => "none",
  ): Promise<string> {
    this.state = { ...this.state!, phase };
    try {
      if (hook !== undefined) {
        const hookResult = await hook();
        if (typeof hookResult === "string") {
          return hookResult;
        }
        return await fallback();
      }
      return await fallback();
    } catch (error) {
      // 阶段失败：保留状态供幂等重试（不静默跳过）
      throw new DomainError(
        "tool-execution-failed",
        `三级 Agent 收口阶段 ${phase} 失败: ${(error as Error).message}`,
      );
    }
  }
}
