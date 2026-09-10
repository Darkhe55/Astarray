/**
 * 上下文生命周期指标（T09A-06 / ADR-0031 §11.5-11.6）。
 *
 * 全部指标由追加事件纯函数复算（同事件集必得同结果），并区分原因码：
 * 用户新需求/依赖真实变化/人工否决不属于"过早关闭"缺陷类。
 * 除 hit/miss 外覆盖：可复用 token 比率、关闭上下文 token 节省率、
 * 关闭节点回访率、重复回访率、有效回访率、过早关闭率、全局提升与预算淘汰、
 * 延后片段命中、错误相关内容注入、延迟验收否决率与下游影响扩散。
 */
export type ContextReopenReasonCode =
  | "user-new-requirement"
  | "dependency-real-change"
  | "human-rejection"
  | "global-decision-missing"
  | "capsule-insufficient"
  | "model-repeat-request"
  | string;

export type ContextReopenClassification =
  | "legitimate"
  | "human-rejection"
  | "defect";

export type ContextLifecycleEvent =
  | { kind: "context-served"; reusableTokenCount: number; eligibleReusableTokenCount: number; closedExcludedTokenCount: number; candidateHistoryTokenCount: number }
  | { kind: "recall-request"; reasonCode: ContextReopenReasonCode }
  | { kind: "recall-served"; wasRepeat: boolean; wasEffective: boolean; tier: string }
  | { kind: "closure"; wasPremature: boolean }
  | { kind: "reopen"; reasonCode: ContextReopenReasonCode }
  | { kind: "global-promotion"; isValid: boolean; estimatedTokenCount: number }
  | { kind: "global-budget-eviction"; evictedTokenCount: number; candidateGlobalTokenCount: number }
  | { kind: "deferred-fragment-written" }
  | { kind: "deferred-fragment-hit" }
  | { kind: "wrong-relevance-injection" }
  | { kind: "deferred-acceptance-rejected"; downstreamNodeCount: number; reworkTokenCount: number; reworkTimeSeconds: number };

export interface ContextLifecycleMetrics {
  reusableTokenRatio: number;
  closedContextTokenSavingRate: number;
  recallRequestCount: number;
  unchangedRevisionRepeatRecallRate: number;
  effectiveRecallRate: number;
  closureCount: number;
  prematureClosureCount: number;
  prematureClosureRate: number;
  reopensByClassification: Record<ContextReopenClassification, number>;
  globalPromotionCount: number;
  invalidGlobalPromotionRate: number;
  globalBudgetEvictionRate: number;
  deferredFragmentWriteCount: number;
  deferredFragmentHitRate: number;
  wrongRelevanceInjectionCount: number;
  deferredAcceptanceRejectionCount: number;
  deferredAcceptanceRejectionRate: number;
  downstreamImpactNodeCount: number;
  downstreamReworkTokenCount: number;
  downstreamReworkTimeSeconds: number;
  deferredReviewClosureCount: number;
}

export function classifyReopenReasonCode(
  reasonCode: ContextReopenReasonCode,
): ContextReopenClassification {
  if (reasonCode === "user-new-requirement" || reasonCode === "dependency-real-change") {
    return "legitimate";
  }
  if (reasonCode === "human-rejection") {
    return "human-rejection";
  }
  return "defect";
}

