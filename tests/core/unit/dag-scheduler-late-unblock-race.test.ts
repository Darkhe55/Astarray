/**
 * 行为反例（2026-10-10 **Linux 平台证据发现**）：迟到的 `unblock` **不得降级正在运行的任务**。
 *
 * **缺陷现象**（WSL Ubuntu 26.04 上
 * `tests/tui/integration/authorization-retry-closure.test.ts` ① 确定性/间歇失败）：
 * 产物**已经落盘**，但任务被判 `blocked`，stderr 为
 * `非法状态迁移: T-001 pending → done`，随后
 * "需要权限的调用已阻断，但未能确认被请求的工具与参数：请人工检查并重新提交任务"。
 *
 * **竞态时序**（本文件钉住第 3–4 步）：
 *  1. 权限询问 ⇒ `blockTaskForHumanDecision`（节点 `blocked`，释放领取）；
 *  2. 用户批准 ⇒ CLI 发出 `unblock` 指令，但它**异步**送达 `AssistScheduler`；
 *  3. 调度循环**抢先**重新领取并 `markRunning`（节点 `running`）；
 *  4. **迟到的 `unblockTask` 看到节点不是 `pending`，就把它降回 `pending`** ← 缺陷；
 *  5. worker 成功 ⇒ `finishTask("done")`：领取存在、节点却 `pending`
 *     ⇒ `pending → done` 非法 ⇒ **成果被误判为 blocked**。
 *
 * 为什么 Windows 上没被发现：批准与重新领取的相对时序不同，第 4 步通常不会踩中；
 * 该用例在 Windows 上一直通过。
 *
 * **修法边界（重要）**：**不**放宽 `TaskGraph` 的状态机（`pending → done` 必须
 * 继续非法 —— 由 `tests/core/unit/task-graph-gaps.test.ts` 钉住），
 * 而是让 `unblockTask` 在任务**已在进行中/已终态**时**不做降级**。
 * 这是幂等化：迟到的重复 unblock 是**冗余指令**，不应产生状态变更。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  TaskChainDocument,
  TaskDependencyNode,
} from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { DagScheduler } from "../../../packages/core/src/orchestration/dag-scheduler.js";

let temporaryDirectory: string;
let taskStore: TaskStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-unblock-race-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeNode(
  id: string,
  status: TaskDependencyNode["status"] = "pending",
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation: null,
  };
}

async function createScheduler(nodes: TaskDependencyNode[]): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-unblock-race",
    revision: 1,
    updatedAtIso: "2026-10-10T00:00:00.000Z",
    tasks: nodes,
  };
  await taskStore.writeTaskChain(chain);
  let agentIdSequence = 0;
  return new DagScheduler(chain, {
    concurrency: 1,
    taskStore,
    allocateAgentId: () => {
      agentIdSequence += 1;
      return `L3-${agentIdSequence}`;
    },
  });
}

describe("DAG 调度：迟到的 unblock 不得降级正在运行的任务", () => {
  /** 创建一个**已被领取且 running**的调度器（等价于"worker 已启动"）。 */
  async function createSchedulerWithRunningClaimedTask(): Promise<DagScheduler> {
    const scheduler = await createScheduler([makeNode("t1")]);
    await scheduler.scheduleRound();
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("running");
    return scheduler;
  }

  it("① 任务**已 running 且被领取**时收到迟到 unblock ⇒ 必须保持 running", async () => {
    const scheduler = await createSchedulerWithRunningClaimedTask();

    // 权限询问把它 blocked、释放领取（这是正常路径）
    await scheduler.blockTaskForHumanDecision("t1");
    // 但**批准后的重跑**已经在进行中：等价于把它重新置为 running 并重新领取。
    // 这里直接构造该状态（`unblockTask` + 调度循环的组合在真实运行中会造成
    // "指令迟到"的窗口，本用例钉住该窗口内的不变量）。
    await scheduler.unblockTask("t1");
    await scheduler.scheduleRound();
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("running");

    // **迟到的** unblock 再次到达（CLI 的推进窗口会重复下发）
    await scheduler.unblockTask("t1");

    // **缺陷点**：修复前此处变成 "pending" ⇒ 后续 finishTask("done")
    // 抛 `非法状态迁移: t1 pending → done`，成果被误判为 blocked
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("running");
  });

  it("② 降级会直接导致成果无法结案（端到端复现 pending → done 非法）", async () => {
    const scheduler = await createSchedulerWithRunningClaimedTask();
    await scheduler.blockTaskForHumanDecision("t1");
    await scheduler.unblockTask("t1");
    await scheduler.scheduleRound();
    // 迟到的 unblock 把它降回 pending（缺陷）
    await scheduler.unblockTask("t1");

    // worker 成功回写：修复前会抛 invalid-task-chain ⇒ 成果无法结案
    await expect(
      scheduler.finishTask("t1", "done", "artifact.md"),
    ).resolves.toBeUndefined();
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("done");
  });

  it("③ blocked 时收到 unblock ⇒ 仍须恢复为 pending（原有语义不得丢失）", async () => {
    const scheduler = await createSchedulerWithRunningClaimedTask();
    await scheduler.blockTaskForHumanDecision("t1");

    // 批准后**尚未**被调度循环重新领取时，unblock 必须把它放回可运行集合
    await scheduler.unblockTask("t1");

    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("pending");
  });

  it("④ 已 done 的任务收到迟到 unblock ⇒ 必须保持 done（不得复活已结案任务）", async () => {
    const scheduler = await createScheduler([makeNode("t1")]);
    await scheduler.scheduleRound();
    await scheduler.finishTask("t1", "done", null);
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("done");

    await scheduler.unblockTask("t1");

    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("done");
  });

  it("⑤ pending 时收到 unblock ⇒ 幂等无操作（不得抛错）", async () => {
    const scheduler = await createScheduler([makeNode("t1")]);
    await expect(scheduler.unblockTask("t1")).resolves.toBeUndefined();
    expect(scheduler.getCurrentGraph().getNode("t1")?.status).toBe("pending");
  });
});
