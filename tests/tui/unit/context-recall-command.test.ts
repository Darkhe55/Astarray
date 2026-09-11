/**
 * T09A-R1-03：结构化回访（回执/预算）经 CLI 控制面可用。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextClosureCapsuleStore } from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import { ContextRecallController } from "../../../packages/core/src/orchestration/context-recall-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { executeContextRecallCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-recall-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seedClosedNode() {
  const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
  await graphStore.createGraph({
    graphIdentifier: "mission-1",
    ownerAgentInstanceId: "agent-a",
    missionId: "mission-1",
  });
  let graph = await graphStore.addNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "mission-1",
    expectedGraphRevision: 1,
    contextNodeIdentifier: "node-1",
    missionId: "mission-1",
    contentFingerprint: "sha256:" + "b".repeat(64),
    state: "locally-verified",
  });
  graph = await graphStore.closeNode({
    ownerAgentInstanceId: "agent-a",
    graphIdentifier: "mission-1",
    expectedGraphRevision: graph.revision,
    contextNodeIdentifier: "node-1",
    targetState: "deferred-review-closed",
  });
  const capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: stateDirectory });
  await capsuleStore.createCapsule({
    capsuleIdentifier: "capsule-1",
    ownerAgentInstanceId: "agent-a",
    contextNodeIdentifier: "node-1",
    missionId: "mission-1",
    contextGraphRevision: graph.revision,
    finalDecisionSummary: "决策摘要",
    inputSummary: "输入摘要",
    outputSummary: "输出摘要",
    verificationState: "deferred-review-closed",
    informationSource: { sourceType: "agent", agentInstanceId: "agent-a" },
    reopenCondition: "依赖变化时重开",
  });
  return graph.revision;
}

function buildRequest(nodeRevision: number, requestId: string) {
  return JSON.stringify({
    schemaVersion: 1,
    requestId,
    taskExecutionId: "task-exec-1",
    contextNodeIdentifier: "node-1",
    nodeRevision,
    reasonCode: "global-decision-missing",
    requiredInformation: "需要该节点的关闭结论",
    maximumTokenCount: 200,
  });
}

describe("T09A-R1-03：结构化回访控制", () => {
  it("CLI 首次回访返回 ok，冷却期内重复请求返回 repeat-receipt", async () => {
    const nodeRevision = await seedClosedNode();
    const outputs: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    });

    const firstExit = await executeContextRecallCommand({
      stateDirectory,
      callerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      requestJson: buildRequest(nodeRevision, "request-1"),
      isJsonOutput: true,
    });
    expect(firstExit).toBe(0);
    expect(outputs.join("")).toContain('"status": "ok"');

    outputs.length = 0;
    const secondExit = await executeContextRecallCommand({
      stateDirectory,
      callerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      requestJson: buildRequest(nodeRevision, "request-2"),
      isJsonOutput: true,
    });
    expect(secondExit).toBe(0);
    expect(outputs.join("")).toContain("repeat-receipt");
  });

  it("同一 taskExecutionId 超过回访预算后返回 refused（活锁保护）", async () => {
    const nodeRevision = await seedClosedNode();
    const controller = new ContextRecallController({
      capsuleStore: new ContextClosureCapsuleStore({ baseDirectory: stateDirectory }),
      maximumRecallsPerTaskExecution: 1,
      recallCooldownMilliseconds: 0,
      nodeIndexProvider: async () => ({
        missionId: "mission-1",
        state: "deferred-review-closed",
      }),
    });
    const first = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: JSON.parse(buildRequest(nodeRevision, "r-1")) as unknown,
    });
    expect(first.status).toBe("ok");
    const second = await controller.recall({
      callerAgentInstanceId: "agent-a",
      request: JSON.parse(buildRequest(nodeRevision, "r-2")) as unknown,
    });
    expect(second.status).toBe("refused");
    if (second.status === "refused") {
      expect(second.errorCode).toBe("livelock-guard-triggered");
    }
  });
});