export function computeContextLifecycleMetrics(
  events: readonly ContextLifecycleEvent[],
): ContextLifecycleMetrics {
  let reusableTokenCount = 0;
  let eligibleReusableTokenCount = 0;
  let closedExcludedTokenCount = 0;
  let candidateHistoryTokenCount = 0;
  let recallRequestCount = 0;
  let repeatRecallCount = 0;
  let effectiveRecallCount = 0;
  let closureCount = 0;
  let explicitPrematureClosureCount = 0;
  let globalPromotionCount = 0;
  let invalidGlobalPromotionCount = 0;
  let evictedTokenCount = 0;
  let candidateGlobalTokenCount = 0;
  let deferredFragmentWriteCount = 0;
  let deferredFragmentHitCount = 0;
  let wrongRelevanceInjectionCount = 0;
  let deferredAcceptanceRejectionCount = 0;
  let deferredReviewClosureCount = 0;
  let downstreamImpactNodeCount = 0;
  let downstreamReworkTokenCount = 0;
  let downstreamReworkTimeSeconds = 0;
  const reopensByClassification: Record<ContextReopenClassification, number> = {
    legitimate: 0,
    "human-rejection": 0,
    defect: 0,
  };

  for (const event of events) {
    switch (event.kind) {
      case "context-served":
        reusableTokenCount += event.reusableTokenCount;
        eligibleReusableTokenCount += event.eligibleReusableTokenCount;
        closedExcludedTokenCount += event.closedExcludedTokenCount;
        candidateHistoryTokenCount += event.candidateHistoryTokenCount;
        break;
      case "recall-request":
        recallRequestCount += 1;
        break;
      case "recall-served":
        if (event.wasRepeat) {
          repeatRecallCount += 1;
        }
        if (event.wasEffective) {
          effectiveRecallCount += 1;
        }
        break;
      case "closure":
        closureCount += 1;
        if (event.wasPremature) {
          explicitPrematureClosureCount += 1;
        }
        break;
      case "reopen":
        reopensByClassification[classifyReopenReasonCode(event.reasonCode)] += 1;
        break;
      case "global-promotion":
        globalPromotionCount += 1;
        if (!event.isValid) {
          invalidGlobalPromotionCount += 1;
        }
        break;
      case "global-budget-eviction":
        evictedTokenCount += event.evictedTokenCount;
        candidateGlobalTokenCount += event.candidateGlobalTokenCount;
        break;
      case "deferred-fragment-written":
        deferredFragmentWriteCount += 1;
        deferredReviewClosureCount += 1;
        break;
      case "deferred-fragment-hit":
        deferredFragmentHitCount += 1;
        break;
      case "wrong-relevance-injection":
        wrongRelevanceInjectionCount += 1;
        break;
      case "deferred-acceptance-rejected":
        deferredAcceptanceRejectionCount += 1;
        downstreamImpactNodeCount += event.downstreamNodeCount;
        downstreamReworkTokenCount += event.reworkTokenCount;
        downstreamReworkTimeSeconds += event.reworkTimeSeconds;
        break;
    }
  }

  const defectReopenCount = reopensByClassification.defect;
  const prematureClosureCount = explicitPrematureClosureCount + defectReopenCount;

  return {
    reusableTokenRatio: ratio(reusableTokenCount, eligibleReusableTokenCount),
    closedContextTokenSavingRate: ratio(closedExcludedTokenCount, candidateHistoryTokenCount),
    recallRequestCount,
    unchangedRevisionRepeatRecallRate: ratio(repeatRecallCount, recallRequestCount),
    effectiveRecallRate: ratio(effectiveRecallCount, recallRequestCount),
    closureCount,
    prematureClosureCount,
    prematureClosureRate: ratio(prematureClosureCount, closureCount),
    reopensByClassification,
    globalPromotionCount,
    invalidGlobalPromotionRate: ratio(invalidGlobalPromotionCount, globalPromotionCount),
    globalBudgetEvictionRate: ratio(evictedTokenCount, candidateGlobalTokenCount),
    deferredFragmentWriteCount,
    deferredFragmentHitRate: ratio(deferredFragmentHitCount, deferredFragmentWriteCount),
    wrongRelevanceInjectionCount,
    deferredAcceptanceRejectionCount,
    deferredAcceptanceRejectionRate: ratio(
      deferredAcceptanceRejectionCount,
      deferredReviewClosureCount,
    ),
    downstreamImpactNodeCount,
    downstreamReworkTokenCount,
    downstreamReworkTimeSeconds,
    deferredReviewClosureCount,
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}
