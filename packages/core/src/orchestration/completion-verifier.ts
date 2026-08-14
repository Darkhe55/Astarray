/**
 * 本地完成验收器（T07A / ADR-0015）。
 * 完成事件是必要条件，不是充分条件。只有同时确认以下条件才提交 done：
 * 1. 事件 schema、任务 ID、一次性尝试 ID 与状态 revision 有效且未重放；
 * 2. 声明范围内所有必要节点均处于可完成状态，无未满足前驱；
 * 3. 无运行中的工具调用、待确认副作用、待处理权限请求或未确认反馈；
 * 4. 任务要求的产物存在，验收门禁有本地证据；
 * 5. 高严谨性任务已执行 ADR-0016 事实验证流程（接入 EvidenceCompletionGate）；
 * 6. ADR-0017 循环守卫无未解决活锁，任务级总调用预算未被绕过；
 * 7. 没有未解决的 blocked/failed/取消或用户输入需求；
 * 8. Provider 流正常结束，控制事件位于允许的最终通道。
 * 模型无法用自述覆盖本地状态；标识合法但门禁未完成时记录
 * completion_claim_rejected 并继续未完成项。
 */
import type {
  EvidenceBundle,
} from "../core/types.js";
import type { TaskCompletionEventV1 } from "../core/completion-protocol.js";
import type { EvidenceCompletionGate } from "../tools/evidence-completion-gate.js";

export type CompletionVerificationDecision =
  | { accepted: true }
  | {
      accepted: false;
      rejectionReasons: string[];
    };

export interface CompletionVerificationContext {
  taskExecutionId: string;
  /** 预期任务 ID（防错误任务声明）。 */
  expectedTaskIdentifiers: string[];
  /** 当前任务链 revision（陈旧声明拒绝）。 */
  currentTaskSequenceRevision: number;
  /** 已完成/可完成状态的节点 ID 集合。 */
  completableTaskIdentifiers: string[];
  /** 未满足前驱的任务 ID 集合。 */
  unsatisfiedPredecessorTaskIdentifiers: string[];
  /** 运行中的工具调用/待确认副作用/待处理权限/未确认反馈计数。 */
  pendingWorkItemCount: number;
  /** 产物存在性 + 验收门禁证据（命令列表，全部须成功）。 */
  artifactVerificationEvidence: Array<{ gateName: string; passed: boolean }>;
  /** 循环守卫是否有未解决活锁（ADR-0017）。 */
  hasUnresolvedLivelock: boolean;
  /** 任务总调用预算是否被绕过（ADR-0017）。 */
  isTaskBudgetBypassed: boolean;
  /** 是否存在未解决的 blocked/failed/取消或用户输入需求。 */
  hasUnresolvedBlockedOrFailedState: boolean;
  /** Provider 流是否正常结束（控制事件位于最终通道）。 */
  didProviderStreamEndCleanly: boolean;
  /** 高严谨性任务的证据门禁（ADR-0016；standard 任务传 null）。 */
  evidenceGate: {
    gate: EvidenceCompletionGate;
    bundle: EvidenceBundle | null;
    requiredClaimIdentifier: string;
    requireSourceText: boolean;
  } | null;
  /** 已使用完成尝试 ID（防重放）。 */
  usedCompletionAttemptIds: Set<string>;
}

export class LocalCompletionVerifier {
  /**
   * 验收完成事件；任一条件不满足 → rejected（记录原因）。
   * 每次只结案一次：accepted 后调用方必须把 completionAttemptId 记入
   * usedCompletionAttemptIds。
   */
  verifyCompletion(
    event: TaskCompletionEventV1,
    context: CompletionVerificationContext,
  ): CompletionVerificationDecision {
    const rejectionReasons: string[] = [];
    // 1) schema 已由解析器校验；此处校验任务/尝试 ID、revision 与重放
    if (context.usedCompletionAttemptIds.has(event.completionAttemptId)) {
      rejectionReasons.push(`完成尝试 ID 重放: ${event.completionAttemptId}`);
    }
    if (event.taskExecutionId !== context.taskExecutionId) {
      rejectionReasons.push(
        `任务执行 ID 不匹配: ${event.taskExecutionId} ≠ ${context.taskExecutionId}`,
      );
    }
    if (event.taskSequenceRevision < context.currentTaskSequenceRevision) {
      rejectionReasons.push(
        `完成声明 revision 陈旧: ${event.taskSequenceRevision} < ${context.currentTaskSequenceRevision}`,
      );
    }
    // 2) 声明范围内节点可完成且无未满足前驱
    for (const declaredTaskId of event.completedTaskIdentifiers) {
      if (!context.completableTaskIdentifiers.includes(declaredTaskId)) {
        rejectionReasons.push(`声明完成的任务不可完成: ${declaredTaskId}`);
      }
      if (
        context.unsatisfiedPredecessorTaskIdentifiers.includes(declaredTaskId)
      ) {
        rejectionReasons.push(`任务 ${declaredTaskId} 仍有未满足前驱`);
      }
    }
    if (
      !event.completedTaskIdentifiers.every((declaredTaskId) =>
        context.expectedTaskIdentifiers.includes(declaredTaskId),
      )
    ) {
      rejectionReasons.push("声明范围含预期外任务 ID");
    }
    // 3) 无未决工作
    if (context.pendingWorkItemCount > 0) {
      rejectionReasons.push(
        `存在 ${context.pendingWorkItemCount} 个未决工作项（运行中工具/未确认副作用/待处理权限/未确认反馈）`,
      );
    }
    // 4) 产物与验收门禁证据
    for (const evidence of context.artifactVerificationEvidence) {
      if (!evidence.passed) {
        rejectionReasons.push(`验收门禁未通过: ${evidence.gateName}`);
      }
    }
    // 5) 高严谨性任务证据门禁（ADR-0016）
    if (context.evidenceGate !== null) {
      const gateResult = context.evidenceGate.gate.evaluateEvidenceBundle(
        context.evidenceGate.bundle,
        {
          requiredClaimIdentifier:
            context.evidenceGate.requiredClaimIdentifier,
          requireSourceText: context.evidenceGate.requireSourceText,
        },
      );
      if (!gateResult.isPassable) {
        rejectionReasons.push(
          `高严谨性证据门禁未满足: ${gateResult.unmetRequirements.join("；")}`,
        );
      }
    }
    // 6) 循环守卫
    if (context.hasUnresolvedLivelock) {
      rejectionReasons.push("循环守卫存在未解决活锁");
    }
    if (context.isTaskBudgetBypassed) {
      rejectionReasons.push("任务级总调用预算被绕过");
    }
    // 7) 无未解决阻塞
    if (context.hasUnresolvedBlockedOrFailedState) {
      rejectionReasons.push("存在未解决的 blocked/failed/取消或用户输入需求");
    }
    // 8) Provider 流正常结束
    if (!context.didProviderStreamEndCleanly) {
      rejectionReasons.push("Provider 流未正常结束");
    }
    if (rejectionReasons.length > 0) {
      return { accepted: false, rejectionReasons };
    }
    return { accepted: true };
  }
}
