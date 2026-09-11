/**
 * T09A-R1-04：指标由原始事件纯函数复算（版本/样本/分母/样本限制）。
 */
import { describe, expect, it } from "vitest";

import {
  CONTEXT_RUNTIME_METRICS_VERSION,
  computeContextRuntimeMetrics,
  type ContextAssemblyRuntimeEvent,
} from "../../../packages/core/src/orchestration/context-runtime-metrics.js";

function makeEvent(overrides: Partial<ContextAssemblyRuntimeEvent> = {}): ContextAssemblyRuntimeEvent {
  return {
    schemaVersion: 1,
    eventType: "context-assembly",
    recordedAtIso: "2026-09-10T00:00:00.000Z",
    missionId: "mission-1",
    agentInstanceId: "worker-1",
    taskIdentifier: "T-001",
    cacheStatus: "miss",
    invalidationReason: null,
    injectedGlobalDecisionCount: 1,
    injectedFrontierNodeCount: 1,
    excludedClosedNodeCount: 0,
    estimatedInjectedTokenCount: 100,
    budgetPolicyRevision: 1,
    effectiveBudgetTokens: 4096,
    ...overrides,
  };
}

describe("T09A-R1-04：运行时指标复算", () => {
  it("固定 fixture 复算：样本/分母/命中率/失效原因与样本限制", () => {
    const events = [
      makeEvent(),
      makeEvent({ cacheStatus: "hit" }),
      makeEvent({ cacheStatus: "miss", invalidationReason: "budget-policy-revision-change" }),
    ];
    const metrics = computeContextRuntimeMetrics({ assemblyEvents: events });

    expect(metrics.metricsVersion).toBe(CONTEXT_RUNTIME_METRICS_VERSION);
    expect(metrics.eventSchemaVersion).toBe(1);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.denominators).toEqual({
      assemblyEventCount: 3,
      hitCount: 1,
      missCount: 2,
      bypassCount: 0,
      staleRejectCount: 0,
    });
    expect(metrics.localCacheEstimate.hitRatio).toBeCloseTo(1 / 3);
    expect(metrics.localCacheEstimate.estimatedReusedTokenCount).toBe(100);
    expect(metrics.localCacheEstimate.estimatedInjectedTokenCount).toBe(300);
    expect(metrics.invalidationReasonCounts).toEqual({
      "budget-policy-revision-change": 1,
    });
    // Provider usage 未采集：不得用本地估算替代
    expect(metrics.providerCacheUsage.available).toBe(false);
    expect(metrics.providerCacheUsage.reason).toContain("未采集 Provider usage");
    // 样本不足：不得宣称百分比收益
    expect(metrics.percentageBenefitReportable).toBe(false);
    expect(metrics.percentageBenefitNote).toContain("样本不足");
  });

  it("同一 fixture 复算两次结果稳定（可复算）", () => {
    const events = [makeEvent({ cacheStatus: "hit" }), makeEvent()];
    const first = computeContextRuntimeMetrics({ assemblyEvents: events });
    const second = computeContextRuntimeMetrics({ assemblyEvents: events });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
