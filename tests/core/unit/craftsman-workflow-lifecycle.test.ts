/**
 * T08D-05 测试：工匠工作流生命周期、已有工具约束与不同 Agent 验收。
 * 验收：安装/权限/自验反例；单链约束；bundle 由不同 Agent 验收。
 */
import { describe, expect, it } from "vitest";

import { CraftsmanWorkflowLifecycleController } from "../../../packages/core/src/orchestration/craftsman-workflow-lifecycle-controller.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    bundleId: "bundle-1",
    targetProblem: "重复的构建检查",
    applicableScope: "构建后静态检查",
    nonApplicableScope: "跨项目发布",
    repeatedWorkflowFingerprint: "fingerprint-1",
    usedToolReferences: [{ toolId: "project.read", toolRevision: 1 }],
    combinationSteps: ["扫描", "校验", "汇总"],
    permissionBoundarySummary: "仅只读工具",
    sensitiveDataBoundarySummary: "不读取敏感路径",
    backupAndIdempotencySummary: "写入前备份",
    failureRecoverySummary: "从检查点恢复",
    livelockBoundarySummary: "有界重试",
    artifactReferences: ["docs/workflows/check.md"],
    sourceAgentInstanceId: "tertiary-craftsman-1",
    boundTaskRevision: 2,
    contentHash: VALID_SHA256,
    dryRunOrMinimalExperimentSummary: "dry-run 验证通过",
    deterministicTestSummary: "3 项确定性测试",
    performanceComparisonSummary: "工具调用从 8 次降至 3 次",
    knownLimitations: ["仅适用于单仓"],
    compatibilityConditions: ["工具 revision >= 1"],
    invalidationConditions: ["工具 schema 变化"],
    version: 1,
    recommendedReviewMilestones: ["稳定化阶段"],
    createdAtIso: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeHarness(options: {
  availableTools?: string[];
  registeredCraftsman?: string[];
} = {}) {
  const availableTools = new Set(options.availableTools ?? ["project.read"]);
  const registeredCraftsman = new Set(
    options.registeredCraftsman ?? ["tertiary-craftsman-1"],
  );
  const controller = new CraftsmanWorkflowLifecycleController({
    toolAvailabilityPort: {
      isToolAvailable: async (toolId) => availableTools.has(toolId),
    },
    isRegisteredCraftsman: async (agentInstanceId) =>
      registeredCraftsman.has(agentInstanceId),
  });
  return { controller };
}

describe("CraftsmanWorkflowLifecycleController 工具约束", () => {
  it("bundle 引用工具全部已存在且已授权 → 接受", async () => {
    const { controller } = makeHarness();
    const result = await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-1",
      bundle: makeBundle(),
    });
    expect(result).toEqual({ outcome: "accepted", bundleId: "bundle-1" });
  });

  it("引用未授权/新工具 → blocked-with-dependency-gap（不授予安装）", async () => {
    const { controller } = makeHarness({
      availableTools: ["project.read"],
    });
    const result = await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-1",
      bundle: makeBundle({
        usedToolReferences: [
          { toolId: "project.read", toolRevision: 1 },
          { toolId: "network.fetch-new-dependency", toolRevision: 1 },
        ],
      }),
    });
    expect(result.outcome).toBe("blocked-with-dependency-gap");
    expect(
      (result as { missingToolReferences: string[] }).missingToolReferences,
    ).toContain("network.fetch-new-dependency");
  });

  it("未登记工匠提交 → 拒绝", async () => {
    const { controller } = makeHarness({
      registeredCraftsman: ["tertiary-craftsman-1"],
    });
    await expect(
      controller.submitWorkflowBundle({
        craftsmanAgentInstanceId: "attacker-craftsman",
        workflowChainId: "chain-1",
        bundle: makeBundle(),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("单链约束：同一工匠第二条链 → 拒绝；释放后可再提交", async () => {
    const { controller } = makeHarness();
    await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-1",
      bundle: makeBundle(),
    });
    await expect(
      controller.submitWorkflowBundle({
        craftsmanAgentInstanceId: "tertiary-craftsman-1",
        workflowChainId: "chain-2",
        bundle: makeBundle({ bundleId: "bundle-2" }),
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    controller.releaseWorkflowChain();
    const again = await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-2",
      bundle: makeBundle({ bundleId: "bundle-2" }),
    });
    expect(again.outcome).toBe("accepted");
  });
});

describe("CraftsmanWorkflowLifecycleController 不同 Agent 验收", () => {
  it("验收者与来源工匠相同 → 拒绝（作者自验被拒）", async () => {
    const { controller } = makeHarness();
    await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-1",
      bundle: makeBundle(),
    });
    await expect(
      controller.recordBundleAcceptance({
        bundleId: "bundle-1",
        bundleVersion: 1,
        bundleContentHash: VALID_SHA256,
        acceptingAgentInstanceId: "tertiary-craftsman-1",
        verdict: "accepted",
        reason: "自验",
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("不同 Agent 验收：接受后 isBundleAccepted=true（绑定版本/哈希）", async () => {
    const { controller } = makeHarness();
    await controller.submitWorkflowBundle({
      craftsmanAgentInstanceId: "tertiary-craftsman-1",
      workflowChainId: "chain-1",
      bundle: makeBundle(),
    });
    await controller.recordBundleAcceptance({
      bundleId: "bundle-1",
      bundleVersion: 1,
      bundleContentHash: VALID_SHA256,
      acceptingAgentInstanceId: "tertiary-acceptor-1",
      verdict: "accepted",
      reason: "确定性测试与 dry-run 通过",
    });
    expect(
      controller.isBundleAccepted({
        bundleId: "bundle-1",
        bundleVersion: 1,
        bundleContentHash: VALID_SHA256,
      }),
    ).toBe(true);
    // 版本/哈希变化 → 旧验收失效
    expect(
      controller.isBundleAccepted({
        bundleId: "bundle-1",
        bundleVersion: 2,
        bundleContentHash: VALID_SHA256,
      }),
    ).toBe(false);
  });

  it("验收不存在 bundle → 拒绝", async () => {
    const { controller } = makeHarness();
    await expect(
      controller.recordBundleAcceptance({
        bundleId: "ghost-bundle",
        bundleVersion: 1,
        bundleContentHash: VALID_SHA256,
        acceptingAgentInstanceId: "tertiary-acceptor-1",
        verdict: "accepted",
        reason: "x",
      }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
  });
});