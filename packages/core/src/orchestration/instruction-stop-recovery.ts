/**
 * SMART-01-03：早停分类、漏回执兜底与澄清参考（2026-10-02）。
 *
 * 契约来源：SMART-01 卡 §4（模型停止与缺失信号兜底）与 §5（等待澄清时参考后续指令），
 * 以及 SMART-01-01 冻结的窗口契约。
 *
 * 纪律（逐条对应反例）：
 *  - **早停不注入新工作**：早停时保留窗口，优先有界追问当前指令状态/续跑旧任务；
 *  - **漏回执不得靠 stop 原因推断完成**：只有独立权威证据才允许本地补记闭合依据；
 *  - **明确等待用户细节时不机械续跑**；
 *  - **停止/休息/授权不被绕过**：显式停止或休息期间一律不注入新指令；
 *  - 澄清回答中的**混合信封**：抽取答案，同时**保留剩余任务**（不得丢弃）。
 */

export type ModelStopClassificationKind =
  | "closed-with-receipt"
  | "closed-by-local-evidence"
  | "early-stop"
  | "awaiting-user-details";

export type ModelStopFollowUpAction =
  | "release-slot-and-submit-following"
  | "bounded-follow-up-current-instruction"
  | "await-user-clarification";

export interface ModelStopClassification {
  kind: ModelStopClassificationKind;
  shouldInjectNewInstruction: boolean;
  shouldReleaseSlot: boolean;
  followUpAction: ModelStopFollowUpAction;
  /** 显式用户停止或休息期间：一切注入被阻断。 */
  isOverrideBlocked: boolean;
  detail: string;
}

/**
 * 分类一次模型停止（**不是**用户关闭会话/应用）。
 *
 * 判定顺序（先硬约束、后结果）：
 *  1) 显式停止 / 休息中 → 阻断注入（不得被后续条件绕过）；
 *  2) 明确等待用户细节 → 保持等待；
 *  3) 有效关闭回执 → 释放槽位并可提交后续指导；
 *  4) 有**独立权威证据**（派发/验收记录）→ 本地补记闭合依据后补位；
 *  5) 其余（含早停）→ 保留窗口并做有界追问。
 */
export function classifyModelStop(input: {
  stopReason: string;
  hasValidClosingReceipt: boolean;
  hasIndependentAuthoritativeEvidence: boolean;
  isWaitingForUserDetails: boolean;
  producedTextDeltaCount: number;
  isExplicitUserStop: boolean;
  isResting: boolean;
}): ModelStopClassification {
  // 1) 硬约束优先：停止/休息不得被任何"看起来完成"的信号绕过。
  if (input.isExplicitUserStop || input.isResting) {
    return {
      kind: "early-stop",
      shouldInjectNewInstruction: false,
      shouldReleaseSlot: false,
      followUpAction: "bounded-follow-up-current-instruction",
      isOverrideBlocked: true,
      detail: input.isExplicitUserStop
        ? "用户已显式停止：不得注入新指令"
        : "处于休息期：不得注入新指令（也不得产生模型/业务请求）",
    };
  }

  // 2) 明确等待用户细节：保持等待，不机械续跑。
  if (input.isWaitingForUserDetails) {
    return {
      kind: "awaiting-user-details",
      shouldInjectNewInstruction: false,
      shouldReleaseSlot: false,
      followUpAction: "await-user-clarification",
      isOverrideBlocked: false,
      detail: "明确等待用户细节：保持等待，不机械续跑",
    };
  }

  // 3) 有效关闭回执。
  if (input.hasValidClosingReceipt) {
    return {
      kind: "closed-with-receipt",
      shouldInjectNewInstruction: true,
      shouldReleaseSlot: true,
      followUpAction: "release-slot-and-submit-following",
      isOverrideBlocked: false,
      detail: "关闭回执有效：释放已关闭槽位并按剩余容量提交后续指导",
    };
  }

  // 4) 漏回执但有独立权威证据（**不得仅凭 stopReason 推断完成**）。
  if (input.hasIndependentAuthoritativeEvidence) {
    return {
      kind: "closed-by-local-evidence",
      shouldInjectNewInstruction: true,
      shouldReleaseSlot: true,
      followUpAction: "release-slot-and-submit-following",
      isOverrideBlocked: false,
      detail: "存在独立权威证据（派发/验收记录）：本地补记闭合依据后补位",
    };
  }

  // 5) 早停 / 无法确定：保留窗口并做有界追问。
  return {
    kind: "early-stop",
    shouldInjectNewInstruction: false,
    shouldReleaseSlot: false,
    followUpAction: "bounded-follow-up-current-instruction",
    isOverrideBlocked: false,
    detail:
      "缺少有效回执且无独立权威证据（stopReason=" +
      input.stopReason +
      "，文本增量 " +
      String(input.producedTextDeltaCount) +
      "）：保留窗口，优先有界追问当前指令状态/续跑旧任务，不注入无关新指令",
  };
}

