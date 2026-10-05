/**
 * SMART-01-04：主 Agent 期限监督与有界补位（2026-10-02）。
 *
 * 契约来源：SMART-01 卡 §4（兜底"自动输入剩余指令"仅指确认有可用槽位且允许继续后，
 * 按窗口**有界**提交尚未应用的指令；**不一次灌入整个队列**，**不重复在途指令**，
 * **不伪造新用户消息**；每次补位记录原始来源和自动投递原因）
 * 与 §5/§6（主 Agent 单条指令须在三分钟内处理并派发，不阻塞持续交流）。
 *
 * 纪律：
 *  - 超期必须**如实报超时**，不得伪报已派发；
 *  - 等待澄清保持"等待"而非"完成"；**UI 状态不得冒充成果完成**；
 *  - 权限等待/休息/显式停止**不得用补位绕过原门禁**；
 *  - 补位只按可用槽位数量提交，且跳过已在途、记录来源与原因、不伪造用户消息。
 */

/** 主 Agent 单条用户指令的派发期限：三分钟（卡内明文）。 */
export const MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS = 180_000;

export type InstructionDeadlineKind =
  | "dispatched-within-deadline"
  | "overdue-not-dispatched"
  | "awaiting-clarification";

export interface InstructionDeadlineEvaluation {
  instructionIdentifier: string;
  kind: InstructionDeadlineKind;
  deadlineMilliseconds: number;
  elapsedMilliseconds: number;
  remainingMilliseconds: number;
  /** 是否属于"如实超时"报告（不得伪报已派发）。 */
  isTruthfulTimeout: boolean;
  /** 是否可继续接收新指令（慢模型/长下级任务不得阻塞接收）。 */
  canAcceptNewInstruction: boolean;
  /** 是否被既有门禁（权限/休息/停止）拦住补位。 */
  isGatedByExistingGate: boolean;
  /** 是否可视为"成果完成"（等待澄清时不得为真）。 */
  isWorkCompleted: boolean;
  detail: string;
}

/**
 * 评估一条指令是否在期限内完成派发。
 *
 * 门禁优先：权限等待 / 休息 / 显式停止时**不得**借补位绕过原门禁
 * （canAcceptNewInstruction=false 且 isGatedByExistingGate=true）。
 */
export function evaluateInstructionDeadline(input: {
  instructionIdentifier: string;
  acceptedAtIso: string;
  nowIso: string;
  dispatchedAtIso?: string | null;
  isAwaitingClarification?: boolean;
  isAwaitingPermissionDecision?: boolean;
  isResting?: boolean;
  isExplicitUserStop?: boolean;
  hasLongRunningSubordinateTask?: boolean;
}): InstructionDeadlineEvaluation {
  const acceptedAtMilliseconds = Date.parse(input.acceptedAtIso);
  const nowMilliseconds = Date.parse(input.nowIso);
  const elapsedMilliseconds =
    Number.isNaN(acceptedAtMilliseconds) || Number.isNaN(nowMilliseconds)
      ? 0
      : Math.max(0, nowMilliseconds - acceptedAtMilliseconds);
  const remainingMilliseconds = Math.max(
    0,
    MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS - elapsedMilliseconds,
  );

  const isGatedByExistingGate =
    input.isAwaitingPermissionDecision === true ||
    input.isResting === true ||
    input.isExplicitUserStop === true;

  // 门禁优先：不得用补位绕过。
  const canAcceptNewInstruction =
    !isGatedByExistingGate && !(input.isAwaitingClarification === true);

  if (input.isAwaitingClarification === true) {
    return {
      instructionIdentifier: input.instructionIdentifier,
      kind: "awaiting-clarification",
      deadlineMilliseconds: MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
      elapsedMilliseconds,
      remainingMilliseconds,
      isTruthfulTimeout: false,
      canAcceptNewInstruction,
      isGatedByExistingGate,
      // 关键：等待澄清不是成果完成，UI 不得冒充。
      isWorkCompleted: false,
      detail: "等待用户澄清：状态为「等待」而非「完成」，不得伪报已派发",
    };
  }

  if (input.dispatchedAtIso !== undefined && input.dispatchedAtIso !== null) {
    const dispatchedAtMilliseconds = Date.parse(input.dispatchedAtIso);
    const isWithinDeadline =
      !Number.isNaN(dispatchedAtMilliseconds) &&
      dispatchedAtMilliseconds - acceptedAtMilliseconds <= MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS;
    if (isWithinDeadline) {
      return {
        instructionIdentifier: input.instructionIdentifier,
        kind: "dispatched-within-deadline",
        deadlineMilliseconds: MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
        elapsedMilliseconds,
        remainingMilliseconds,
        isTruthfulTimeout: false,
        canAcceptNewInstruction,
        isGatedByExistingGate,
        // 已派发 ≠ 成果完成（卡内：UI 必须区分"已派发"与"工作成果完成"）。
        isWorkCompleted: false,
        detail: "已在期限内派发（注意：已派发不等于成果完成）",
      };
    }
  }

  if (remainingMilliseconds === 0) {
    return {
      instructionIdentifier: input.instructionIdentifier,
      kind: "overdue-not-dispatched",
      deadlineMilliseconds: MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
      elapsedMilliseconds,
      remainingMilliseconds,
      isTruthfulTimeout: true,
      canAcceptNewInstruction,
      isGatedByExistingGate,
      isWorkCompleted: false,
      detail:
        "超过三分钟仍未派发：**如实报告超时**，不得伪报已派发",
    };
  }

  return {
    instructionIdentifier: input.instructionIdentifier,
    kind: "dispatched-within-deadline",
    deadlineMilliseconds: MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
    elapsedMilliseconds,
    remainingMilliseconds,
    isTruthfulTimeout: false,
    canAcceptNewInstruction,
    isGatedByExistingGate,
    isWorkCompleted: false,
    detail:
      "期限内处理中（剩余 " +
      String(remainingMilliseconds) +
      "ms；在途长下级任务不阻塞接收新指令）",
  };
}

