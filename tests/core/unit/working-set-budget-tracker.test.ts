/**
 * T07E-02 测试：规范资源计数与所有模型可见读取通道接入。
 * 验收：路径别名/大小写/符号链接归一不重复占槽；搜索/Git/归档旁路防护；
 * 敏感文件预算前拒绝；第 11 个文件读前拒绝。
 */
import { describe, expect, it } from "vitest";

import { WorkingSetBudgetTracker } from "../../../packages/core/src/orchestration/working-set-budget-tracker.js";
import type {
  CanonicalResourceIdentityPort,
  SensitivePathDetectionPort,
} from "../../../packages/core/src/orchestration/working-set-budget-tracker.js";

function makeTracker(options: {
  aliases?: Record<string, string>;
  sensitivePaths?: string[];
  maxFiles?: number;
} = {}) {
  const aliasMap = new Map(Object.entries(options.aliases ?? {}));
  const sensitiveSet = new Set(options.sensitivePaths ?? []);
  const canonicalIdentityPort: CanonicalResourceIdentityPort = {
    canonicalize: async (filePath) => aliasMap.get(filePath) ?? filePath,
  };
  const sensitivePathPort: SensitivePathDetectionPort = {
    isSensitivePath: (filePath) => sensitiveSet.has(filePath),
  };
  const tracker = new WorkingSetBudgetTracker({
    canonicalIdentityPort,
    sensitivePathPort,
    maximumDistinctProjectContentFilesPerAgentActivation: options.maxFiles ?? 10,
  });
  return { tracker };
}

describe("WorkingSetBudgetTracker 10 文件门禁", () => {
  it("同一 Agent 读 10 个不同文件成功；第 11 个读前拒绝", async () => {
    const { tracker } = makeTracker({ maxFiles: 10 });
    for (let index = 1; index <= 10; index++) {
      const outcome = await tracker.attemptContentRead({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: `src/file-${index}.ts`,
      });
      // 第 8 个文件触发提醒（warned）；其余 allowed
      expect(outcome.decision === "allowed" || outcome.decision === "warned").toBe(true);
    }
    const eleventh = await tracker.attemptContentRead({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/file-11.ts",
    });
    expect(eleventh.decision).toBe("denied");
    if (eleventh.decision === "denied") {
      expect(eleventh.reason).toContain("working-set-budget-reached");
    }
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(10);
  });

  it("8 文件提醒：达到阈值返回 warned（不增加模型调用）", async () => {
    const { tracker } = makeTracker();
    for (let index = 1; index <= 7; index++) {
      await tracker.attemptContentRead({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: `src/w-${index}.ts`,
      });
    }
    const eighth = await tracker.attemptContentRead({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/w-8.ts",
    });
    expect(eighth.decision).toBe("warned");
  });
});

describe("WorkingSetBudgetTracker 规范身份归一", () => {
  it("别名/大小写/符号链接归一：同一文件只占 1 槽", async () => {
    const { tracker } = makeTracker({
      aliases: {
        "src/A.ts": "src/a.ts",
        "/abs/src/a.ts": "src/a.ts",
        "link/src/a.ts": "src/a.ts",
      },
    });
    await tracker.attemptContentRead({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/a.ts",
    });
    const aliasOutcome = await tracker.attemptContentRead({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "src/A.ts",
    });
    expect(aliasOutcome.decision === "allowed" && aliasOutcome.isNewFile === false).toBe(
      true,
    );
    await tracker.attemptContentRead({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      filePath: "link/src/a.ts",
    });
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(1);
  });
});

describe("WorkingSetBudgetTracker 通道旁路防护", () => {
  it("搜索返回 11 个文件片段：只登记预算内结果（第 11 个拒绝并列出未读取）", async () => {
    const { tracker } = makeTracker();
    const outcomes = await tracker.registerSearchContentHits({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      sourceFilePaths: Array.from({ length: 11 }, (_, index) => `src/s-${index}.ts`),
    });
    expect(outcomes.decision).toBe("denied");
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(10);
  });

  it("Git diff/show 返回内容按来源文件占槽", async () => {
    const { tracker } = makeTracker();
    const outcome = await tracker.registerGitContentView({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      contentSourceFilePaths: ["src/g1.ts", "src/g2.ts"],
    });
    expect(outcome.decision).toBe("allowed");
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(2);
  });

  it("聚合无 manifest → fail-closed；有 manifest 按原文件分别计数", async () => {
    const { tracker } = makeTracker();
    await expect(
      tracker.registerAggregatedContent({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        manifest: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await tracker.registerAggregatedContent({
      agentInstanceId: "tertiary-1",
      taskChainIdentifier: "chain-1",
      manifest: {
        schemaVersion: 1,
        manifestIdentifier: "m-1",
        sourceFileCanonicalIdentities: ["src/a.ts", "src/b.ts", "src/c.ts"],
        contentHash: `sha256:${"a".repeat(64)}`,
        createdAtIso: "2026-08-19T00:00:00.000Z",
      },
    });
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(3);
  });
});

describe("WorkingSetBudgetTracker 敏感前置拒绝与治理文档", () => {
  it("敏感文件在预算判断前拒绝（不登记）", async () => {
    const { tracker } = makeTracker({ sensitivePaths: ["src/.env"] });
    await expect(
      tracker.attemptContentRead({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: "src/.env",
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(0);
  });

  it("治理文档独立预算：不挤占项目文件槽", async () => {
    const { tracker } = makeTracker({ maxFiles: 10 });
    for (let index = 1; index <= 10; index++) {
      await tracker.attemptContentRead({
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        filePath: `src/p-${index}.ts`,
      });
    }
    // 治理文档读取不受 10 文件门禁影响
    await tracker.registerGovernanceDocumentRead({ agentInstanceId: "tertiary-1" });
    await tracker.registerGovernanceDocumentRead({ agentInstanceId: "tertiary-1" });
    expect(tracker.getWorkingSetFileCount("tertiary-1")).toBe(10);
  });
});