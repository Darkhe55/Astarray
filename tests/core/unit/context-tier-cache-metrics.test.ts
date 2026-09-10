/**
 * T09A-06：分层缓存键/精确失效与生命周期指标复算。
 */
import { describe, expect, it } from "vitest";

import {
  ContextTierCache,
  buildContextCacheKey,
  shouldBypassContextCache,
} from "../../../packages/core/src/orchestration/context-tier-cache.js";
import type { ContextCacheKeyParts } from "../../../packages/core/src/orchestration/context-tier-cache.js";
import {
  classifyReopenReasonCode,
  computeContextLifecycleMetrics,
} from "../../../packages/core/src/orchestration/context-lifecycle-metrics.js";
import type { ContextLifecycleEvent } from "../../../packages/core/src/orchestration/context-lifecycle-metrics.js";

const globalBlockParts = (blockType: "architecture-decision" | "user-preference" = "architecture-decision"): ContextCacheKeyParts => ({
  tier: "global-decision-block",
  provider: "mock",
  model: "mock-1",
  policyIdentifier: "assist",
  blockType,
  globalContextRevision: 2,
  globalContextBudgetPolicyRevision: 1,
  blockContentHash: "block-hash",
});

const frontierParts = (agentInstanceId = "agent-a", revision = 3): ContextCacheKeyParts => ({
  tier: "active-frontier",
  agentInstanceId,
  missionId: "mission-1",
  taskIdentifier: "T-001",
  activeNodeIdentifiers: ["node-1"],
  openRequiredAncestorIdentifiers: [],
  contextGraphRevision: revision,
});

const capsuleParts = (nodeIdentifier = "node-1"): ContextCacheKeyParts => ({
  tier: "closure-capsule",
  contextNodeIdentifier: nodeIdentifier,
  closureRevision: 1,
  capsuleContentHash: "capsule-hash",
  relatedArtifactFingerprint: "commit:abc",
});

const recallParts = (agentInstanceId = "agent-a", nodeIdentifier = "node-1"): ContextCacheKeyParts => ({
  tier: "recall-result",
  agentInstanceId,
  taskIdentifier: "T-001",
  contextNodeIdentifier: nodeIdentifier,
  contextNodeRevision: 1,
  reasonCode: "capsule-insufficient",
  selectionStrategyIdentifier: "tiered-default",
  maximumTokenCount: 1000,
});

describe("分层缓存键与精确失效（T09A-06）", () => {
  it("键按层稳定且互不相同（字段顺序不影响哈希）", () => {
    const keyA = buildContextCacheKey(globalBlockParts());
    const reordered = { blockContentHash: "block-hash", ...globalBlockParts() } as ContextCacheKeyParts;
    expect(buildContextCacheKey(reordered)).toBe(keyA);
    expect(buildContextCacheKey(frontierParts())).not.toBe(
      buildContextCacheKey(frontierParts("agent-b")),
    );
  });

  it("写操作/授权/时间敏感/失败/任务结论一律 bypass", () => {
    expect(
      shouldBypassContextCache({
        isWriteOperation: true,
        isAuthorizationResult: false,
        isTimeSensitive: false,
        isFailedResult: false,
        isTaskExecutionConclusion: false,
      }),
    ).toBe(true);
    expect(
      shouldBypassContextCache({
        isWriteOperation: false,
        isAuthorizationResult: false,
        isTimeSensitive: false,
        isFailedResult: false,
        isTaskExecutionConclusion: false,
      }),
    ).toBe(false);
  });

  it("单块变化只失效该块；活跃局部变化不失效全局稳定块", () => {
    const cache = new ContextTierCache();
    cache.set(globalBlockParts("architecture-decision"), "arch", 10, "2026-09-09T00:00:00.000Z");
    cache.set(globalBlockParts("user-preference"), "pref", 10, "2026-09-09T00:00:00.000Z");
    cache.set(frontierParts(), "frontier", 10, "2026-09-09T00:00:00.000Z");
    const invalidated = cache.invalidate({
      tier: "global-decision-block",
      globalContextBlockType: "architecture-decision",
      globalContextRevision: 3,
    });
    expect(invalidated).toHaveLength(1);
    expect(cache.get(globalBlockParts("architecture-decision")).status).toBe("miss");
    expect(cache.get(globalBlockParts("user-preference")).status).toBe("hit");
    expect(cache.get(frontierParts()).status).toBe("hit");
  });

  it("个体隔离：不同 Agent 的活跃前沿/回访缓存互不失效", () => {
    const cache = new ContextTierCache();
    cache.set(frontierParts("agent-a"), "a", 10, "2026-09-09T00:00:00.000Z");
    cache.set(frontierParts("agent-b"), "b", 10, "2026-09-09T00:00:00.000Z");
    cache.set(recallParts("agent-a"), "ra", 10, "2026-09-09T00:00:00.000Z");
    const invalidated = cache.invalidate({ agentInstanceId: "agent-a" });
    expect(invalidated).toHaveLength(2);
    expect(cache.get(frontierParts("agent-b")).status).toBe("hit");
    expect(cache.get(capsuleParts()).status).toBe("miss");
  });

  it("胶囊按节点精确失效；stale-reject 计入统计", () => {
    const cache = new ContextTierCache();
    cache.set(capsuleParts("node-1"), "c1", 10, "2026-09-09T00:00:00.000Z");
    cache.set(capsuleParts("node-2"), "c2", 10, "2026-09-09T00:00:00.000Z");
    expect(cache.invalidate({ tier: "closure-capsule", contextNodeIdentifier: "node-1" })).toHaveLength(1);
    expect(cache.get(capsuleParts("node-2")).status).toBe("hit");
    expect(cache.staleReject(2, 2).status).toBe("hit");
    const stale = cache.staleReject(2, 3);
    expect(stale.status).toBe("stale-reject");
    expect(cache.getStats().staleRejectCount).toBe(1);
  });
});

