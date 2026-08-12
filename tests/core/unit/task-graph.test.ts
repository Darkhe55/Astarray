import { describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";

function makeNode(
  id: string,
  dependsOn: string[] = [],
  status: TaskDependencyNode["status"] = "pending",
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation: null,
  };
}

describe("TaskGraph", () => {
  it("构造合法 DAG", () => {
    const graph = new TaskGraph([makeNode("a"), makeNode("b", ["a"])]);
    expect(graph.getTaskIds().sort()).toEqual(["a", "b"]);
  });

  it("缺失依赖抛 dependency-not-found", () => {
    expect(() => new TaskGraph([makeNode("a", ["ghost"])])).toThrowError(
      /依赖不存在/,
    );
    try {
      new TaskGraph([makeNode("a", ["ghost"])]);
      throw new Error("应当抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).errorCode).toBe("dependency-not-found");
    }
  });

  it("环检测抛 dag-cycle", () => {
    expect(
      () => new TaskGraph([makeNode("a", ["b"]), makeNode("b", ["a"])]),
    ).toThrowError(/环/);
  });

  it("自环检测抛 dag-cycle", () => {
    expect(() => new TaskGraph([makeNode("a", ["a"])])).toThrowError(/环/);
  });

  it("重复任务 ID 抛 invalid-task-chain", () => {
    expect(
      () => new TaskGraph([makeNode("a"), makeNode("a")]),
    ).toThrowError(/重复/);
  });

  it("可运行任务：pending 且依赖全部 done", () => {
    const graph = new TaskGraph([makeNode("a"), makeNode("b", ["a"])]);
    expect(graph.findRunnableTaskIds()).toEqual(["a"]);
    graph.markRunning("a");
    graph.markDone("a", "out.csv");
    expect(graph.findRunnableTaskIds()).toEqual(["b"]);
  });

  it("依赖未完成时下游不可运行", () => {
    const graph = new TaskGraph([makeNode("a"), makeNode("b", ["a"])]);
    graph.markRunning("a");
    expect(graph.findRunnableTaskIds()).toEqual([]);
  });

  it("任务完成后立即重新计算可运行集合", () => {
    const graph = new TaskGraph([
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["a"]),
      makeNode("d", ["b", "c"]),
    ]);
    graph.markRunning("a");
    graph.markDone("a", null);
    const runnableAfterA = graph.findRunnableTaskIds();
    expect(runnableAfterA.sort()).toEqual(["b", "c"]);
    graph.markRunning("b");
    graph.markDone("b", null);
    graph.markRunning("c");
    graph.markDone("c", null);
    expect(graph.findRunnableTaskIds()).toEqual(["d"]);
  });

  it("isMissionComplete 全部 done 为真", () => {
    const graph = new TaskGraph([makeNode("a"), makeNode("b", ["a"])]);
    expect(graph.isMissionComplete()).toBe(false);
    graph.markRunning("a");
    graph.markDone("a", null);
    graph.markRunning("b");
    graph.markDone("b", null);
    expect(graph.isMissionComplete()).toBe(true);
  });

  it("失败传播：失败任务的下游 pending 任务被 blocked", () => {
    const graph = new TaskGraph([
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["a"]),
      makeNode("d"), // 无关任务不受影响
    ]);
    graph.markRunning("a");
    const blockedTaskIds = graph.propagateFailureToDownstream("a");
    expect(blockedTaskIds.sort()).toEqual(["b", "c"]);
    expect(graph.getNode("b")?.status).toBe("blocked");
    expect(graph.getNode("c")?.status).toBe("blocked");
    expect(graph.getNode("d")?.status).toBe("pending");
  });

  it("markPendingForRetry 将 failed/blocked 恢复为 pending 并清空指派", () => {
    const graph = new TaskGraph([makeNode("a")]);
    graph.markRunning("a");
    graph.markFailed("a");
    graph.markPendingForRetry("a");
    expect(graph.getNode("a")?.status).toBe("pending");
    expect(graph.getNode("a")?.assignedAgentId).toBeNull();
  });

  it("非法状态迁移抛错（如 done → running）", () => {
    const graph = new TaskGraph([makeNode("a")]);
    graph.markRunning("a");
    graph.markDone("a", null);
    expect(() => graph.markRunning("a")).toThrowError(/非法状态迁移/);
  });
});
