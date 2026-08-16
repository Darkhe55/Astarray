/**
 * B6R-11：TaskGraph 缺口分支（assignAgent/transitionTask 不存在任务抛错）。
 */
import { describe, expect, it } from "vitest";

import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";

function makeGraph(): TaskGraph {
  const node: TaskDependencyNode = {
    id: "t1",
    description: "任务一",
    status: "pending",
    dependsOn: [],
    taskType: "project",
    toolNames: ["project.read"],
    assignedAgentId: null,
    resultLocation: null,
  };
  return new TaskGraph([node]);
}

describe("TaskGraph 缺口分支", () => {
  it("assignAgent 任务不存在 → dependency-not-found", () => {
    const graph = makeGraph();
    expect(() => graph.assignAgent("ghost-task", "secondary-1")).toThrowError(
      /任务不存在/,
    );
  });

  it("transitionTo 任务不存在 → dependency-not-found（131）", () => {
    const graph = makeGraph();
    expect(() =>
      graph.markRunning("ghost-task"),
    ).toThrowError(/任务不存在/);
  });

  it("transitionTo 非法前置状态 → invalid-task-chain", () => {
    const graph = makeGraph();
    expect(() =>
      graph.markDone("t1", null),
    ).toThrowError(/非法状态迁移/);
  });
});
