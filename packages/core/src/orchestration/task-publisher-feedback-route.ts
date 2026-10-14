/**
 * COMM-01-02（2026-10-25）：**反馈默认走任务发布者的反向通道**。
 *
 * ## 依据（用户 2026-10-22 澄清）
 *
 * > "**反馈不是根据上下级关系进行的**，是**每条任务的反馈路径默认走任务发布者的反向通道**。"
 *
 * ## 现状缺口（实测）
 *
 * `worker-agent.ts` 的 `reportOutcome()` **硬编码** `recipientId: scheduler:<missionId>`，
 * 而 `TaskDependencyNode` **完全没有"发布者"字段** ⇒ 反馈去向与"谁发布了这条任务"无关：
 * 任何别的发布者（如自定义主 Agent 信箱、另一个次级）发布的任务，
 * 其反馈都会**错投到默认 scheduler 信箱**。
 *
 * ## 本模块做什么
 *
 * 纯函数、本地确定性：给定任务，解析其反馈应去的**发布者信箱**；
 * 并在**任务未记录发布者**时**如实报告**（`fallbackReason`），
 * 由调用方决定是回退默认信箱还是拒发 —— 而不是由本模块偷偷改投。
 */
import type { TaskDependencyNode } from "../core/types.js";

export interface FeedbackRouteResolution {
  /** 最终使用的收件人信箱。 */
  recipientId: string;
  /** 是否为"任务发布者的反向通道"（false 表示走了回退）。 */
  isPublisherReverseChannel: boolean;
  /** 走回退时的**可读原因**（供如实记录；正常路径为 null）。 */
  fallbackReason: string | null;
}

/**
 * 解析某条任务的反馈去向。
 *
 * 规则：
 * 1. 任务显式记录了发布者信箱（`publishedByRecipientId`）⇒ **就投给它**（反向通道）；
 * 2. 未记录 ⇒ 回退到 `defaultSchedulerRecipientId`，并**如实说明回退原因**
 *    —— 不静默、也不假装"这就是发布者"。
 */
export function resolveFeedbackRecipient(input: {
  task: TaskDependencyNode;
  /** 旧装配路径下调度器信箱（`scheduler:<missionId>`）。 */
  defaultSchedulerRecipientId: string;
}): FeedbackRouteResolution {
  const publisherRecipientId = input.task.publishedByRecipientId;
  if (typeof publisherRecipientId === "string" && publisherRecipientId.trim() !== "") {
    return {
      recipientId: publisherRecipientId,
      isPublisherReverseChannel: true,
      fallbackReason: null,
    };
  }
  return {
    recipientId: input.defaultSchedulerRecipientId,
    isPublisherReverseChannel: false,
    fallbackReason:
      "任务未记录发布者信箱（`publishedByRecipientId`）⇒ 按旧装配路径回退到 " +
      input.defaultSchedulerRecipientId +
      "；反馈去向可能与实际发布者不一致",
  };
}

/** 按任务链为**全部**任务登记同一个发布者信箱（发布者批量发布时用）。 */
export function stampPublisherOnTasks(input: {
  tasks: readonly TaskDependencyNode[];
  publisherRecipientId: string;
}): TaskDependencyNode[] {
  return input.tasks.map((task) => ({
    ...task,
    publishedByRecipientId: input.publisherRecipientId,
  }));
}
