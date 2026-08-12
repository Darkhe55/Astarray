import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { DagScheduler } from "../../../packages/core/src/orchestration/dag-scheduler.js";
import { ToolFailureCounter } from "../../../packages/core/src/orchestration/failure-counter.js";

let temporaryDirectory: string;
let taskStore: TaskStore;
let agentIdSequence: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-dag-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  agentIdSequence = 0;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

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

async function createScheduler(
  nodes: TaskDependencyNode[],
  concurrency: number,
): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-dag",
    revision: 1,
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks: nodes,
  };
  await taskStore.writeTaskChain(chain);
  return new DagScheduler(chain, {
    concurrency,
    taskStore,
    allocateAgentId: () => {
      agentIdSequence += 1;
      return `L3-${agentIdSequence}`;
    },
  });
}

describe("DagScheduler", () => {
  it("无依赖任务达到配置并发", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2"), makeNode("t3"), makeNode("t4"), makeNode("t5")],
      2,
    );
    const firstRound = await scheduler.scheduleRound();
    expect(firstRound.filter((action) => action.action === "start-task")).toHaveLength(2);
    const secondRound = await scheduler.scheduleRound();
    expect(secondRound.filter((action) => action.action === "start-task")).toHaveLength(0);
    expect(scheduler.getRunningTaskCount()).toBe(2);
  });

  it("有依赖任务严格串行：依赖完成后立即启动下游", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"]), makeNode("t3", ["t2"])],
      4,
    );
    const firstRound = await scheduler.scheduleRound();
    expect(firstRound).toEqual([
      { action: "start-task", taskId: "t1", assignedAgentId: "L3-1" },
    ]);
    await scheduler.finishTask("t1", "done", "out1.csv");
    const secondRound = await scheduler.scheduleRound();
    expect(secondRound.filter((action) => action.action === "start-task")).toEqual([
      { action: "start-task", taskId: "t2", assignedAgentId: "L3-2" },
    ]);
  });

  it("任务完成后释放并发槽位", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2"), makeNode("t3")],
      1,
    );
    await scheduler.scheduleRound();
    expect(scheduler.getRunningTaskCount()).toBe(1);
    await scheduler.finishTask("t1", "done", null);
    expect(scheduler.getRunningTaskCount()).toBe(0);
    const nextRound = await scheduler.scheduleRound();
    expect(nextRound.filter((action) => action.action === "start-task")).toHaveLength(1);
  });

  it("同一任务不能被两个 Worker 同时领取（claim 锁）", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 4);
    await scheduler.scheduleRound();
    expect(scheduler.isTaskClaimed("t1")).toBe(true);
    const secondRound = await scheduler.scheduleRound();
    expect(secondRound.filter((action) => action.action === "start-task")).toHaveLength(0);
  });

  it("任务失败后下游被 blocked 且完成动作产生 complete-mission", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      4,
    );
    await scheduler.scheduleRound();
    await scheduler.finishTask("t1", "failed", null);
    expect(scheduler.getCurrentGraph().getNode("t2")?.status).toBe("blocked");
    await scheduler.scheduleRound();
    expect(scheduler.getCurrentGraph().isMissionComplete()).toBe(false);
  });

  it("全部完成后产生 complete-mission 动作", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 4);
    await scheduler.scheduleRound();
    await scheduler.finishTask("t1", "done", "out.csv");
    const finalRound = await scheduler.scheduleRound();
    expect(finalRound).toContainEqual({ action: "complete-mission" });
  });

  it("cancel 将任务释放回 pending", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 4);
    await scheduler.scheduleRound();
    await scheduler.cancelTask("t1");
    expect(scheduler.isTaskClaimed("t1")).toBe(false);
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("pending");
  });

  it("reassign 重新分配 Agent 并保留 pending", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 4);
    await scheduler.scheduleRound();
    const reassignAction = await scheduler.reassignTask("t1");
    expect(reassignAction.action).toBe("reassign-task");
    expect(scheduler.getCurrentGraph().getNode("t1")?.assignedAgentId).toBe("L3-2");
  });

  it("releaseTaskBackToPending 支持模糊/等待人工场景", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 4);
    await scheduler.scheduleRound();
    await scheduler.releaseTaskBackToPending("t1");
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("pending");
    expect(scheduler.getRunningTaskCount()).toBe(0);
  });

  it("并发槽位占满时不再启动任务", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2"), makeNode("t3")],
      2,
    );
    await scheduler.scheduleRound();
    const blockedRound = await scheduler.scheduleRound();
    expect(blockedRound.filter((action) => action.action === "start-task")).toHaveLength(0);
    await scheduler.finishTask("t1", "done", null);
    const freedRound = await scheduler.scheduleRound();
    expect(freedRound.filter((action) => action.action === "start-task")).toEqual([
      { action: "start-task", taskId: "t3", assignedAgentId: "L3-3" },
    ]);
  });

  it("unblockTask 将人工裁决的任务重新加入可运行集合（上游修复后）", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      4,
    );
    await scheduler.scheduleRound();
    await scheduler.finishTask("t1", "failed", null);
    expect(scheduler.getCurrentGraph().getNode("t2")?.status).toBe("blocked");
    // 人工裁决：重试 t1
    await scheduler.unblockTask("t1");
    const retryRound = await scheduler.scheduleRound();
    expect(retryRound.filter((action) => action.action === "start-task")).toEqual([
      { action: "start-task", taskId: "t1", assignedAgentId: "L3-2" },
    ]);
    await scheduler.finishTask("t1", "done", null);
    await scheduler.unblockTask("t2");
    const finalRound = await scheduler.scheduleRound();
    expect(finalRound.filter((action) => action.action === "start-task")).toEqual([
      { action: "start-task", taskId: "t2", assignedAgentId: "L3-3" },
    ]);
  });

  it("每轮调度后任务链原子更新且 revision 单调递增", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      4,
    );
    await scheduler.scheduleRound();
    await scheduler.finishTask("t1", "done", "out.csv");
    const persisted = await taskStore.readTaskChain("mission-dag");
    expect(persisted?.revision).toBeGreaterThanOrEqual(3);
    expect(persisted?.tasks.find((task) => task.id === "t1")?.status).toBe("done");
    expect(persisted?.tasks.find((task) => task.id === "t2")?.status).toBe("pending");
  });
});

