/**
 * T09A-R1-02：延后片段持久化与跨 Agent 隔离。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";
import {
  deferUnselectedGlobalDecisions,
  readDeferredGlobalContextFragments,
} from "../../../packages/core/src/orchestration/global-decision-selector.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-deferred-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seedDecisions() {
  const store = new GlobalDecisionStore({ baseDirectory: stateDirectory });
  await store.promoteCandidate({
    decisionSummary: "DELAYED-ONE",
    keyRationale: "预算不足时延后",
    appliesToScope: "T-900",
    informationSource: { sourceType: "user" },
    sourceRevision: 1,
  });
  await store.promoteCandidate({
    decisionSummary: "DELAYED-TWO",
    keyRationale: "预算不足时延后",
    appliesToScope: "T-901",
    informationSource: { sourceType: "user" },
    sourceRevision: 1,
  });
  return store.listRecords();
}

describe("T09A-R1-02：延后片段", () => {
  it("持久化后可由未来的相关任务读取，且不跨 Agent 泄漏", async () => {
    const records = await seedDecisions();
    await deferUnselectedGlobalDecisions({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
      sourceContextNodeIdentifier: "node-1",
      sourceNodeRevision: 1,
      decisions: records,
    });

    const ownFragments = await readDeferredGlobalContextFragments({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-a",
    });
    expect(ownFragments).toHaveLength(2);
    expect(ownFragments.every((fragment) => fragment.ownerAgentInstanceId === "agent-a")).toBe(true);

    const otherAgentFragments = await readDeferredGlobalContextFragments({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-b",
    });
    expect(otherAgentFragments).toHaveLength(0);
  });

  it("按 mission 过滤，并跳过损坏条目", async () => {
    const records = await seedDecisions();
    await deferUnselectedGlobalDecisions({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
      sourceContextNodeIdentifier: "node-1",
      sourceNodeRevision: 1,
      decisions: records,
    });
    const deferredDirectory = path.join(
      stateDirectory,
      "agent-memory",
      "agent-a",
      "deferred-context",
    );
    await fs.writeFile(path.join(deferredDirectory, "corrupted.json"), "{not-json", "utf8");

    const missionFragments = await readDeferredGlobalContextFragments({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
    });
    expect(missionFragments).toHaveLength(2);
    const otherMissionFragments = await readDeferredGlobalContextFragments({
      baseDirectory: stateDirectory,
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-2",
    });
    expect(otherMissionFragments).toHaveLength(0);
  });
});