describe("生命周期指标复算（T09A-06）", () => {
  const events: ContextLifecycleEvent[] = [
    {
      kind: "context-served",
      reusableTokenCount: 300,
      eligibleReusableTokenCount: 600,
      closedExcludedTokenCount: 400,
      candidateHistoryTokenCount: 1000,
    },
    { kind: "recall-request", reasonCode: "capsule-insufficient" },
    { kind: "recall-request", reasonCode: "capsule-insufficient" },
    { kind: "recall-served", wasRepeat: true, wasEffective: false, tier: "node-index" },
    { kind: "recall-served", wasRepeat: false, wasEffective: true, tier: "selected-evidence" },
    { kind: "closure", wasPremature: false },
    { kind: "closure", wasPremature: true },
    { kind: "reopen", reasonCode: "user-new-requirement" },
    { kind: "reopen", reasonCode: "capsule-insufficient" },
    { kind: "reopen", reasonCode: "human-rejection" },
    { kind: "global-promotion", isValid: true, estimatedTokenCount: 100 },
    { kind: "global-promotion", isValid: false, estimatedTokenCount: 50 },
    { kind: "global-budget-eviction", evictedTokenCount: 200, candidateGlobalTokenCount: 800 },
    { kind: "deferred-fragment-written" },
    { kind: "deferred-fragment-written" },
    { kind: "deferred-fragment-hit" },
    { kind: "wrong-relevance-injection" },
    { kind: "deferred-acceptance-rejected", downstreamNodeCount: 2, reworkTokenCount: 500, reworkTimeSeconds: 3600 },
  ];

  it("指标可复算且区分原因码（用户新需求不计入过早关闭）", () => {
    const metrics = computeContextLifecycleMetrics(events);
    const recomputed = computeContextLifecycleMetrics(events);
    expect(metrics).toEqual(recomputed);
    expect(metrics.reusableTokenRatio).toBeCloseTo(0.5);
    expect(metrics.closedContextTokenSavingRate).toBeCloseTo(0.4);
    expect(metrics.unchangedRevisionRepeatRecallRate).toBeCloseTo(0.5);
    expect(metrics.effectiveRecallRate).toBeCloseTo(0.5);
    expect(metrics.prematureClosureCount).toBe(2);
    expect(metrics.prematureClosureRate).toBeCloseTo(1);
    expect(metrics.reopensByClassification.legitimate).toBe(1);
    expect(metrics.reopensByClassification.defect).toBe(1);
    expect(metrics.reopensByClassification["human-rejection"]).toBe(1);
    expect(metrics.invalidGlobalPromotionRate).toBeCloseTo(0.5);
    expect(metrics.globalBudgetEvictionRate).toBeCloseTo(0.25);
    expect(metrics.deferredFragmentHitRate).toBeCloseTo(0.5);
    expect(metrics.wrongRelevanceInjectionCount).toBe(1);
    expect(metrics.deferredAcceptanceRejectionRate).toBeCloseTo(0.5);
    expect(metrics.downstreamImpactNodeCount).toBe(2);
    expect(metrics.downstreamReworkTokenCount).toBe(500);
    expect(metrics.downstreamReworkTimeSeconds).toBe(3600);
  });

  it("空事件集比率为 0 且原因码分类稳定", () => {
    const empty = computeContextLifecycleMetrics([]);
    expect(empty.reusableTokenRatio).toBe(0);
    expect(empty.prematureClosureRate).toBe(0);
    expect(empty.deferredFragmentHitRate).toBe(0);
    expect(classifyReopenReasonCode("user-new-requirement")).toBe("legitimate");
    expect(classifyReopenReasonCode("dependency-real-change")).toBe("legitimate");
    expect(classifyReopenReasonCode("human-rejection")).toBe("human-rejection");
    expect(classifyReopenReasonCode("global-decision-missing")).toBe("defect");
  });
  it("miss→set→hit 与统计 hitRate 计算", () => {
    const cache = new ContextTierCache();
    expect(cache.get(frontierParts()).status).toBe("miss");
    cache.set(frontierParts(), "value", 12, "2026-09-09T00:00:00.000Z");
    const hit = cache.get(frontierParts());
    expect(hit.status).toBe("hit");
    expect(hit.valueText).toBe("value");
    expect(cache.bypass().status).toBe("bypass");
    const stats = cache.getStats();
    expect(stats.hitCount).toBe(1);
    expect(stats.missCount).toBe(1);
    expect(stats.bypassCount).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
    expect(stats.entryCount).toBe(1);
  });

  it("bypass 判定：授权/时间敏感/失败/任务结论各自单独触发", () => {
    const base = {
      isWriteOperation: false,
      isAuthorizationResult: false,
      isTimeSensitive: false,
      isFailedResult: false,
      isTaskExecutionConclusion: false,
    };
    expect(shouldBypassContextCache({ ...base, isAuthorizationResult: true })).toBe(true);
    expect(shouldBypassContextCache({ ...base, isTimeSensitive: true })).toBe(true);
    expect(shouldBypassContextCache({ ...base, isFailedResult: true })).toBe(true);
    expect(shouldBypassContextCache({ ...base, isTaskExecutionConclusion: true })).toBe(true);
  });

  it("空缓存统计 hitRate 为 0 且条目为 0", () => {
    const cache = new ContextTierCache();
    const stats = cache.getStats();
    expect(stats.hitRate).toBe(0);
    expect(stats.entryCount).toBe(0);
    expect(cache.staleReject(1, 1).status).toBe("hit");
  });

  it("tier-only 过滤失效只移除该层；预算 revision 变化失效全局块", () => {
    const cache = new ContextTierCache();
    cache.set(recallParts("agent-a"), "ra", 10, "2026-09-09T00:00:00.000Z");
    cache.set(recallParts("agent-b"), "rb", 10, "2026-09-09T00:00:00.000Z");
    cache.set(globalBlockParts(), "block", 10, "2026-09-09T00:00:00.000Z");
    expect(cache.invalidate({ tier: "recall-result" })).toHaveLength(2);
    expect(cache.get(globalBlockParts()).status).toBe("hit");
    expect(
      cache.invalidate({
        tier: "global-decision-block",
        globalContextBudgetPolicyRevision: 1,
      }),
    ).toHaveLength(0);
    expect(
      cache.invalidate({
        tier: "global-decision-block",
        globalContextBudgetPolicyRevision: 2,
      }),
    ).toHaveLength(1);
  });

  it("四层键互不相同", () => {
    const keys = new Set([
      buildContextCacheKey(globalBlockParts()),
      buildContextCacheKey(frontierParts()),
      buildContextCacheKey(capsuleParts()),
      buildContextCacheKey(recallParts()),
    ]);
    expect(keys.size).toBe(4);
  });
  it("回访结果层按节点精确失效；活跃前沿按图 revision 相等/变化判定", () => {
    const cache = new ContextTierCache();
    cache.set(recallParts("agent-a", "node-1"), "r1", 5, "2026-09-09T00:00:00.000Z");
    cache.set(recallParts("agent-a", "node-2"), "r2", 5, "2026-09-09T00:00:00.000Z");
    cache.set(frontierParts("agent-a", 3), "f3", 5, "2026-09-09T00:00:00.000Z");
    expect(
      cache.invalidate({ tier: "recall-result", contextNodeIdentifier: "node-1" }),
    ).toHaveLength(1);
    expect(cache.get(recallParts("agent-a", "node-2")).status).toBe("hit");
    expect(
      cache.invalidate({ tier: "active-frontier", contextGraphRevision: 3 }),
    ).toHaveLength(0);
    expect(
      cache.invalidate({ tier: "active-frontier", contextGraphRevision: 4 }),
    ).toHaveLength(1);
  });
});