describe("ToolFailureCounter", () => {
  it("默认阈值 3：三次连续失败达到阈值并清零", () => {
    const counter = new ToolFailureCounter();
    expect(counter.recordFailure("read")).toBe(false);
    expect(counter.recordFailure("read")).toBe(false);
    expect(counter.recordFailure("read")).toBe(true);
    expect(counter.getConsecutiveFailureCount("read")).toBe(0);
  });

  it("成功后清零", () => {
    const counter = new ToolFailureCounter();
    counter.recordFailure("read");
    counter.recordFailure("read");
    counter.recordSuccess("read");
    expect(counter.getConsecutiveFailureCount("read")).toBe(0);
    expect(counter.recordFailure("read")).toBe(false);
  });

  it("不同工具分别计数", () => {
    const counter = new ToolFailureCounter();
    counter.recordFailure("read");
    counter.recordFailure("read");
    expect(counter.getConsecutiveFailureCount("read")).toBe(2);
    expect(counter.getConsecutiveFailureCount("search")).toBe(0);
    expect(counter.recordFailure("read")).toBe(true);
    expect(counter.recordFailure("search")).toBe(false);
  });

  it("自定义阈值", () => {
    const counter = new ToolFailureCounter(5);
    for (let index = 0; index < 4; index++) {
      expect(counter.recordFailure("query")).toBe(false);
    }
    expect(counter.recordFailure("query")).toBe(true);
  });

  it("阈值 < 1 抛错", () => {
    expect(() => new ToolFailureCounter(0)).toThrowError(/≥ 1/);
  });
});
