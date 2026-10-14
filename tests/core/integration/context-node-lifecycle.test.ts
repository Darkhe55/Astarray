/**
 * T09A-R1-03（第一部分）：产品任务生成真实上下文节点、胶囊与延迟核验任务。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextClosureCapsuleStore } from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-r1-03-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function listGraphOwners(): Promise<string[]> {
  const agentMemoryDirectory = path.join(stateDirectory, "agent-memory");
  try {
    return await fs.readdir(agentMemoryDirectory);
  } catch {
    return [];
  }
}

async function runMissionToTerminal(mode: "assist" | "devolve") {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode,
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode });
  await application.submitTask({
    sessionId: "session-1",
    taskIdentifier: "task-1",
    prompt: "上下文节点收口探针",
  });
  let status = "accepted";
  /**
   * 修（2026-11-05）：**不得在 30s 处"放弃等待"并返回非终态**。
   *
   * 实测证据：全量覆盖率运行下本用例耗时 **30_107ms**（= 恰好撞上原 30s 上限）并断言失败
   * `expected 'running' to be 'done'`；而**隔离复跑本文件仅 243–381ms**。
   * ⇒ 同一工作量在满载争用下被拖慢约 **80×**；产品侧没有问题，
   * 是**测试自己**用一个远低于其 `testTimeout`（60s）的硬上限**提前认输**。
   *
   * 现改为：把等待上界抬到**紧贴 `testTimeout` 之下**（55s），
   * 于是"真的卡住"会由 vitest 以 `Test timed out` 报出（明确、可归因），
   * 而不再是含糊的"状态断言失败"。**断言本身未放宽**：
   * 仍然要求最终必须到达终态，只是不再人为提前放弃。
   */
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
  }
  await application.shutdown();
  return status;
}

describe("T09A-R1-03：产品任务节点收口", () => {
  it("Devolve：关闭为 deferred-review-closed，生成胶囊与层级 1 延迟核验任务", async () => {
    const status = await runMissionToTerminal("devolve");
    // 失败时带上**实测状态**，避免只看到含糊的 expected 'running' to be 'done'
    expect(status, "任务未到达终态（实测 status=" + status + "）").toBe("done");

    const owners = await listGraphOwners();
    expect(owners.length).toBeGreaterThanOrEqual(1);
    const owner = owners[0]!;
    const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
    const graphs = await fs.readdir(
      path.join(stateDirectory, "agent-memory", owner, "context-graphs"),
    );
    const graph = await graphStore.readGraph(owner, graphs[0]!);
    expect(graph).not.toBeNull();
    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.nodes[0]?.state).toBe("deferred-review-closed");

    const capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: stateDirectory });
    const capsules = await capsuleStore.listCapsules(owner);
    expect(capsules).toHaveLength(1);
    expect(capsules[0]?.verificationState).toBe("deferred-review-closed");

    const deferredTaskPath = path.join(
      stateDirectory,
      "agent-memory",
      owner,
      "deferred-verification-tasks",
      "verify-T-001.json",
    );
    const deferredTask = JSON.parse(await fs.readFile(deferredTaskPath, "utf8")) as {
      priorityTier: number;
      contextNodeIdentifier: string;
    };
    expect(deferredTask.priorityTier).toBe(1);
    expect(deferredTask.contextNodeIdentifier).toBe(graph?.nodes[0]?.contextNodeIdentifier);
  });

  it("Assist：节点等待人工验收并生成 awaiting-user-acceptance 胶囊，不自动关闭、不生成延迟任务", async () => {
    const status = await runMissionToTerminal("assist");
    // 失败时带上**实测状态**（本条曾因"30s 提前放弃"报出含糊的 expected 'running' to be 'done'）
    expect(status, "任务未到达终态（实测 status=" + status + "）").toBe("done");

    const owners = await listGraphOwners();
    const owner = owners[0]!;
    const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
    const graphs = await fs.readdir(
      path.join(stateDirectory, "agent-memory", owner, "context-graphs"),
    );
    const graph = await graphStore.readGraph(owner, graphs[0]!);
    expect(graph?.nodes[0]?.state).toBe("awaiting-user-acceptance");

    const capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: stateDirectory });
    const capsules = await capsuleStore.listCapsules(owner);
    expect(capsules).toHaveLength(1);
    expect(capsules[0]?.verificationState).toBe("awaiting-user-acceptance");

    const deferredTasksDirectory = path.join(
      stateDirectory,
      "agent-memory",
      owner,
      "deferred-verification-tasks",
    );
    const deferredTaskFiles = await fs.readdir(deferredTasksDirectory).catch(() => []);
    expect(deferredTaskFiles).toHaveLength(0);
  });
});
