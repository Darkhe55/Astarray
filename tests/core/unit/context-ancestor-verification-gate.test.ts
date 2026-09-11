/**
 * T09A-R1-03：延迟（deferred）子节点不得让祖先被标记为已人工验收。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-ancestor-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const FINGERPRINT = "sha256:" + "a".repeat(64);

describe("T09A-R1-03：祖先人工验收门禁", () => {
  it("required 子节点仅 deferred-review-closed 时，父节点不得 accepted-closed", async () => {
    const store = new LocalContextGraphStore({ baseDirectory: stateDirectory });
    await store.createGraph({
      graphIdentifier: "mission-1",
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
    });
    let graph = await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      expectedGraphRevision: 1,
      contextNodeIdentifier: "node-parent",
      missionId: "mission-1",
      contentFingerprint: FINGERPRINT,
      state: "locally-verified",
    });
    graph = await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: "node-child",
      missionId: "mission-1",
      contentFingerprint: FINGERPRINT,
      state: "locally-verified",
    });
    graph = await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      edgeIdentifier: "edge-required",
      fromContextNodeIdentifier: "node-parent",
      toContextNodeIdentifier: "node-child",
      edgeType: "required",
    });
    graph = await store.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: "node-child",
      targetState: "deferred-review-closed",
    });

    await expect(
      store.closeNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "mission-1",
        expectedGraphRevision: graph.revision,
        contextNodeIdentifier: "node-parent",
        targetState: "accepted-closed",
      }),
    ).rejects.toMatchObject({ errorCode: "context-node-not-closable" });

    const closedParent = await store.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: "node-parent",
      targetState: "deferred-review-closed",
    });
    expect(
      closedParent.nodes.find((node) => node.contextNodeIdentifier === "node-parent")?.state,
    ).toBe("deferred-review-closed");
  });
});