export interface BackfillCandidate {
  instructionIdentifier: string;
  sourceKind: "user" | "agent";
  isAlreadyInFlight: boolean;
}

export interface BackfillSelection {
  instructionIdentifier: string;
  sourceKind: "user" | "agent";
  /** 自动投递原因（卡内：每次补位记录原因）。 */
  backfillReason: string;
  /** 明确不是伪造的用户消息。 */
  isSyntheticUserMessage: false;
}

export interface BackfillPlan {
  selected: BackfillSelection[];
  deferredCount: number;
  skippedAlreadyInFlight: number;
  detail: string;
}

/**
 * 构造**有界**补位计划（卡内 §4）。
 *
 * - 仅在有可用槽位且**允许继续**时补位；不允许则返回空计划；
 * - 只取等于可用槽位数量（**不一次灌入整个队列**）；
 * - **跳过已在途**指令（不重复投递）；
 * - 记录来源与自动投递原因；明确不伪造用户消息。
 */
export function buildBackfillPlan(input: {
  availableSlotCount: number;
  queuedInstructions: BackfillCandidate[];
  isContinuationAllowed: boolean;
  backfillReason?: string;
}): BackfillPlan {
  const skippedAlreadyInFlight = input.queuedInstructions.filter(
    (candidate) => candidate.isAlreadyInFlight,
  ).length;
  if (!input.isContinuationAllowed) {
    return {
      selected: [],
      deferredCount: input.queuedInstructions.length,
      skippedAlreadyInFlight,
      detail: "未获允许继续（门禁/休息/停止/预算耗尽）：不得补位",
    };
  }
  if (input.availableSlotCount <= 0) {
    return {
      selected: [],
      deferredCount: input.queuedInstructions.length,
      skippedAlreadyInFlight,
      detail: "无可用槽位：不得补位",
    };
  }
  const backfillReason = input.backfillReason ?? "槽位释放后按窗口有界提交";
  const eligible = input.queuedInstructions.filter(
    (candidate) => !candidate.isAlreadyInFlight,
  );
  const selectedCandidates = eligible.slice(0, input.availableSlotCount);
  return {
    selected: selectedCandidates.map((candidate) => ({
      instructionIdentifier: candidate.instructionIdentifier,
      sourceKind: candidate.sourceKind,
      backfillReason,
      isSyntheticUserMessage: false,
    })),
    deferredCount: eligible.length - selectedCandidates.length,
    skippedAlreadyInFlight,
    detail:
      "有界补位 " +
      String(selectedCandidates.length) +
      " 条（可用槽位 " +
      String(input.availableSlotCount) +
      "）；其余 " +
      String(eligible.length - selectedCandidates.length) +
      " 条继续排队，不一次灌入",
  };
}
