/**
 * T12A-R1-03 测试：上下文事务恢复（部分提交后的重启对账与幂等重放）。
 * 验收：签字不跨 revision 复用；补充核验不重复、不丢失；预算不因重启清零；
 * 复放结果一致（胶囊/任务/图 revision 不重复膨胀）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextClosureCapsuleStore } from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import { ContextNodeLifecycleController } from "../../../packages/core/src/orchestration/context-node-lifecycle.js";
import { ContextTransactionRecoveryService } from "../../../packages/core/src/orchestration/context-transaction-recovery.js";
import { GlobalContextBudgetStore } from "../../../packages/core/src/orchestration/global-context-budget-store.js";
import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";
import {
  deferUnselectedGlobalDecisions,
  readDeferredGlobalContextFragments,
} from "../../../packages/core/src/orchestration/global-decision-selector.js";
import {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "../../../packages/core/src/orchestration/human-verification-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12ar1-03-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const ownerAgentInstanceId = "tertiary-1";
const missionId = "mission-ctx";
const taskIdentifier = "T-100";
const taskDescription = "上下文事务恢复探针";
const summaryText = "任务完成摘要";

function buildStores() {
  const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
  const capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: stateDirectory });
  const humanVerificationController = new HumanVerificationController({
    baseDirectory: stateDirectory,
    graphStore,
  });
  const humanVerificationPolicyStore = new HumanVerificationPolicyStore({
    baseDirectory: stateDirectory,
  });
  const lifecycle = new ContextNodeLifecycleController({
    graphStore,
    capsuleStore,
    humanVerificationController,
    humanVerificationPolicyStore,
  });
  const recovery = new ContextTransactionRecoveryService({
    graphStore,
    capsuleStore,
    humanVerificationController,
    humanVerificationPolicyStore,
    baseDirectory: stateDirectory,
  });
  return {
    graphStore,
    capsuleStore,
    humanVerificationController,
    humanVerificationPolicyStore,
    lifecycle,
    recovery,
  };
}

const inspectionInput = {
  ownerAgentInstanceId,
  missionId,
  taskIdentifier,
  taskDescription,
  modeKey: "devolve",
};

const replayInput = {
  ...inspectionInput,
  summaryText,
};

describe("上下文事务部分提交：崩溃点重放", () => {
  it("关闭已提交但胶囊未写入 → 重放补齐胶囊，图 revision 不膨胀且复放一致", async () => {
    const { graphStore, capsuleStore, lifecycle, recovery } = buildStores();
    const begun = await lifecycle.beginTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
    });
    await lifecycle.markTaskNodeVerified({
      ownerAgentInstanceId,
      missionId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
    });
    const closedGraph = await graphStore.closeNode({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      targetState: "deferred-review-closed",
    });
    const terminalRevision = closedGraph.revision;

    const before = await recovery.inspect(inspectionInput);
    expect(before.isComplete).toBe(false);
    expect(before.missingPieces).toContain("closure-capsule");
    expect(before.nodeState).toBe("deferred-review-closed");

    const firstReplay = await recovery.replay(replayInput);
    expect(firstReplay.inspection.isComplete).toBe(true);
    expect(firstReplay.replayedActions).toContain("closure-capsule");
    expect(firstReplay.inspection.capsule?.contextGraphRevision).toBe(terminalRevision);
    expect(
      (await graphStore.readGraph(ownerAgentInstanceId, missionId))?.revision,
    ).toBe(terminalRevision);

    const secondReplay = await recovery.replay(replayInput);
    expect(secondReplay.replayedActions).toEqual([]);
    expect(
      (await capsuleStore.listCapsules(ownerAgentInstanceId)).filter(
        (capsule) => capsule.contextNodeIdentifier === begun.contextNodeIdentifier,
      ),
    ).toHaveLength(1);
    expect(
      (await graphStore.readGraph(ownerAgentInstanceId, missionId))?.revision,
    ).toBe(terminalRevision);
  });

  it("胶囊已提交但补充核验任务未写入 → 重放补齐任务且不重复", async () => {
    const { graphStore, capsuleStore, lifecycle, humanVerificationController, recovery } =
      buildStores();
    const begun = await lifecycle.beginTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
    });
    await lifecycle.markTaskNodeVerified({
      ownerAgentInstanceId,
      missionId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
    });
    const closedGraph = await graphStore.closeNode({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      targetState: "deferred-review-closed",
    });
    const capsule = await capsuleStore.createCapsule({
      capsuleIdentifier: `capsule-${begun.contextNodeIdentifier}-${closedGraph.revision}`,
      ownerAgentInstanceId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      missionId,
      contextGraphRevision: closedGraph.revision,
      finalDecisionSummary: summaryText,
      inputSummary: taskDescription,
      outputSummary: summaryText,
      verificationState: "deferred-review-closed",
      informationSource: { sourceType: "agent", agentInstanceId: ownerAgentInstanceId },
      reopenCondition: "用户否决或依赖真实变化时重开该节点",
    });

    const before = await recovery.inspect(inspectionInput);
    expect(before.missingPieces).toContain("deferred-verification-task");
    expect(before.capsule?.capsuleIdentifier).toBe(capsule.capsuleIdentifier);

    const firstReplay = await recovery.replay(replayInput);
    expect(firstReplay.inspection.isComplete).toBe(true);
    expect(firstReplay.replayedActions).toContain("deferred-verification-task");
    const tasks = await humanVerificationController.listDeferredVerificationTasks(
      ownerAgentInstanceId,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.closureCapsuleHash).toBe(capsule.contentHash);
    expect(tasks[0]?.contextGraphRevision).toBe(closedGraph.revision);

    await recovery.replay(replayInput);
    expect(
      await humanVerificationController.listDeferredVerificationTasks(ownerAgentInstanceId),
    ).toHaveLength(1);
  });
});

describe("上下文事务部分提交：旧产物不丢失", () => {
  it("重开后再关闭：旧胶囊与旧补充任务保留，新 revision 形成新产物", async () => {
    const {
      graphStore,
      capsuleStore,
      humanVerificationController,
      lifecycle,
      recovery,
    } = buildStores();
    const first = await lifecycle.completeTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
      summaryText: "第一轮完成",
      modeKey: "devolve",
    });
    expect(first.deferredVerificationTask).not.toBeNull();

    const reopened = await graphStore.reopenNode({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: first.contextNodeIdentifier,
    });
    const second = await recovery.replay({
      ...replayInput,
      summaryText: "第二轮完成",
    });
    expect(second.inspection.isComplete).toBe(true);
    expect(second.inspection.graphRevision).toBeGreaterThanOrEqual(reopened.revision);

    const capsules = (
      await capsuleStore.listCapsules(ownerAgentInstanceId)
    ).filter((capsule) => capsule.contextNodeIdentifier === first.contextNodeIdentifier);
    expect(capsules).toHaveLength(2);
    const tasks = await humanVerificationController.listDeferredVerificationTasks(
      ownerAgentInstanceId,
    );
    expect(tasks).toHaveLength(2);
    const taskCapsuleHashes = tasks.map((task) => task.closureCapsuleHash);
    for (const capsule of capsules) {
      expect(taskCapsuleHashes).toContain(capsule.contentHash);
    }
  });

  it("延后片段在重放过程中不丢失", async () => {
    const { recovery, lifecycle, graphStore } = buildStores();
    const decisionStore = new GlobalDecisionStore({ baseDirectory: stateDirectory });
    await decisionStore.promoteCandidate({
      decisionSummary: "DELAYED-CTX",
      keyRationale: "预算不足时延后",
      appliesToScope: taskIdentifier,
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    const records = await decisionStore.listRecords();
    const begun = await lifecycle.beginTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
    });
    await deferUnselectedGlobalDecisions({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId,
      missionId,
      sourceContextNodeIdentifier: begun.contextNodeIdentifier,
      sourceNodeRevision: begun.graphRevision,
      decisions: records,
    });
    await lifecycle.markTaskNodeVerified({
      ownerAgentInstanceId,
      missionId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
    });
    await graphStore.closeNode({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      targetState: "deferred-review-closed",
    });

    await recovery.replay(replayInput);
    const fragments = await readDeferredGlobalContextFragments({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId,
    });
    expect(fragments).toHaveLength(records.length);
    expect(fragments[0]?.sourceNodeRevision).toBe(begun.graphRevision);
  });
});

describe("上下文事务部分提交：签字与预算", () => {
  it("陈旧签字不跨 revision 复用", async () => {
    const { graphStore, lifecycle, humanVerificationController } = buildStores();
    const completed = await lifecycle.completeTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
      summaryText,
      modeKey: "assist",
    });
    await humanVerificationController.recordUserAcceptance({
      ownerAgentInstanceId,
      contextGraphRevision: completed.graphRevision,
      currentContextGraphRevision: completed.graphRevision,
      nodeIdentifiers: [completed.contextNodeIdentifier],
      summaryHash: completed.capsule.contentHash,
      userId: "user-1",
    });
    // 图 revision 前进（例如新增分支/节点状态再次变化）后，旧签字必须失效
    const bumpedRevision = await graphStore.markNodeState({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: completed.contextNodeIdentifier,
      state: "awaiting-user-acceptance",
    });
    expect(bumpedRevision.revision).toBeGreaterThan(completed.graphRevision);
    await expect(
      humanVerificationController.recordUserAcceptance({
        ownerAgentInstanceId,
        contextGraphRevision: completed.graphRevision,
        currentContextGraphRevision: bumpedRevision.revision,
        nodeIdentifiers: [completed.contextNodeIdentifier],
        summaryHash: completed.capsule.contentHash,
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("重放不重置全局上下文预算策略 revision", async () => {
    const { recovery, lifecycle, graphStore } = buildStores();
    const budgetStore = new GlobalContextBudgetStore({ baseDirectory: stateDirectory });
    await budgetStore.updatePolicy({
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 8192,
      updatedByUserId: "user-1",
    });
    const begun = await lifecycle.beginTaskNode({
      ownerAgentInstanceId,
      missionId,
      taskIdentifier,
      taskDescription,
    });
    await lifecycle.markTaskNodeVerified({
      ownerAgentInstanceId,
      missionId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
    });
    await graphStore.closeNode({
      ownerAgentInstanceId,
      graphIdentifier: missionId,
      expectedGraphRevision: (await graphStore.readGraph(ownerAgentInstanceId, missionId))!
        .revision,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      targetState: "deferred-review-closed",
    });

    await recovery.replay(replayInput);
    const policy = await budgetStore.readPolicy();
    expect(policy.configuredMaximumGlobalContextTokenCount).toBe(8192);
    expect(policy.globalContextBudgetPolicyRevision).toBe(2);
  });
});
