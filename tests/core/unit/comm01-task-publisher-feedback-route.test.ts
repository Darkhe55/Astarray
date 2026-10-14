/**
 * 反例（2026-10-25）：**反馈默认走任务发布者的反向通道**。
 *
 * 依据用户 2026-10-22 澄清：
 * > "反馈**不是根据上下级关系**进行的，是**每条任务的反馈路径默认走任务发布者的反向通道**。"
 *
 * 修复前实测缺口：`worker-agent.reportOutcome()` **硬编码** `scheduler:<missionId>`，
 * 且 `TaskDependencyNode` **没有发布者字段** ⇒ 别处发布的任务反馈会**错投**。
 */
import { describe, expect, it } from "vitest";

import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import {
  resolveFeedbackRecipient,
  stampPublisherOnTasks,
} from "../../../packages/core/src/orchestration/task-publisher-feedback-route.js";

const DEFAULT_SCHEDULER = "scheduler:mission-1";

function buildTask(overrides: Partial<TaskDependencyNode> = {}): TaskDependencyNode {
  return {
    id: "task-1",
    description: "写报告",
    dependsOn: [],
    taskType: "implementation",
    toolNames: [],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
    ...overrides,
  };
}

describe("COMM-01-02：反馈去向 = 任务发布者的反向通道", () => {
  it("① 任务记录了发布者 ⇒ 反馈**投给发布者**（不是默认 scheduler）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask({ publishedByRecipientId: "main:mission-7" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.recipientId).toBe("main:mission-7");
    expect(route.isPublisherReverseChannel).toBe(true);
    expect(route.fallbackReason).toBeNull();
  });

  it("② 任务**未记录**发布者 ⇒ 回退默认信箱，且**如实说明回退原因**（不静默）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask(),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.recipientId).toBe(DEFAULT_SCHEDULER);
    expect(route.isPublisherReverseChannel).toBe(false);
    // 必须能让调用方看出来"这不是按发布者投的"
    expect(String(route.fallbackReason)).toContain("未记录发布者信箱");
    expect(String(route.fallbackReason)).toContain(DEFAULT_SCHEDULER);
  });

  it("③ 发布者字段为**空白字符串** ⇒ 视为未记录（不得把空串当有效信箱）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask({ publishedByRecipientId: "   " }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.isPublisherReverseChannel).toBe(false);
    expect(route.recipientId).toBe(DEFAULT_SCHEDULER);
  });

  it("④ 发布者可**批量登记**到任务链全部任务（发布时使用）", () => {
    const tasks = [buildTask({ id: "a" }), buildTask({ id: "b" })];

    const stamped = stampPublisherOnTasks({
      tasks,
      publisherRecipientId: "main:mission-9",
    });

    expect(stamped).toHaveLength(2);
    for (const task of stamped) {
      expect(task.publishedByRecipientId).toBe("main:mission-9");
    }
    // 必须**不改动**其它字段，且不原地修改入参
    expect(stamped[0]!.id).toBe("a");
    expect(tasks[0]!.publishedByRecipientId).toBeUndefined();
  });

  it("⑤ 两条任务由**不同发布者**发布 ⇒ 各自反馈回各自发布者（不串档）", () => {
    const first = resolveFeedbackRecipient({
      task: buildTask({ id: "a", publishedByRecipientId: "main:mission-7" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });
    const second = resolveFeedbackRecipient({
      task: buildTask({ id: "b", publishedByRecipientId: "scheduler:mission-2" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(first.recipientId).toBe("main:mission-7");
    expect(second.recipientId).toBe("scheduler:mission-2");
    expect(first.recipientId).not.toBe(second.recipientId);
  });
});
