/**
 * NODECTX-01-03：**四态展示**与"不把'不在上下文'显示成删除"（2026-10-10）。
 *
 * 契约来源：`docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md` §2.1/§2.2 与检查点 03。
 *
 * 卡内硬要求逐条落实：
 *  - "展示 **active / 暂存 / 永久关闭 / 待追认**及**暂存原因**"；
 *  - "**不把'不在上下文'显示成删除**" ⇒ 文案**不得**含删除类字样，
 *    并**必须**说明原文仍在、可显式回访；
 *  - "永久关闭**不代表物理删除**、可显式回访"；
 *  - "**待追认**节点仍带**不确定标记**"（核验否决会阻断后继）；
 *  - "**不能把'暂不入提示词'当 done**" ⇒ 完成与否只由业务状态决定。
 *
 * 本模块是**纯函数展示层**：不做 I/O、不联网、不改状态。
 */

import type {
  ContextVisibilityState,
  NodeBusinessStatus,
} from "./context-lossless-visibility.js";

/** 展示四态（与内部三态 + 待追认标记的映射见下）。 */
export const CONTEXT_VISIBILITY_DISPLAY_STATES = [
  "active",
  "staged",
  "permanently-closed",
  "pending-ratification",
] as const;
export type ContextVisibilityDisplayState =
  (typeof CONTEXT_VISIBILITY_DISPLAY_STATES)[number];

export interface ContextVisibilityViewInput {
  nodeIdentifier: string;
  visibilityState: ContextVisibilityState;
  businessStatus: NodeBusinessStatus;
  /** 暂存原因（卡内要求展示）。缺省时视图会显式标注"原因未记录"。 */
  stagingReason: string | null;
  /** 是否待追认（核验尚未通过）。 */
  isPendingRatification: boolean;
}

export interface ContextVisibilityViewRow {
  nodeIdentifier: string;
  displayState: ContextVisibilityDisplayState;
  displayStateLabel: string;
  displayText: string;
  stagingReason: string;
  isPendingRatification: boolean;
  /** 原文是否仍在磁盘（恒为 true）。 */
  isContentRetainedOnDisk: true;
  /** 是否允许显式回访（恒为 true）。 */
  isExplicitRecallAllowed: true;
  /**
   * 是否被"显示成删除"。
   *
   * **恒为 false** —— 这是卡内最明确的一条界面纪律，故做成**可断言字段**
   * 而不是只靠文案约定。
   */
  isShownAsDeleted: false;
  /** 业务完成与否（只由业务状态决定）。 */
  isBusinessCompleted: boolean;
  /** 是否呈现为"已完成成果"（待追认时**恒为 false**）。 */
  isShownAsCompleted: boolean;
}

const DISPLAY_STATE_LABELS: Record<ContextVisibilityDisplayState, string> = {
  active: "在上下文",
  staged: "暂存（原文仍在磁盘）",
  "permanently-closed": "永久关闭（原文完整保留，可显式回访）",
  "pending-ratification": "待追认（结论尚未确认）",
};

function resolveDisplayState(input: ContextVisibilityViewInput): ContextVisibilityDisplayState {
  /**
   * 待追认优先于其它展示态：卡内要求待追认**必须带不确定标记**，
   * 因此不能被"永久关闭"这类看似确定的标签掩盖。
   */
  if (input.isPendingRatification) {
    return "pending-ratification";
  }
  switch (input.visibilityState) {
    case "active":
      return "active";
    case "temporarily-closed":
      return "staged";
    case "permanently-closed":
      return "permanently-closed";
    default:
      return "staged";
  }
}

function buildDisplayText(input: {
  nodeIdentifier: string;
  displayState: ContextVisibilityDisplayState;
  stagingReason: string;
  isPendingRatification: boolean;
}): string {
  const base =
    input.nodeIdentifier + " [" + DISPLAY_STATE_LABELS[input.displayState] + "]";
  if (input.displayState === "active") {
    return base + " 当前已在装配范围内";
  }
  /**
   * "不在上下文"必须**明确**说明原文仍在且可回访 —— 绝不出现"删除/移除"等字样。
   * 文案由本函数**单点生成**，避免各处自行拼接时口径分叉。
   */
  /**
   * 用**肯定式**表述"原文保留"：既满足"不显示成删除"，
   * 也避免文案里出现"删除"二字（界面纪律要求不出现该字样）。
   */
  const retentionNotice = "原文完整保留在磁盘存档，可显式回访";
  const reasonPart = "；暂存原因：" + input.stagingReason;
  const ratificationPart = input.isPendingRatification
    ? "；待追认：结论尚未确认，核验否决将阻断后继"
    : "";
  return base + " 不在当前上下文；" + retentionNotice + reasonPart + ratificationPart;
}

/** 构造展示行（纯函数）。空输入 ⇒ 空数组（**不伪造行**）。 */
export function buildContextVisibilityDisplayRows(
  inputs: readonly ContextVisibilityViewInput[],
): ContextVisibilityViewRow[] {
  return inputs.map((input) => {
    const displayState = resolveDisplayState(input);
    /**
     * 暂存原因缺失时**不得留白**：留白会让用户以为"没有原因"，
     * 而实际上只是没记录。故显式标注（并提示需补记）。
     */
    const stagingReason =
      typeof input.stagingReason === "string" && input.stagingReason.trim() !== ""
        ? input.stagingReason
        : "原因未记录（须补记暂存原因）";
    const isBusinessCompleted = input.businessStatus === "completed";
    return {
      nodeIdentifier: input.nodeIdentifier,
      displayState,
      displayStateLabel: DISPLAY_STATE_LABELS[displayState],
      displayText: buildDisplayText({
        nodeIdentifier: input.nodeIdentifier,
        displayState,
        stagingReason,
        isPendingRatification: input.isPendingRatification,
      }),
      stagingReason,
      isPendingRatification: input.isPendingRatification,
      isContentRetainedOnDisk: true,
      isExplicitRecallAllowed: true,
      isShownAsDeleted: false,
      isBusinessCompleted,
      /**
       * 待追认时**即便**业务状态是 completed，也**不得**呈现为"已完成成果"——
       * 卡内"待追认节点仍带不确定标记"，且核验否决会阻断后继。
       */
      isShownAsCompleted: isBusinessCompleted && !input.isPendingRatification,
    };
  });
}
