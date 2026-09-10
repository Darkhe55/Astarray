/**
 * T09A-04：人工验收策略（默认值/切换/CAS/Ponder 禁止）、3 小时等待上限、
 * 签字 revision 绑定、延迟核验任务层级与个体隔离、事后否决返修。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HumanVerificationController,
  HumanVerificationPolicyStore,
  MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS,
} from "../../../packages/core/src/orchestration/human-verification-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";

const HASH = "sha256:" + "a".repeat(64);
const ISO = "2026-09-09T10:00:00.000Z";

let temporaryDirectory: string;
let policyStore: HumanVerificationPolicyStore;
let graphStore: LocalContextGraphStore;
let decisionStore: GlobalDecisionStore;
let controller: HumanVerificationController;
let nowMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-hv-"));
  nowMilliseconds = Date.parse(ISO);
  const clock = () => {
    nowMilliseconds += 1_000;
    return nowMilliseconds;
  };
  policyStore = new HumanVerificationPolicyStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: clock,
  });
  graphStore = new LocalContextGraphStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: clock,
  });
  decisionStore = new GlobalDecisionStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: clock,
  });
  controller = new HumanVerificationController({
    baseDirectory: temporaryDirectory,
    graphStore,
    globalDecisionStore: decisionStore,
    nowMilliseconds: clock,
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function createClosedNodeGraph() {
  await graphStore.createGraph({
    graphIdentifier: "graph-1",
    ownerAgentInstanceId: "agent-a",
    missionId: "mission-1",
  });
  await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 1,
    contextNodeIdentifier: "node-1",
    missionId: "mission-1",
    contentFingerprint: HASH,
    state: "locally-verified",
  });
  await graphStore.closeNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "graph-1",
    expectedGraphRevision: 2,
    contextNodeIdentifier: "node-1",
    targetState: "deferred-review-closed",
  });
}

describe("HumanVerificationPolicyStore（T09A-04）", () => {
  it("Assist 默认阻塞验收、Devolve 默认延迟核验", async () => {
    expect(await policyStore.getPolicy({ modeKey: "assist" })).toBe("block-until-verified");
    expect(await policyStore.getPolicy({ modeKey: "devolve" })).toBe(
      "continue-with-deferred-review",
    );
  });

  it("切换策略使用单调 revision CAS，陈旧 revision 拒绝", async () => {
    const updated = await policyStore.setPolicy({
      modeKey: "assist",
      policy: "continue-with-deferred-review",
      expectedPolicyRevision: 0,
      updatedByUserId: "u-1",
    });
    expect(updated.policyRevision).toBe(1);
    expect(await policyStore.getPolicy({ modeKey: "assist" })).toBe(
      "continue-with-deferred-review",
    );
    await expect(
      policyStore.setPolicy({
        modeKey: "assist",
        policy: "block-until-verified",
        expectedPolicyRevision: 0,
        updatedByUserId: "u-1",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("Ponder 不可切换；自定义模式必须显式默认值", async () => {
    await expect(policyStore.getPolicy({ modeKey: "ponder" })).rejects.toMatchObject({
      errorCode: "human-verification-policy-invalid",
    });
    await expect(
      policyStore.setPolicy({
        modeKey: "ponder",
        policy: "block-until-verified",
        expectedPolicyRevision: 0,
        updatedByUserId: "u-1",
      }),
    ).rejects.toMatchObject({ errorCode: "human-verification-policy-invalid" });
    await expect(policyStore.getPolicy({ modeKey: "custom:p1" })).rejects.toMatchObject({
      errorCode: "human-verification-policy-invalid",
    });
    expect(
      await policyStore.getPolicy({
        modeKey: "custom:p1",
        customProfileDefaultPolicy: "block-until-verified",
      }),
    ).toBe("block-until-verified");
  });
});

describe("HumanVerificationController（T09A-04）", () => {
  it("单次等待上限 3 小时：请求超过上限时按上限封顶", () => {
    const waitState = controller.beginAcceptanceWait({
      startIso: ISO,
      requestedWaitSeconds: 99_999,
    });
    expect(waitState.maximumWaitSeconds).toBe(MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS);
    expect(Date.parse(waitState.deadlineIso) - Date.parse(ISO)).toBe(
      MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS * 1000,
    );
  });

  it("超时保持等待且绝不自动通过", () => {
    const before = controller.evaluateAcceptanceTimeout({
      deadlineIso: ISO,
      nowIso: "2026-09-09T09:59:59.000Z",
    });
    expect(before.isTimedOut).toBe(false);
    expect(before.shouldAutoApprove).toBe(false);
    const after = controller.evaluateAcceptanceTimeout({
      deadlineIso: ISO,
      nowIso: "2026-09-09T10:00:01.000Z",
    });
    expect(after.isTimedOut).toBe(true);
    expect(after.state).toBe("awaiting-user-acceptance");
    expect(after.shouldAutoApprove).toBe(false);
  });

  it("用户签字绑定上下文图 revision；陈旧签字拒绝", async () => {
    const acceptance = await controller.recordUserAcceptance({
      ownerAgentInstanceId: "agent-a",
      contextGraphRevision: 3,
      currentContextGraphRevision: 3,
      nodeIdentifiers: ["node-1"],
      summaryHash: HASH,
      userId: "u-1",
    });
    expect(acceptance.contextGraphRevision).toBe(3);
    await expect(
      controller.recordUserAcceptance({
        ownerAgentInstanceId: "agent-a",
        contextGraphRevision: 2,
        currentContextGraphRevision: 3,
        nodeIdentifiers: ["node-1"],
        summaryHash: HASH,
        userId: "u-1",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("延迟核验任务：层级 ≤1、个体隔离落盘且 schema 合法", async () => {
    const task = await controller.createDeferredVerificationTask({
      taskIdentifier: "deferred-1",
      ownerAgentInstanceId: "agent-a",
      contextNodeIdentifier: "node-1",
      contextGraphRevision: 2,
      closureCapsuleHash: HASH,
      humanSteps: "核对提交与测试证据",
      priorityTier: 1,
      artifactOrCommitReferences: ["commit:abc"],
      automaticTestReferences: ["npm run check"],
      risks: ["人工体验未覆盖"],
    });
    expect(task.priorityTier).toBe(1);
    const filePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-a",
      "deferred-verification-tasks",
      "deferred-1.json",
    );
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      humanSteps: string;
    };
    expect(persisted.humanSteps).toBe("核对提交与测试证据");
    await expect(
      controller.createDeferredVerificationTask({
        taskIdentifier: "deferred-2",
        ownerAgentInstanceId: "agent-a",
        contextNodeIdentifier: "node-1",
        contextGraphRevision: 2,
        closureCapsuleHash: HASH,
        humanSteps: "越权层级",
        priorityTier: 2,
      }),
    ).rejects.toMatchObject({ errorCode: "human-verification-policy-invalid" });
  });

  it("事后否决：重开节点、相关全局决策转 disputed、返回层级 1 返修提案", async () => {
    await createClosedNodeGraph();
    const promoted = await decisionStore.promoteCandidate({
      decisionSummary: "关闭结论",
      keyRationale: "理由",
      appliesToScope: "scope-a",
      informationSource: { sourceType: "agent", agentInstanceId: "agent-a" },
      sourceRevision: 1,
      globalDecisionIdentifier: "gd-dispute",
    });
    expect(promoted.record.status).toBe("pending-human-review");

    const rejection = await controller.recordUserRejection({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      allNodeIdentifiers: ["node-1"],
      relatedGlobalDecisionIdentifiers: ["gd-dispute"],
      reason: "人工体验不通过",
    });
    expect(rejection.reopenedNodeIdentifiers).toEqual(["node-1"]);
    expect(rejection.disputedGlobalDecisionIdentifiers).toEqual(["gd-dispute"]);
    expect(rejection.reworkTaskProposal.priorityTier).toBe(1);
    expect(rejection.reworkTaskProposal.sourceKind).toBe("system");
    expect(await decisionStore.resolveStatusById("gd-dispute")).toBe("disputed");
    const graph = await graphStore.readGraph("agent-a", "graph-1");
    expect(graph?.nodes[0]?.state).toBe("reopened");
  });

  it("未装配图/决策存储时否决只返回提案（不抛错）", async () => {
    const bareController = new HumanVerificationController({
      baseDirectory: temporaryDirectory,
      nowMilliseconds: () => nowMilliseconds,
    });
    const rejection = await bareController.recordUserRejection({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-missing",
      allNodeIdentifiers: ["node-1"],
      reason: "仅提案",
    });
    expect(rejection.reopenedNodeIdentifiers).toEqual([]);
    expect(rejection.reworkTaskProposal.description).toContain("仅提案");
  });
});
