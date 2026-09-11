/**
 * 上下文运行时缓存/指标（T09A-R1-04）。
 *
 * - 原始事件来自真实装配与回访路径（JSONL 持久化），指标由事件纯函数复算；
 * - 本地缓存（选择/分层缓存）估算与 Provider 返回的 usage 严格区分；
 * - 样本/分母随指标一起输出；样本不足时明确标注不可比，不虚报性能。
 */
import {
  computeContextLifecycleMetrics,
  type ContextLifecycleEvent,
  type ContextLifecycleMetrics,
} from "./context-lifecycle-metrics.js";

export const CONTEXT_RUNTIME_METRICS_VERSION = 1;
export const MINIMUM_SAMPLE_SIZE_FOR_PERCENTAGE_BENEFIT = 10;

export type ContextAssemblyCacheStatus = "hit" | "miss" | "bypass" | "stale-reject";

export interface ContextAssemblyRuntimeEvent {
  schemaVersion: 1;
  eventType: "context-assembly";
  recordedAtIso: string;
  missionId: string;
  agentInstanceId: string;
  taskIdentifier: string;
  cacheStatus: ContextAssemblyCacheStatus;
  /** 失效原因（仅 miss/stale-reject 时给出，便于“精准失效”审计）。 */
  invalidationReason: string | null;
  injectedGlobalDecisionCount: number;
  injectedFrontierNodeCount: number;
  excludedClosedNodeCount: number;
  estimatedInjectedTokenCount: number;
  budgetPolicyRevision: number;
  effectiveBudgetTokens: number;
}

export interface ProviderCacheUsageObservation {
  available: boolean;
  /** Provider 返回的缓存命中 token（可用时）。 */
  cachedTokenCount: number | null;
  reason: string | null;
}

export interface ContextRuntimeMetrics {
  metricsVersion: number;
  eventSchemaVersion: number;
  sampleSize: number;
  denominators: {
    assemblyEventCount: number;
    hitCount: number;
    missCount: number;
    bypassCount: number;
    staleRejectCount: number;
  };
  localCacheEstimate: {
    hitRatio: number | null;
    estimatedReusedTokenCount: number;
    estimatedInjectedTokenCount: number;
  };
  invalidationReasonCounts: Record<string, number>;
  providerCacheUsage: ProviderCacheUsageObservation;
  lifecycleMetrics: ContextLifecycleMetrics | null;
  percentageBenefitReportable: boolean;
  percentageBenefitNote: string | null;
}

export function computeContextRuntimeMetrics(input: {
  assemblyEvents: ContextAssemblyRuntimeEvent[];
  lifecycleEvents?: ContextLifecycleEvent[];
  providerCacheUsage?: ProviderCacheUsageObservation;
}): ContextRuntimeMetrics {
  const events = input.assemblyEvents.filter(
    (event) => event.schemaVersion === 1 && event.eventType === "context-assembly",
  );
  const hitCount = events.filter((event) => event.cacheStatus === "hit").length;
  const missCount = events.filter((event) => event.cacheStatus === "miss").length;
  const bypassCount = events.filter((event) => event.cacheStatus === "bypass").length;
  const staleRejectCount = events.filter(
    (event) => event.cacheStatus === "stale-reject",
  ).length;
  const invalidationReasonCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.invalidationReason !== null) {
      invalidationReasonCounts[event.invalidationReason] =
        (invalidationReasonCounts[event.invalidationReason] ?? 0) + 1;
    }
  }
  const estimatedInjectedTokenCount = events.reduce(
    (total, event) => total + event.estimatedInjectedTokenCount,
    0,
  );
  const estimatedReusedTokenCount = events
    .filter((event) => event.cacheStatus === "hit")
    .reduce((total, event) => total + event.estimatedInjectedTokenCount, 0);
  const sampleSize = events.length;
  const percentageBenefitReportable =
    sampleSize >= MINIMUM_SAMPLE_SIZE_FOR_PERCENTAGE_BENEFIT;
  return {
    metricsVersion: CONTEXT_RUNTIME_METRICS_VERSION,
    eventSchemaVersion: 1,
    sampleSize,
    denominators: {
      assemblyEventCount: events.length,
      hitCount,
      missCount,
      bypassCount,
      staleRejectCount,
    },
    localCacheEstimate: {
      hitRatio: sampleSize === 0 ? null : hitCount / sampleSize,
      estimatedReusedTokenCount,
      estimatedInjectedTokenCount,
    },
    invalidationReasonCounts,
    providerCacheUsage: input.providerCacheUsage ?? {
      available: false,
      cachedTokenCount: null,
      reason: "本轮未采集 Provider usage（适配器未请求 usage 字段），不得用本地估算替代",
    },
    lifecycleMetrics:
      input.lifecycleEvents === undefined
        ? null
        : computeContextLifecycleMetrics(input.lifecycleEvents),
    percentageBenefitReportable,
    percentageBenefitNote: percentageBenefitReportable
      ? null
      : "样本不足（< " +
        MINIMUM_SAMPLE_SIZE_FOR_PERCENTAGE_BENEFIT +
        " 次装配事件）：命中率可观察，但不得据此宣称百分比收益",
  };
}
