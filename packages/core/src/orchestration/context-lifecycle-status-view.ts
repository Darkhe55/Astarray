/**
 * 上下文生命周期状态视图（T09A-07 / ADR-0031）。
 *
 * TUI / Headless CLI / 未来 GUI 共用同一只读 DTO：按状态分组展示节点，
 * 明确区分"用户已验收（accepted-closed）"与"待人工追认（deferred-review-closed）"，
 * 同时暴露配置上限与实际上限及缩减原因。视图不包含其他 Agent 上下文，
 * 也不包含原始历史正文，避免越权披露。
 */
import type {
  ContextClosureCapsule,
  HumanVerificationContinuationPolicy,
  LocalContextGraph,
  LocalContextGraphNode,
} from "./context-closure-schemas.js";

export interface ContextLifecycleMetricsSubset {
  reusableTokenRatio?: number;
  closedContextTokenSavingRate?: number;
  unchangedRevisionRepeatRecallRate?: number;
  effectiveRecallRate?: number;
  prematureClosureRate?: number;
  deferredAcceptanceRejectionRate?: number;
}

export interface ContextLifecycleStatusViewInput {
  agentInstanceId: string;
  graph: LocalContextGraph | null;
  capsules: ContextClosureCapsule[];
  configuredMaximumGlobalContextTokenCount: number | null;
  effectiveMaximumGlobalContextTokenCount: number | null;
  budgetReductionReason: string | null;
  humanVerificationPolicy: HumanVerificationContinuationPolicy | null;
  metrics?: ContextLifecycleMetricsSubset;
}

export interface ContextStatusNodeView {
  contextNodeIdentifier: string;
  state: LocalContextGraphNode["state"];
  openRequiredChildCount: number;
  verificationLabel: string;
  isUserAccepted: boolean;
  capsuleDecisionSummary: string | null;
}

export interface ContextLifecycleStatusView {
  agentInstanceId: string;
  graphIdentifier: string | null;
  graphRevision: number | null;
  nodeGroups: {
    acceptedClosed: ContextStatusNodeView[];
    deferredReviewClosed: ContextStatusNodeView[];
    awaitingUserAcceptance: ContextStatusNodeView[];
    active: ContextStatusNodeView[];
  };
  closedNodeCount: number;
  deferredReviewClosedCount: number;
  tokenBudget: {
    configuredMaximumGlobalContextTokenCount: number | null;
    effectiveMaximumGlobalContextTokenCount: number | null;
    budgetReductionReason: string | null;
  };
  humanVerificationPolicy: HumanVerificationContinuationPolicy | null;
  metrics: ContextLifecycleMetricsSubset;
  disclosure: {
    includesOtherAgentContext: false;
    includesRawHistory: false;
  };
}

export const DEFERRED_REVIEW_VERIFICATION_LABEL = "待人工追认（未获用户验收）";
export const USER_ACCEPTED_VERIFICATION_LABEL = "用户已验收";

export function buildContextLifecycleStatusView(
  input: ContextLifecycleStatusViewInput,
): ContextLifecycleStatusView {
  const capsuleByNodeIdentifier = new Map<string, ContextClosureCapsule>();
  for (const capsule of input.capsules) {
    if (capsule.agentInstanceId !== input.agentInstanceId) {
      continue;
    }
    if (!capsuleByNodeIdentifier.has(capsule.contextNodeIdentifier)) {
      capsuleByNodeIdentifier.set(capsule.contextNodeIdentifier, capsule);
    }
  }

  const nodeGroups: ContextLifecycleStatusView["nodeGroups"] = {
    acceptedClosed: [],
    deferredReviewClosed: [],
    awaitingUserAcceptance: [],
    active: [],
  };
  for (const node of input.graph?.nodes ?? []) {
    const view = buildNodeView(node, capsuleByNodeIdentifier);
    if (node.state === "accepted-closed") {
      nodeGroups.acceptedClosed.push(view);
    } else if (node.state === "deferred-review-closed") {
      nodeGroups.deferredReviewClosed.push(view);
    } else if (node.state === "awaiting-user-acceptance") {
      nodeGroups.awaitingUserAcceptance.push(view);
    } else if (node.state !== "superseded") {
      nodeGroups.active.push(view);
    }
  }
  for (const group of Object.values(nodeGroups)) {
    group.sort((left, right) =>
      left.contextNodeIdentifier.localeCompare(right.contextNodeIdentifier),
    );
  }

  return {
    agentInstanceId: input.agentInstanceId,
    graphIdentifier: input.graph?.graphIdentifier ?? null,
    graphRevision: input.graph?.revision ?? null,
    nodeGroups,
    closedNodeCount:
      nodeGroups.acceptedClosed.length + nodeGroups.deferredReviewClosed.length,
    deferredReviewClosedCount: nodeGroups.deferredReviewClosed.length,
    tokenBudget: {
      configuredMaximumGlobalContextTokenCount:
        input.configuredMaximumGlobalContextTokenCount,
      effectiveMaximumGlobalContextTokenCount:
        input.effectiveMaximumGlobalContextTokenCount,
      budgetReductionReason: input.budgetReductionReason,
    },
    humanVerificationPolicy: input.humanVerificationPolicy,
    metrics: input.metrics ?? {},
    disclosure: {
      includesOtherAgentContext: false,
      includesRawHistory: false,
    },
  };
}

function buildNodeView(
  node: LocalContextGraphNode,
  capsuleByNodeIdentifier: Map<string, ContextClosureCapsule>,
): ContextStatusNodeView {
  const capsule = capsuleByNodeIdentifier.get(node.contextNodeIdentifier) ?? null;
  const isUserAccepted = node.state === "accepted-closed";
  let verificationLabel: string;
  if (isUserAccepted) {
    verificationLabel = USER_ACCEPTED_VERIFICATION_LABEL;
  } else if (node.state === "deferred-review-closed") {
    verificationLabel = DEFERRED_REVIEW_VERIFICATION_LABEL;
  } else if (node.state === "awaiting-user-acceptance") {
    verificationLabel = "等待用户验收";
  } else if (node.state === "reopened") {
    verificationLabel = "已重新开放";
  } else if (node.state === "superseded") {
    verificationLabel = "已被替代";
  } else {
    verificationLabel = "进行中";
  }
  return {
    contextNodeIdentifier: node.contextNodeIdentifier,
    state: node.state,
    openRequiredChildCount: node.openRequiredChildCount,
    verificationLabel,
    isUserAccepted,
    capsuleDecisionSummary: capsule?.finalDecisionSummary ?? null,
  };
}
