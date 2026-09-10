/**
 * T09A-07：共用状态视图分组/文案/预算/脱敏保证。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { ContextClosureCapsuleStore } from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import {
  DEFERRED_REVIEW_VERIFICATION_LABEL,
  USER_ACCEPTED_VERIFICATION_LABEL,
  buildContextLifecycleStatusView,
} from "../../../packages/core/src/orchestration/context-lifecycle-status-view.js";

const HASH = "sha256:" + "a".repeat(64);
let temporaryDirectory: string;
let graphStore: LocalContextGraphStore;
let capsuleStore: ContextClosureCapsuleStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-view-"));
  graphStore = new LocalContextGraphStore({ baseDirectory: temporaryDirectory });
  capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: temporaryDirectory });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function createGraphWithStates() {
  await graphStore.createGraph({
    graphIdentifier: "graph-1",
    ownerAgentInstanceId: "agent-a",
    missionId: "mission-1",
  });
  await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 1,
    contextNodeIdentifier: "node-accepted",
    missionId: "mission-1",
    contentFingerprint: HASH,
    state: "locally-verified",
  });
  await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 2,
    contextNodeIdentifier: "node-deferred",
    missionId: "mission-1",
    contentFingerprint: HASH,
    state: "locally-verified",
  });
  await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 3,
    contextNodeIdentifier: "node-active",
    missionId: "mission-1",
    contentFingerprint: HASH,
  });
  await graphStore.closeNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 4,
    contextNodeIdentifier: "node-accepted",
    targetState: "accepted-closed",
  });
  await graphStore.closeNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 5,
    contextNodeIdentifier: "node-deferred",
    targetState: "deferred-review-closed",
  });
  return graphStore.readGraph("agent-a", "graph-1");
}

describe("上下文状态视图（T09A-07）", () => {
  it("按状态分组，并明确区分已验收与待追认文案", async () => {
    const graph = await createGraphWithStates();
    const capsule = await capsuleStore.createCapsule({
      capsuleIdentifier: "capsule-node-accepted-1",
      ownerAgentInstanceId: "agent-a",
      contextNodeIdentifier: "node-accepted",
      missionId: "mission-1",
      contextGraphRevision: 4,
      finalDecisionSummary: "已验收结论",
      inputSummary: "输入",
      outputSummary: "输出",
      verificationState: "accepted-closed",
      informationSource: { sourceType: "user", userId: "u-1" },
      reopenCondition: "否决",
    });
    expect(capsule.finalDecisionSummary).toBe("已验收结论");
    const view = buildContextLifecycleStatusView({
      agentInstanceId: "agent-a",
      graph,
      capsules: await capsuleStore.listCapsules("agent-a"),
      configuredMaximumGlobalContextTokenCount: 4096,
      effectiveMaximumGlobalContextTokenCount: 2048,
      budgetReductionReason: "Provider 空间不足",
      humanVerificationPolicy: "block-until-verified",
      metrics: { reusableTokenRatio: 0.5 },
    });
    expect(view.nodeGroups.acceptedClosed.map((node) => node.contextNodeIdentifier)).toEqual([
      "node-accepted",
    ]);
    expect(view.nodeGroups.deferredReviewClosed.map((node) => node.contextNodeIdentifier)).toEqual([
      "node-deferred",
    ]);
    expect(view.nodeGroups.deferredReviewClosed[0]?.verificationLabel).toBe(
      DEFERRED_REVIEW_VERIFICATION_LABEL,
    );
    expect(view.nodeGroups.deferredReviewClosed[0]?.isUserAccepted).toBe(false);
    expect(view.nodeGroups.acceptedClosed[0]?.verificationLabel).toBe(
      USER_ACCEPTED_VERIFICATION_LABEL,
    );
    expect(view.nodeGroups.acceptedClosed[0]?.isUserAccepted).toBe(true);
    expect(view.nodeGroups.active.map((node) => node.contextNodeIdentifier)).toEqual(["node-active"]);
  });

  it("其他 Agent 的胶囊不进入视图；不披露原始历史", async () => {
    const graph = await createGraphWithStates();
    await capsuleStore.createCapsule({
      capsuleIdentifier: "capsule-node-accepted-1",
      ownerAgentInstanceId: "agent-b",
      contextNodeIdentifier: "node-accepted",
      missionId: "mission-b",
      contextGraphRevision: 1,
      finalDecisionSummary: "其他 Agent 结论",
      inputSummary: "x",
      outputSummary: "y",
      verificationState: "accepted-closed",
      informationSource: { sourceType: "agent", agentInstanceId: "agent-b" },
      reopenCondition: "否决",
    });
    const view = buildContextLifecycleStatusView({
      agentInstanceId: "agent-a",
      graph,
      capsules: await capsuleStore.listCapsules("agent-b"),
      configuredMaximumGlobalContextTokenCount: 4096,
      effectiveMaximumGlobalContextTokenCount: 4096,
      budgetReductionReason: null,
      humanVerificationPolicy: "block-until-verified",
    });
    expect(
      view.nodeGroups.acceptedClosed[0]?.capsuleDecisionSummary,
    ).toBeNull();
    expect(view.disclosure).toEqual({
      includesOtherAgentContext: false,
      includesRawHistory: false,
    });
  });

  it("暴露配置/实际上限与缩减原因；无图时稳定降级", async () => {
    const view = buildContextLifecycleStatusView({
      agentInstanceId: "agent-a",
      graph: null,
      capsules: [],
      configuredMaximumGlobalContextTokenCount: 0,
      effectiveMaximumGlobalContextTokenCount: 0,
      budgetReductionReason: "用户设为 0",
      humanVerificationPolicy: "continue-with-deferred-review",
      metrics: { prematureClosureRate: 0 },
    });
    expect(view.graphIdentifier).toBeNull();
    expect(view.closedNodeCount).toBe(0);
    expect(view.tokenBudget).toEqual({
      configuredMaximumGlobalContextTokenCount: 0,
      effectiveMaximumGlobalContextTokenCount: 0,
      budgetReductionReason: "用户设为 0",
    });
    expect(view.metrics.prematureClosureRate).toBe(0);
  });
});
