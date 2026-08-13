/**
 * T05C 单测：待办偏序集（ADR-0013）。
 * 覆盖：环/锚点拒绝、插入前驱后继、ready set 优先级稳定排序、
 * 高优先任务必要前驱提升解释、状态迁移与取消。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import type { AgentTaskNode } from "../../../packages/core/src/core/types.js";
import { TaskSequencePartialOrder } from "../../../packages/core/src/orchestration/task-sequence-partial-order.js";
import { TaskPriorityPolicy } from "../../../packages/core/src/orchestration/task-priority-policy.js";

let ordinal = 0;

function buildNode(
  taskId: string,
  options: Partial<AgentTaskNode> = {},
): AgentTaskNode {
  ordinal += 1;
  return {
    taskId,
    title: `任务 ${taskId}`,
    dependsOn: [],
    sourceKind: "agent",
    publisherId: "publisher-1",
    priorityTier: 1,
    status: "pending",
    blockReason: null,
    externalReference: null,
    sequenceOrdinal: ordinal,
    createdAtIso: new Date().toISOString(),
    ...options,
  };
}

beforeEach(() => {
  ordinal = 0;
});

describe("TaskSequencePartialOrder", () => {
  it("插入前驱/后继边，ready set 满足偏序约束", () => {
    const partialOrder = new TaskSequencePartialOrder([buildNode("a")]);
    partialOrder.insertNode(buildNode("b"), {
      predecessorTaskIds: ["a"],
      successorTaskIds: [],
    });
    expect(partialOrder.getNode("b")?.dependsOn).toContain("a");
    expect(partialOrder.getReadyTaskIds()).toEqual(["a"]);
    partialOrder.transitionStatus("a", "done", ["pending"]);
    expect(partialOrder.getReadyTaskIds()).toEqual(["b"]);
  });

  it("插入到两节点之间（前驱+后继同时指定）", () => {
    const partialOrder = new TaskSequencePartialOrder([
      buildNode("a"),
      buildNode("b"),
    ]);
    partialOrder.insertNode(buildNode("mid"), {
      predecessorTaskIds: ["a"],
      successorTaskIds: ["b"],
    });
    expect(partialOrder.getNode("mid")?.dependsOn).toContain("a");
    expect(partialOrder.getNode("b")?.dependsOn).toContain("mid");
    partialOrder.transitionStatus("a", "done", ["pending"]);
    expect(partialOrder.getReadyTaskIds()).toEqual(["mid"]);
  });

  it("环被拒绝且不污染图", () => {
    const partialOrder = new TaskSequencePartialOrder([buildNode("a")]);
    partialOrder.insertNode(buildNode("b"), {
      predecessorTaskIds: ["a"],
      successorTaskIds: [],
    });
    // 环检测覆盖：构造 x→y→x
    expect(
      () =>
        new TaskSequencePartialOrder([
          buildNode("x", { dependsOn: ["y"] }),
          buildNode("y", { dependsOn: ["x"] }),
        ]),
    ).toThrowError(DomainError);
    // 插入引入环时回滚：新节点 c 依赖 a，再把 a 指定为 c 的后继 → 成环
    expect(() =>
      partialOrder.insertNode(buildNode("c"), {
        predecessorTaskIds: ["b"],
        successorTaskIds: ["a"],
      }),
    ).toThrowError(/环/);
    expect(partialOrder.getTaskIds()).toEqual(["a", "b"]);
  });

  it("插入未知锚点拒绝", () => {
    const partialOrder = new TaskSequencePartialOrder([buildNode("a")]);
    expect(() =>
      partialOrder.insertNode(buildNode("b"), {
        predecessorTaskIds: ["missing"],
        successorTaskIds: [],
      }),
    ).toThrowError(/未知锚点/);
  });

  it("无锚点插入拒绝（不自动追加队尾）", () => {
    const partialOrder = new TaskSequencePartialOrder([buildNode("a")]);
    expect(() =>
      partialOrder.insertNode(buildNode("b"), {
        predecessorTaskIds: [],
        successorTaskIds: [],
      }),
    ).toThrowError(/必须指定直接前驱或直接后继/);
  });

  it("ready set 按优先级层级升序、同层按稳定序号排序（可重放）", () => {
    const partialOrder = new TaskSequencePartialOrder([
      buildNode("low-1", { priorityTier: 1 }),
      buildNode("user-0", { priorityTier: 0 }),
      buildNode("low-2", { priorityTier: 1 }),
    ]);
    const firstComputation = partialOrder.getReadyTaskIds();
    const secondComputation = partialOrder.getReadyTaskIds();
    expect(firstComputation).toEqual(["user-0", "low-1", "low-2"]);
    expect(secondComputation).toEqual(firstComputation);
  });

  it("高优先任务被低层必要前驱阻塞时，explainOrder 给出提升解释", () => {
    const partialOrder = new TaskSequencePartialOrder([
      buildNode("user-root", { priorityTier: 0, sourceKind: "user" }),
    ]);
    partialOrder.insertNode(buildNode("sub-task", { priorityTier: 1 }), {
      predecessorTaskIds: ["user-root"],
      successorTaskIds: [],
    });
    partialOrder.insertNode(buildNode("user-part-2", { priorityTier: 0, sourceKind: "user" }), {
      predecessorTaskIds: ["sub-task"],
      successorTaskIds: [],
    });
    const explanations = partialOrder.explainOrder();
    const subTaskExplanation = explanations.find(
      (entry) => entry.taskId === "sub-task",
    );
    expect(subTaskExplanation?.explanation).toContain("必要前驱");
    expect(subTaskExplanation?.explanation).toContain("user-part-2");
  });

  it("blocked 状态记录阻塞原因并进入解释", () => {
    const partialOrder = new TaskSequencePartialOrder([buildNode("a")]);
    partialOrder.transitionStatus("a", "blocked", ["pending"], "等待用户授权");
    const explanation = partialOrder
      .explainOrder()
      .find((entry) => entry.taskId === "a");
    expect(explanation?.explanation).toContain("等待用户授权");
  });

  it("重复任务 ID 构造拒绝", () => {
    expect(
      () =>
        new TaskSequencePartialOrder([buildNode("a"), buildNode("a")]),
    ).toThrowError(/任务 ID 重复/);
  });
});

describe("TaskPriorityPolicy", () => {
  const policy = new TaskPriorityPolicy();

  it("用户任务不指定层级时默认为 0", () => {
    expect(
      policy.resolvePriorityTier({ sourceKind: "user", requestedPriorityTier: null }),
    ).toBe(0);
  });

  it("用户可主动选择更低层级", () => {
    expect(
      policy.resolvePriorityTier({ sourceKind: "user", requestedPriorityTier: 5 }),
    ).toBe(5);
  });

  it("Agent/system/tool 请求层级 0 被硬拒绝", () => {
    for (const sourceKind of ["agent", "system", "tool"] as const) {
      expect(() =>
        policy.resolvePriorityTier({
          sourceKind,
          requestedPriorityTier: 0,
        }),
      ).toThrowError(DomainError);
      expect(() =>
        policy.resolvePriorityTier({
          sourceKind,
          requestedPriorityTier: 0,
        }),
      ).toThrowError(/仅限用户任务/);
    }
  });

  it("Agent/system/tool 默认层级 1，可指定更低", () => {
    for (const sourceKind of ["agent", "system", "tool"] as const) {
      expect(
        policy.resolvePriorityTier({ sourceKind, requestedPriorityTier: null }),
      ).toBe(1);
      expect(
        policy.resolvePriorityTier({ sourceKind, requestedPriorityTier: 3 }),
      ).toBe(3);
    }
  });

  it("canPublishAtTierZero 仅用户为真", () => {
    expect(policy.canPublishAtTierZero("user")).toBe(true);
    expect(policy.canPublishAtTierZero("agent")).toBe(false);
    expect(policy.canPublishAtTierZero("system")).toBe(false);
    expect(policy.canPublishAtTierZero("tool")).toBe(false);
  });
});