export type MissingReceiptAction = "bounded-follow-up" | "report-blocked-keep-window" | "no-action";

export interface MissingReceiptResolution {
  action: MissingReceiptAction;
  shouldReleaseSlot: boolean;
  shouldInjectNewInstruction: boolean;
  detail: string;
}

/**
 * 漏回执兜底：与早停分类联动。
 *
 * - 尚未耗尽追问预算 → 有界追问（不释放槽位、不注入新指令）；
 * - 追问预算耗尽 → **报告阻塞并保留队列**，不无限请求模型继续；
 * - 分类本身已允许闭合（回执有效或独立权威证据）→ no-action（由分类路径处理）。
 */
export function resolveMissingReceipt(input: {
  classification: ModelStopClassification;
  remainingFollowUpAttempts: number;
}): MissingReceiptResolution {
  if (input.classification.kind === "closed-with-receipt" || input.classification.kind === "closed-by-local-evidence") {
    return {
      action: "no-action",
      shouldReleaseSlot: input.classification.shouldReleaseSlot,
      shouldInjectNewInstruction: input.classification.shouldInjectNewInstruction,
      detail: "分类已允许闭合：无需漏回执兜底",
    };
  }
  if (input.classification.isOverrideBlocked) {
    return {
      action: "no-action",
      shouldReleaseSlot: false,
      shouldInjectNewInstruction: false,
      detail: "停止/休息期间：不做追问也不注入",
    };
  }
  if (input.classification.kind === "awaiting-user-details") {
    return {
      action: "no-action",
      shouldReleaseSlot: false,
      shouldInjectNewInstruction: false,
      detail: "等待用户细节：不做机械追问",
    };
  }
  if (input.remainingFollowUpAttempts > 0) {
    return {
      action: "bounded-follow-up",
      shouldReleaseSlot: false,
      shouldInjectNewInstruction: false,
      detail:
        "有界追问当前指令状态（剩余次数 " +
        String(input.remainingFollowUpAttempts) +
        "）：共享任务级预算，重启不重置",
    };
  }
  return {
    action: "report-blocked-keep-window",
    shouldReleaseSlot: false,
    shouldInjectNewInstruction: false,
    detail: "追问预算已耗尽：报告阻塞并**保留队列**，不无限请求模型继续",
  };
}

export interface ClarificationExtraction {
  isAnswered: boolean;
  answerText: string | null;
  /** 混合信封中除答案外的剩余任务（**不得丢弃**）。 */
  remainingInstructions: string[];
  shouldKeepWaiting: boolean;
}

/** 混合信封分隔标记（答案与后续任务之间的分界）。 */
const ENVELOPE_SEPARATOR_PATTERN = /^(?:---|—{2,}|【以下为后续任务】|以下为后续任务[:：]?)$/;

/** 答案前缀标记。 */
const ANSWER_PREFIX_PATTERN = /^(?:答案|回答|答)[:：]\s*/;

/**
 * 从用户对澄清问题的回复中抽取答案（SMART-01 卡 §5，"仅抽取答案"）。
 *
 * 规则：
 *  - 空回复 → 未回答，保持等待；
 *  - 含分隔标记 → 分隔符之前为答案，之后逐条为**剩余任务**；
 *  - 无分隔标记 → 整段视为答案（宁可把任务留待用户重申，也不擅自切分）。
 */
export function extractClarificationAnswer(input: {
  pendingQuestion: string;
  replyText: string;
}): ClarificationExtraction {
  const trimmedReply = input.replyText.trim();
  if (trimmedReply === "") {
    return {
      isAnswered: false,
      answerText: null,
      remainingInstructions: [],
      shouldKeepWaiting: true,
    };
  }

  const lines = trimmedReply.split("\n");
  const separatorIndex = lines.findIndex((line) => ENVELOPE_SEPARATOR_PATTERN.test(line.trim()));
  if (separatorIndex < 0) {
    return {
      isAnswered: true,
      answerText: stripAnswerPrefix(trimmedReply),
      remainingInstructions: [],
      shouldKeepWaiting: false,
    };
  }

  const answerLines = lines.slice(0, separatorIndex);
  const remainderLines = lines.slice(separatorIndex + 1);
  const answerText = stripAnswerPrefix(answerLines.join("\n").trim());
  const remainingInstructions = remainderLines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line !== "");

  return {
    isAnswered: answerText !== "",
    answerText: answerText === "" ? null : answerText,
    remainingInstructions,
    shouldKeepWaiting: answerText === "",
  };
}

function stripAnswerPrefix(text: string): string {
  return text.replace(ANSWER_PREFIX_PATTERN, "").trim();
}
