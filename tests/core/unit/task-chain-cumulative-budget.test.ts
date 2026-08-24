/**
 * T07E-04 测试：任务链累计预算、重启/handoff 保持与防分裂绕过。
 * 验收：新身份/续跑不清零；个体预算相互隔离；任务链累计上限拒绝；
 * 重启后持久化读取。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAXIMUM_TASK_CHAIN_CUMULATIVE_SOURCE_FILES,
  TaskChainCumulativeBudgetController,
} from "../../../packages/core/src/orchestration/task-chain-cumulative-budget.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07e04-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeController(options: { maxSources?: number } = {}) {
  return new TaskChainCumulativeBudgetController({
    stateBaseDirectory: temporaryDirectory,
    maximumTaskChainCumulativeSourceFiles:
      options.maxSources ?? DEFAULT_MAXIMUM_TASK_CHAIN_CUMULATIVE_SOURCE_FILES,
  });
}

describe("TaskChainCumulativeBudgetController 跨 Agent 累计", () => {
  it("多个 Agent 注册来源 → 任务链累计共享（防分裂绕过）", async () => {
    const controller = makeController();
    for (let index = 1; index <= 3; index++) {
      await controller.registerTaskChainSource({
        taskChainIdentifier: "chain-1",
        agentInstanceId: `tertiary-${index}`,
        canonicalSourceIdentity: `src/agent-${index}-file.ts`,
        contentBytes: 1000,
        estimatedTokenCount: 250,
      });
    }
    const snapshot = await controller.getBudgetSnapshot("chain-1");
    expect(snapshot?.cumulativeSourceFileCount).toBe(3);
    expect(snapshot?.participatingAgentInstanceIds).toEqual([
      "tertiary-1",
      "tertiary-2",
      "tertiary-3",
    ]);
  });

  it("重启/handoff：新实例读取持久化状态（任务链累计不清零）", async () => {
    const controller = makeController();
    await controller.registerTaskChainSource({
      taskChainIdentifier: "chain-1",
      agentInstanceId: "tertiary-1",
      canonicalSourceIdentity: "src/a.ts",
      contentBytes: 500,
      estimatedTokenCount: 125,
    });
    // 模拟重启：新实例（同一状态目录）
    const restartedController = makeController();
    await restartedController.registerTaskChainSource({
      taskChainIdentifier: "chain-1",
      agentInstanceId: "tertiary-2",
      canonicalSourceIdentity: "src/b.ts",
      contentBytes: 300,
      estimatedTokenCount: 75,
    });
    const snapshot = await restartedController.getBudgetSnapshot("chain-1");
    expect(snapshot?.cumulativeSourceFileCount).toBe(2);
    expect(snapshot?.cumulativeModelVisibleBytes).toBe(800);
    // handoff 后仍不清零
    const handoffController = makeController();
    const handoffSnapshot = await handoffController.getBudgetSnapshot("chain-1");
    expect(handoffSnapshot?.cumulativeSourceFileCount).toBe(2);
  });

  it("任务链累计上限 → 拒绝新来源（防无限创建 Agent 隐藏总读取量）", async () => {
    const controller = makeController({ maxSources: 3 });
    for (let index = 1; index <= 3; index++) {
      await controller.registerTaskChainSource({
        taskChainIdentifier: "chain-1",
        agentInstanceId: `tertiary-${index}`,
        canonicalSourceIdentity: `src/f-${index}.ts`,
        contentBytes: 100,
        estimatedTokenCount: 25,
      });
    }
    await expect(
      controller.registerTaskChainSource({
        taskChainIdentifier: "chain-1",
        agentInstanceId: "tertiary-4",
        canonicalSourceIdentity: "src/f-4.ts",
        contentBytes: 100,
        estimatedTokenCount: 25,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("同一来源重复注册不增加计数（累计按规范身份去重）", async () => {
    const controller = makeController();
    await controller.registerTaskChainSource({
      taskChainIdentifier: "chain-1",
      agentInstanceId: "tertiary-1",
      canonicalSourceIdentity: "src/same.ts",
      contentBytes: 100,
      estimatedTokenCount: 25,
    });
    await controller.registerTaskChainSource({
      taskChainIdentifier: "chain-1",
      agentInstanceId: "tertiary-2",
      canonicalSourceIdentity: "src/same.ts",
      contentBytes: 100,
      estimatedTokenCount: 25,
    });
    const snapshot = await controller.getBudgetSnapshot("chain-1");
    expect(snapshot?.cumulativeSourceFileCount).toBe(1);
  });

  it("未知任务链快照 → null", async () => {
    const controller = makeController();
    expect(await controller.getBudgetSnapshot("ghost-chain")).toBeNull();
  });
});