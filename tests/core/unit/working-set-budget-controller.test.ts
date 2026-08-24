/**
 * T07E-03 测试：字节/token 预算与活动集淘汰。
 * 验收：超大单文件受限；字节累计/token 估算；淘汰后任务链累计不清零；
 * 多维快照。
 */
import { describe, expect, it } from "vitest";

import { WorkingSetBudgetController } from "../../../packages/core/src/orchestration/working-set-budget-controller.js";
import { WorkingSetBudgetTracker } from "../../../packages/core/src/orchestration/working-set-budget-tracker.js";
import type { TokenEstimationPort } from "../../../packages/core/src/orchestration/working-set-budget-controller.js";

function makeController(options: {
  maxFiles?: number;
  maxSingleFileBytes?: number;
  maxTotalBytes?: number;
  tokenEstimator?: TokenEstimationPort;
} = {}) {
  const tracker = new WorkingSetBudgetTracker({
    canonicalIdentityPort: { canonicalize: async (filePath) => filePath },
    sensitivePathPort: { isSensitivePath: () => false },
    maximumDistinctProjectContentFilesPerAgentActivation: options.maxFiles ?? 10,
  });
  const controller = new WorkingSetBudgetController({
    budgetTracker: tracker,
    tokenEstimationPort: options.tokenEstimator ?? { estimateTokenCount: (b) => b / 4 },
    maximumSingleFileContentBytes: options.maxSingleFileBytes ?? 512 * 1024,
    maximumWorkingSetTotalBytes: options.maxTotalBytes ?? 4 * 1024 * 1024,
  });
  return { tracker, controller };
}

describe("WorkingSetBudgetController 字节/token 预算", () => {
  it("读取累计字节与 token 估算；文件数门禁仍生效", async () => {
    const { controller } = makeController();
    for (let index = 1; index <= 8; index++) {
      const outcome = await controller.attemptContentReadWithBudget({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: `src/b-${index}.ts`,
        contentBytes: 1000,
      });
      expect(outcome.decision === "allowed" || outcome.decision === "warned").toBe(true);
    }
    const snapshot = controller.getBudgetSnapshot({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
    });
    expect(snapshot.distinctProjectContentFileCount).toBe(8);
    expect(snapshot.modelVisibleProjectContentBytes).toBe(8000);
    expect(snapshot.estimatedProjectContentTokenCount).toBe(2000);
  });

  it("超大单文件（超单文件字节上限）→ 受限（超大文件需拆分）", async () => {
    const { controller } = makeController({
      maxSingleFileBytes: 1024,
    });
    await expect(
      controller.attemptContentReadWithBudget({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: "src/huge.ts",
        contentBytes: 2000,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("工作集累计字节超限 → 拒绝（不能仅提高文件上限而忽略超大文件）", async () => {
    const { controller } = makeController({
      maxTotalBytes: 3000,
    });
    await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/f1.ts",
      contentBytes: 2000,
    });
    const outcome = await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/f2.ts",
      contentBytes: 2000,
    });
    expect(outcome.decision).toBe("denied");
    if (outcome.decision === "denied") {
      expect(outcome.reason).toContain("累计字节超限");
    }
  });

  it("文件数门禁优先：第 11 个文件在读前拒绝（即使字节预算未满）", async () => {
    const { controller } = makeController({ maxFiles: 10 });
    for (let index = 1; index <= 10; index++) {
      await controller.attemptContentReadWithBudget({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: `src/x-${index}.ts`,
        contentBytes: 100,
      });
    }
    const eleventh = await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/x-11.ts",
      contentBytes: 100,
    });
    expect(eleventh.decision).toBe("denied");
  });
});

describe("WorkingSetBudgetController 活动集淘汰", () => {
  it("淘汰释放活动集；任务链累计来源不清零", async () => {
    const { controller, tracker } = makeController();
    await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/keep.ts",
      contentBytes: 100,
    });
    await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/evict.ts",
      contentBytes: 100,
    });
    const result = await controller.evictFromWorkingSet({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/evict.ts",
    });
    expect(result.evicted).toBe(true);
    // 任务链累计来源不清零（防淘汰绕过总读取量）
    expect(tracker.getTaskChainCumulativeSourceCount("chain-1")).toBe(2);
  });

  it("多维快照包含任务链累计来源数", async () => {
    const { controller } = makeController();
    await controller.attemptContentReadWithBudget({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/a.ts",
      contentBytes: 400,
    });
    const snapshot = controller.getBudgetSnapshot({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
    });
    expect(snapshot.taskChainCumulativeSourceCount).toBe(1);
    expect(snapshot.estimatedProjectContentTokenCount).toBe(100);
  });
});