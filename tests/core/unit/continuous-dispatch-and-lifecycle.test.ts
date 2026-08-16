/**
 * B6R-08 测试：持续调度与可恢复生命周期。
 * 覆盖：持续调度（ready set/优先级/并发准入排队暂停/非配额）、
 * 生命周期幂等（重复关闭不重跑/阶段持久化/崩溃恢复从未完成阶段继续/
 * hook 失败重试保留状态/上下文超限换新个体不继承）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";
import { SecondaryContinuousDispatchLoop } from "../../../packages/core/src/orchestration/secondary-continuous-dispatch-loop.js";
import {
  FileTertiaryLifecyclePhaseStore,
  TertiaryAgentLifecycleController,
} from "../../../packages/core/src/orchestration/tertiary-lifecycle.js";
import type { AgentTaskNode } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r08-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeNode(taskId: string, priorityTier: number, dependsOn: string[] = []): AgentTaskNode {
  return {
    taskId,
    title: `任务 ${taskId}`,
    dependsOn,
    sourceKind: "user",
    publisherId: "user-1",
    priorityTier,
    status: "pending",
    blockReason: null,
    externalReference: null,
    sequenceOrdinal: 1,
    createdAtIso: new Date().toISOString(),
  };
}

describe("SecondaryContinuousDispatchLoop", () => {
  it("按 ready set 派发（偏序：前驱完成后才派发后继）", async () => {
    const occupied = 0;
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 4,
      maxQueueLength: 2,
      currentOccupiedSlots: () => occupied,
    });
    const dispatched: string[] = [];
    const loop = new SecondaryContinuousDispatchLoop({
      registry,
      dispatchChain: async (chain) => {
        dispatched.push(...chain.taskIds);
        return true;
      },
      currentOccupiedSlots: () => occupied,
    });
    const nodes = [
      makeNode("T-001", 0),
      makeNode("T-002", 1, ["T-001"]),
    ];
    const firstRound = await loop.runRound({ nodes });
    expect(firstRound.dispatchedTaskIds).toEqual(["T-001"]);
    // 前驱完成后
    nodes[1] = { ...nodes[1]!, status: "pending" };
    nodes[0] = { ...nodes[0]!, status: "done" };
    const secondRound = await loop.runRound({ nodes });
    expect(secondRound.dispatchedTaskIds).toEqual(["T-002"]);
    expect(dispatched).toEqual(["T-001", "T-002"]);
  });

  it("并发准入：槽位满 → 排队/暂停（非数量配额）；释放后派发", async () => {
    let occupiedSlots = 1; // 槽位占用
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 1,
      maxQueueLength: 2,
      currentOccupiedSlots: () => occupiedSlots,
    });
    const dispatched: string[] = [];
    const loop = new SecondaryContinuousDispatchLoop({
      registry,
      dispatchChain: async (chain) => {
        dispatched.push(...chain.taskIds);
        return true;
      },
      currentOccupiedSlots: () => occupiedSlots,
    });
    const nodes = [makeNode("T-001", 0), makeNode("T-002", 1), makeNode("T-003", 2)];
    const result = await loop.runRound({ nodes });
    // 槽位满：前两个排队，第三个暂停
    expect(result.queuedCount).toBe(2);
    expect(result.pausedCount).toBe(1);
    expect(result.dispatchedTaskIds).toEqual([]);
    // 释放槽位 → 全部派发（排队/暂停实例随新轮重新准入）
    occupiedSlots = 0;
    const second = await loop.runRound({ nodes });
    expect(second.dispatchedTaskIds).toEqual(["T-001", "T-002", "T-003"]);
  });

  it("停止后不再派发；wake/等待有界", async () => {
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 4,
      maxQueueLength: 2,
      currentOccupiedSlots: () => 0,
    });
    const loop = new SecondaryContinuousDispatchLoop({
      registry,
      dispatchChain: async () => true,
      currentOccupiedSlots: () => 0,
    });
    loop.stop();
    const result = await loop.runRound({ nodes: [makeNode("T-001", 0)] });
    expect(result.dispatchedTaskIds).toEqual([]);
    await loop.waitForNextWake(10);
  });
});

describe("TertiaryAgentLifecycleController 幂等与恢复", () => {
  function makeHooks(trace: string[]) {
    return {
      stopDispatch: async () => {
        trace.push("stopDispatch");
      },
      drainUnconfirmedCalls: async () => {
        trace.push("drainUnconfirmedCalls");
      },
      persistCheckpoint: async () => {
        trace.push("persistCheckpoint");
        return "checkpoint-1";
      },
      writeHandoff: async () => {
        trace.push("writeHandoff");
        return "handoff-1";
      },
      confirmFeedback: async () => {
        trace.push("confirmFeedback");
      },
      revokePermissionLease: async () => {
        trace.push("revokePermissionLease");
      },
      unregisterMailbox: async () => {
        trace.push("unregisterMailbox");
      },
      handleGitResources: async () => {
        trace.push("handleGitResources");
      },
      terminateProcess: async () => {
        trace.push("terminateProcess");
      },
    };
  }

  it("完整收口：阶段顺序严格、检查点/handoff 引用、终态 closed", async () => {
    const trace: string[] = [];
    const controller = new TertiaryAgentLifecycleController(makeHooks(trace));
    const state = await controller.shutdown({ agentInstanceId: "tertiary-1" });
    expect(state.phase).toBe("closed");
    expect(state.checkpointId).toBe("checkpoint-1");
    expect(state.handoffReference).toBe("handoff-1");
    expect(trace).toEqual([
      "stopDispatch",
      "drainUnconfirmedCalls",
      "persistCheckpoint",
      "writeHandoff",
      "confirmFeedback",
      "revokePermissionLease",
      "unregisterMailbox",
      "handleGitResources",
      "terminateProcess",
    ]);
  });

  it("重复关闭不重跑（幂等：不重置为第一阶段、不重复副作用）", async () => {
    const trace: string[] = [];
    const controller = new TertiaryAgentLifecycleController(makeHooks(trace));
    await controller.shutdown({ agentInstanceId: "tertiary-1" });
    await controller.shutdown({ agentInstanceId: "tertiary-1" });
    // 第二次关闭：直接返回 closed，不重复执行阶段
    expect(trace.filter((entry) => entry === "terminateProcess")).toHaveLength(1);
  });

  it("持久化：崩溃后新实例 resume 从第一个未完成阶段继续（不重跑已完成阶段）", async () => {
    const phaseStore = new FileTertiaryLifecyclePhaseStore(temporaryDirectory);
    // 第一次收口在 revokePermissionLease 前崩溃（hook 抛错）
    const trace: string[] = [];
    const failingHooks = makeHooks(trace);
    failingHooks.revokePermissionLease = async () => {
      trace.push("revokePermissionLease");
      throw new Error("崩溃");
    };
    const firstController = new TertiaryAgentLifecycleController(failingHooks, {
      phaseStore,
    });
    await expect(
      firstController.shutdown({ agentInstanceId: "tertiary-1" }),
    ).rejects.toMatchObject({ errorCode: "tool-execution-failed" });
    // 新实例（重启）resume → 从 revokePermissionLease 继续
    const resumedController = new TertiaryAgentLifecycleController(makeHooks(trace), {
      phaseStore,
    });
    const resumedState = await resumedController.resume({ agentInstanceId: "tertiary-1" });
    expect(resumedState?.phase).toBe("revoking-permission-lease");
    const finalState = await resumedController.shutdown({ agentInstanceId: "tertiary-1" });
    expect(finalState.phase).toBe("closed");
    // 已完成阶段（stopDispatch..writeHandoff）不重跑
    expect(trace.filter((entry) => entry === "stopDispatch")).toHaveLength(1);
    expect(trace.filter((entry) => entry === "persistCheckpoint")).toHaveLength(1);
    expect(trace.filter((entry) => entry === "revokePermissionLease")).toHaveLength(2); // 失败 1 + 重试 1
    expect(trace.filter((entry) => entry === "terminateProcess")).toHaveLength(1);
  });

  it("持久化后新实例直接 shutdown 幂等（已 closed 不重跑）", async () => {
    const phaseStore = new FileTertiaryLifecyclePhaseStore(temporaryDirectory);
    const trace: string[] = [];
    const controller = new TertiaryAgentLifecycleController(makeHooks(trace), {
      phaseStore,
    });
    await controller.shutdown({ agentInstanceId: "tertiary-2" });
    // 新实例（模拟重启）
    const restarted = new TertiaryAgentLifecycleController(makeHooks(trace), {
      phaseStore,
    });
    const state = await restarted.shutdown({ agentInstanceId: "tertiary-2" });
    expect(state.phase).toBe("closed");
    expect(trace.filter((entry) => entry === "terminateProcess")).toHaveLength(1);
  });

  it("hook 失败重试：失败阶段保留状态可重试", async () => {
    const phaseStore = new FileTertiaryLifecyclePhaseStore(temporaryDirectory);
    const trace: string[] = [];
    const hooks = makeHooks(trace);
    let unregisterFails = true;
    hooks.unregisterMailbox = async () => {
      trace.push("unregisterMailbox");
      if (unregisterFails) {
        unregisterFails = false;
        throw new Error("mailbox 注销失败");
      }
    };
    const controller = new TertiaryAgentLifecycleController(hooks, { phaseStore });
    await expect(
      controller.shutdown({ agentInstanceId: "tertiary-3" }),
    ).rejects.toMatchObject({ errorCode: "tool-execution-failed" });
    expect(controller.getState()?.phase).toBe("unregistering-mailbox");
    // 重试（同一实例再次 shutdown）：已完成阶段不重跑
    const state = await controller.shutdown({ agentInstanceId: "tertiary-3" });
    expect(state.phase).toBe("closed");
    expect(trace.filter((entry) => entry === "unregisterMailbox")).toHaveLength(2);
    expect(trace.filter((entry) => entry === "stopDispatch")).toHaveLength(1);
  });

  it("上下文超限换新个体：新个体空白记忆不继承（仅收口状态独立）", async () => {
    const phaseStore = new FileTertiaryLifecyclePhaseStore(temporaryDirectory);
    const trace: string[] = [];
    // 旧个体收口
    await new TertiaryAgentLifecycleController(makeHooks(trace), {
      phaseStore,
    }).shutdown({ agentInstanceId: "tertiary-old" });
    // 新个体（不同 ID）：无持久化状态 → 全新收口（空白）
    const newTrace: string[] = [];
    const newController = new TertiaryAgentLifecycleController(makeHooks(newTrace), {
      phaseStore,
    });
    const resumed = await newController.resume({ agentInstanceId: "tertiary-new" });
    expect(resumed).toBeNull(); // 新个体无持久化状态
    const state = await newController.shutdown({ agentInstanceId: "tertiary-new" });
    expect(state.phase).toBe("closed");
    expect(newTrace).toHaveLength(9); // 全新收口 9 个阶段
  });
});
