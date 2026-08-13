/**
 * T05C 单测：任务包规划器分支覆盖（ADR-0013 §任务包）。
 * 直接构造序列文档测试 planner 各拒绝分支。
 */
import { describe, expect, it } from "vitest";

import type {
  AgentTaskNode,
  AgentTaskSequenceDocument,
} from "../../../packages/core/src/core/types.js";
import { TaskBundlePlanner } from "../../../packages/core/src/orchestration/task-bundle-planner.js";

const planner = new TaskBundlePlanner();

function buildNode(
  taskId: string,
  options: Partial<AgentTaskNode> = {},
): AgentTaskNode {
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
    sequenceOrdinal: 1,
    createdAtIso: new Date().toISOString(),
    ...options,
  };
}

function buildSequence(nodes: AgentTaskNode[]): AgentTaskSequenceDocument {
  return {
    schemaVersion: 1,
    sequenceId: "seq-1",
    ownerAgentInstanceId: "owner-1",
    revision: 3,
    updatedAtIso: new Date().toISOString(),
    nodes,
    bundles: [],
    auditEntries: [],
  };
}

describe("TaskBundlePlanner 拒绝分支", () => {
  it("空任务包拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([buildNode("t1")]),
        taskIds: [],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: null,
      }),
    ).toThrowError(/不能为空/);
  });

  it("包含未知任务拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([buildNode("t1")]),
        taskIds: ["t1", "ghost"],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: null,
      }),
    ).toThrowError(/未知任务/);
  });

  it("重复任务拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([buildNode("t1")]),
        taskIds: ["t1", "t1"],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: null,
      }),
    ).toThrowError(/不能重复/);
  });

  it("打包方指定层级与包内节点不一致拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([buildNode("t1", { priorityTier: 1 })]),
        taskIds: ["t1"],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: 0,
      }),
    ).toThrowError(/不一致/);
  });

  it("首节点非 pending 拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([
          buildNode("t1", { status: "done" }),
          buildNode("t2", { dependsOn: ["t1"] }),
        ]),
        taskIds: ["t1", "t2"],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: null,
      }),
    ).toThrowError(/pending/);
  });

  it("包内后继节点非 pending 拒绝", () => {
    expect(() =>
      planner.createBundle({
        sequence: buildSequence([
          buildNode("t1"),
          buildNode("t2", { dependsOn: ["t1"], status: "cancelled" }),
        ]),
        taskIds: ["t1", "t2"],
        boundAgentInstanceId: "agent-t1",
        requestedPriorityTier: null,
      }),
    ).toThrowError(/无法打包/);
  });

  it("合法链成功冻结，绑定序列 revision", () => {
    const sequence = buildSequence([
      buildNode("t1"),
      buildNode("t2", { dependsOn: ["t1"] }),
    ]);
    const bundleRecord = planner.createBundle({
      sequence,
      taskIds: ["t1", "t2"],
      boundAgentInstanceId: "agent-tertiary-1",
      requestedPriorityTier: 1,
    });
    expect(bundleRecord.boundAgentInstanceId).toBe("agent-tertiary-1");
    expect(bundleRecord.sequenceRevision).toBe(sequence.revision);
    expect(bundleRecord.taskIds).toEqual(["t1", "t2"]);
    expect(bundleRecord.status).toBe("prepared");
  });
});
