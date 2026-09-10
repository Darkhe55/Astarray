/**
 * T09A-05：关闭胶囊不可变性/哈希校验、活跃前沿逻辑排除、分级回访
 * （索引→胶囊→证据→有界片段）、冷却回执、任务预算、敏感拒绝、个体隔离。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContextClosureCapsuleStore,
  buildPromptActiveFrontier,
} from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import {
  ContextRecallController,
  estimateRecallTokenCount,
} from "../../../packages/core/src/orchestration/context-recall-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

const HASH = "sha256:" + "a".repeat(64);

let temporaryDirectory: string;
let capsuleStore: ContextClosureCapsuleStore;
let graphStore: LocalContextGraphStore;
let nowMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-recall-"));
  nowMilliseconds = 1_800_000_000_000;
  capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: temporaryDirectory });
  graphStore = new LocalContextGraphStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: () => nowMilliseconds,
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function createCapsule(owner = "agent-a", nodeIdentifier = "node-1", overrides: Record<string, unknown> = {}) {
  return capsuleStore.createCapsule({
    capsuleIdentifier: "capsule-" + nodeIdentifier + "-1",
    ownerAgentInstanceId: owner,
    contextNodeIdentifier: nodeIdentifier,
    missionId: "mission-1",
    contextGraphRevision: 1,
    finalDecisionSummary: "关闭结论",
    inputSummary: "输入摘要",
    outputSummary: "输出摘要",
    verificationState: "accepted-closed",
    artifactOrCommitReferences: ["commit:abc"],
    testEvidenceReferences: ["npm run check"],
    informationSource: { sourceType: "user", userId: "u-1" },
    unresolvedItems: [],
    reopenCondition: "人工否决",
    ...overrides,
  });
}

function buildRecallRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    requestId: "req-1",
    taskExecutionId: "task-exec-1",
    contextNodeIdentifier: "node-1",
    nodeRevision: 1,
    reasonCode: "capsule-insufficient",
    requiredInformation: "当时接口约束",
    maximumTokenCount: 10_000,
    ...overrides,
  };
}

function buildRecallController(options: Record<string, unknown> = {}) {
  return new ContextRecallController({
    capsuleStore,
    nowMilliseconds: () => nowMilliseconds,
    nodeIndexProvider: async (ownerAgentInstanceId: string) =>
      ownerAgentInstanceId === "agent-a"
        ? { missionId: "mission-1", state: "accepted-closed" }
        : null,
    ...options,
  });
}

describe("关闭胶囊与活跃前沿（T09A-05）", () => {
  it("胶囊不可变：重复写入拒绝；内容被篡改时哈希校验 fail-closed", async () => {
    await createCapsule();
    await expect(createCapsule()).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
    const filePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-a",
      "closure-capsules",
      "capsule-node-1-1.json",
    );
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    raw.outputSummary = "被篡改";
    await fs.writeFile(filePath, JSON.stringify(raw), "utf8");
    await expect(
      capsuleStore.readCapsule("agent-a", "capsule-node-1-1"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("胶囊按 agentInstanceId 隔离", async () => {
    await createCapsule("agent-a");
    expect(await capsuleStore.readCapsule("agent-b", "capsule-node-1-1")).toBeNull();
    expect(await capsuleStore.listCapsules("agent-b")).toHaveLength(0);
    expect(await capsuleStore.listCapsules("agent-a")).toHaveLength(1);
  });

  it("活跃前沿只含未关闭节点，关闭历史仅计数不注入", async () => {
    await graphStore.createGraph({
      graphIdentifier: "graph-1",
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
    });
    await graphStore.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 1,
      contextNodeIdentifier: "node-open",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    await graphStore.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-closed",
      missionId: "mission-1",
      contentFingerprint: HASH,
      state: "locally-verified",
    });
    await graphStore.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      contextNodeIdentifier: "node-closed",
      targetState: "accepted-closed",
    });
    const graph = await graphStore.readGraph("agent-a", "graph-1");
    const frontier = buildPromptActiveFrontier(graph!);
    expect(frontier.activeNodes.map((node) => node.contextNodeIdentifier)).toEqual(["node-open"]);
    expect(frontier.excludedClosedNodeCount).toBe(1);
  });
});

describe("分级回访（T09A-05）", () => {
  it("按级返回索引→胶囊→证据；有界完整片段由提供者给出", async () => {
    await createCapsule();
    const controller = buildRecallController({
      fullFragmentProvider: async () => "完整片段原文",
    });
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest(),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tier).toBe("bounded-full-fragment");
    expect(result.nodeIndex.contextNodeIdentifier).toBe("node-1");
    expect(result.capsule?.finalDecisionSummary).toBe("关闭结论");
    expect(result.selectedEvidence).toContain("commit:abc");
    expect(result.boundedFullFragment).toBe("完整片段原文");
  });

  it("预算不足时停在低级别：不截断完整内容并报告剩余预算与下一级", async () => {
    await createCapsule();
    const controller = buildRecallController();
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ maximumTokenCount: 20 }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.budgetExhausted).toBe(true);
    expect(result.nextTierAvailable).toBe("closure-capsule");
    expect(result.capsule).toBeNull();
    expect(result.remainingTokenCount).toBeGreaterThanOrEqual(0);
  });

  it("同一调用源未变化 revision 重复请求返回回执；冷却结束或 revision 变化后可重读", async () => {
    await createCapsule();
    const controller = buildRecallController({ recallCooldownMilliseconds: 30_000 });
    const first = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest(),
    });
    expect(first.status).toBe("ok");
    const repeat = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "req-2" }),
    });
    expect(repeat.status).toBe("repeat-receipt");
    if (repeat.status === "repeat-receipt") {
      expect(repeat.retryAfterMilliseconds).toBeGreaterThan(0);
    }
    nowMilliseconds += 31_000;
    const afterCooldown = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "req-3" }),
    });
    expect(afterCooldown.status).toBe("ok");
  });

  it("同一任务执行回访次数有界（活锁保护）", async () => {
    await createCapsule();
    const controller = buildRecallController({
      maximumRecallsPerTaskExecution: 2,
      recallCooldownMilliseconds: 0,
    });
    await controller.recall({ callerAgentInstanceId: "agent-a", request: buildRecallRequest({ requestId: "r1" }) });
    await controller.recall({ callerAgentInstanceId: "agent-a", request: buildRecallRequest({ requestId: "r2" }) });
    const third = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "r3" }),
    });
    expect(third).toMatchObject({ status: "refused", errorCode: "livelock-guard-triggered" });
  });

  it("敏感内容 fail-closed：命中即丢弃整个回访结果", async () => {
    await createCapsule("agent-a", "node-1", { outputSummary: "API_KEY = sk-secret" });
    const controller = buildRecallController();
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest(),
    });
    expect(result).toMatchObject({
      status: "refused",
      errorCode: "sensitive-content-read-denied",
    });
  });

  it("非法请求被拒绝；其他 Agent 的节点返回 not-found（无泄漏）", async () => {
    await createCapsule("agent-a");
    const controller = buildRecallController();
    await expect(
      controller.recall({
        callerAgentInstanceId: "agent-a",
        request: { ...buildRecallRequest(), reasonCode: "give-me-everything" },
      }),
    ).rejects.toMatchObject({ errorCode: "context-recall-invalid" });
    const foreignResult = await controller.recall({
      callerAgentInstanceId: "agent-b",
      request: buildRecallRequest(),
    });
    expect(foreignResult.status).toBe("not-found");
  });
  it("无胶囊但有索引：只返回索引并提示下一级", async () => {
    const controller = buildRecallController();
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest(),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tier).toBe("node-index");
    expect(result.capsule).toBeNull();
    expect(result.nextTierAvailable).toBeNull();
  });

  it("索引本身超出预算：立即 budgetExhausted 且不返回胶囊", async () => {
    await createCapsule();
    const controller = buildRecallController();
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ maximumTokenCount: 1 }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.budgetExhausted).toBe(true);
    expect(result.capsule).toBeNull();
    expect(result.remainingTokenCount).toBe(0);
  });

  it("证据超出剩余预算：保留胶囊并提示 selected-evidence", async () => {
    await createCapsule("agent-a", "node-1", {
      artifactOrCommitReferences: ["commit:" + "x".repeat(400)],
    });
    const controller = buildRecallController({ recallCooldownMilliseconds: 0 });
    const measured = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "measure", maximumTokenCount: 10_000 }),
    });
    expect(measured.status).toBe("ok");
    if (measured.status !== "ok" || measured.capsule === null) return;
    const exactBudget =
      estimateRecallTokenCount(JSON.stringify(measured.nodeIndex)) +
      estimateRecallTokenCount(JSON.stringify(measured.capsule)) +
      1;
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "tight", maximumTokenCount: exactBudget }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.budgetExhausted).toBe(true);
    expect(result.nextTierAvailable).toBe("selected-evidence");
    expect(result.capsule).not.toBeNull();
    expect(result.selectedEvidence).toEqual([]);
  });

  it("完整片段超出预算：保留胶囊与证据并提示 bounded-full-fragment", async () => {
    await createCapsule();
    const controller = buildRecallController({
      fullFragmentProvider: async () => "F".repeat(2000),
    });
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ maximumTokenCount: 300 }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.budgetExhausted).toBe(true);
    expect(result.nextTierAvailable).toBe("bounded-full-fragment");
    expect(result.boundedFullFragment).toBeNull();
  });

  it("未装配提供者时停在胶囊级；空调用者身份被拒绝", async () => {
    await createCapsule("agent-a", "node-1", {
      artifactOrCommitReferences: [],
      testEvidenceReferences: [],
      unresolvedItems: [],
    });
    const controller = buildRecallController();
    const result = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest(),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tier).toBe("closure-capsule");
    expect(result.nextTierAvailable).toBeNull();
    await expect(
      controller.recall({ callerAgentInstanceId: "", request: buildRecallRequest() }),
    ).rejects.toMatchObject({ errorCode: "context-recall-invalid" });
  });

  it("自定义敏感判定命中即拒绝；重复回执携带上次层级", async () => {
    await createCapsule();
    const sensitiveController = buildRecallController({
      containsSensitiveContent: (text: string) => text.includes("FORBIDDEN"),
    });
    const refused = await sensitiveController.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requiredInformation: "FORBIDDEN 内容" }),
    });
    expect(refused).toMatchObject({ status: "refused", errorCode: "sensitive-content-read-denied" });

    const repeatController = buildRecallController({
      fullFragmentProvider: async () => "片段",
    });
    const first = await repeatController.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "p1" }),
    });
    expect(first.status).toBe("ok");
    const repeat = await repeatController.recall({
      callerAgentInstanceId: "agent-a",
      request: buildRecallRequest({ requestId: "p2" }),
    });
    expect(repeat.status).toBe("repeat-receipt");
    if (repeat.status === "repeat-receipt") {
      expect(repeat.previouslyReturnedTier).toBe("bounded-full-fragment");
    }
  });
});

