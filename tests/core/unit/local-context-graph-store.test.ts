/**
 * T09A-02：局部上下文图存储测试（DAG、required/optional、叶节点、
 * 并发 CAS、增量重开、备份恢复与故障反例）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

const HASH = "sha256:" + "a".repeat(64);
let temporaryDirectory: string;
let store: LocalContextGraphStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ctx-graph-"));
  let nowMilliseconds = 1_800_000_000_000;
  store = new LocalContextGraphStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: () => {
      nowMilliseconds += 1_000;
      return nowMilliseconds;
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

async function createGraphWithRoot(
  owner = "agent-a",
  graphIdentifier = "graph-1",
  rootState: "active" | "locally-verified" = "active",
) {
  await store.createGraph({ graphIdentifier, ownerAgentInstanceId: owner, missionId: "mission-1" });
  return store.addNode({
    ownerAgentInstanceId: owner,
    graphIdentifier,
    expectedGraphRevision: 1,
    contextNodeIdentifier: "node-root",
    missionId: "mission-1",
    contentFingerprint: HASH,
    state: rootState,
  });
}

describe("LocalContextGraphStore（T09A-02）", () => {
  it("创建空图并添加节点后可读回（revision 单调）", async () => {
    const graph = await createGraphWithRoot();
    expect(graph.revision).toBe(2);
    const read = await store.readGraph("agent-a", "graph-1");
    expect(read?.nodes).toHaveLength(1);
    expect(read?.nodes[0]?.state).toBe("active");
  });

  it("缺失图：read 返回 null；写入报 context-graph-not-found", async () => {
    expect(await store.readGraph("agent-a", "graph-missing")).toBeNull();
    await expect(
      store.addNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-missing",
        expectedGraphRevision: 1,
        contextNodeIdentifier: "n1",
        missionId: "mission-1",
        contentFingerprint: HASH,
      }),
    ).rejects.toMatchObject({ errorCode: "context-graph-not-found" });
  });

  it("陈旧 revision 写入被拒绝（stale-revision）", async () => {
    await createGraphWithRoot();
    await expect(
      store.addNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 1,
        contextNodeIdentifier: "node-b",
        missionId: "mission-1",
        contentFingerprint: HASH,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("并发 CAS：同一 expected revision 的两个写入只有一个成功", async () => {
    await createGraphWithRoot();
    const results = await Promise.allSettled([
      store.addNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 2,
        contextNodeIdentifier: "node-x",
        missionId: "mission-1",
        contentFingerprint: HASH,
      }),
      store.addNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 2,
        contextNodeIdentifier: "node-y",
        missionId: "mission-1",
        contentFingerprint: HASH,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      errorCode: "stale-revision",
    });
  });

  it("required 边计入父节点 openRequiredChildCount；optional 不计", async () => {
    await createGraphWithRoot();
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-child",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      contextNodeIdentifier: "node-optional",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    const afterRequired = await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 4,
      edgeIdentifier: "edge-required",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-child",
      edgeType: "required",
    });
    const rootAfterRequired = afterRequired.nodes.find((node) => node.contextNodeIdentifier === "node-root");
    expect(rootAfterRequired?.openRequiredChildCount).toBe(1);
    const afterOptional = await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 5,
      edgeIdentifier: "edge-optional",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-optional",
      edgeType: "optional",
    });
    const rootAfterOptional = afterOptional.nodes.find((node) => node.contextNodeIdentifier === "node-root");
    expect(rootAfterOptional?.openRequiredChildCount).toBe(1);
  });

  it("required 计数 > 0 时父节点不可关闭；子节点关闭后计数递减并可关闭", async () => {
    await createGraphWithRoot("agent-a", "graph-1", "locally-verified");
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-child",
      missionId: "mission-1",
      contentFingerprint: HASH,
      state: "locally-verified",
    });
    await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      edgeIdentifier: "edge-required",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-child",
      edgeType: "required",
    });
    await expect(
      store.closeNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 4,
        contextNodeIdentifier: "node-root",
        targetState: "accepted-closed",
      }),
    ).rejects.toMatchObject({ errorCode: "context-node-not-closable" });

    const afterChildClose = await store.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 4,
      contextNodeIdentifier: "node-child",
      targetState: "accepted-closed",
    });
    const rootAfterChildClose = afterChildClose.nodes.find((node) => node.contextNodeIdentifier === "node-root");
    expect(rootAfterChildClose?.openRequiredChildCount).toBe(0);

    const closedRoot = await store.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 5,
      contextNodeIdentifier: "node-root",
      targetState: "accepted-closed",
    });
    expect(closedRoot.nodes.find((node) => node.contextNodeIdentifier === "node-root")?.state).toBe(
      "accepted-closed",
    );
  });

  it("叶节点无子节点但状态未验收时不能关闭", async () => {
    await createGraphWithRoot();
    await expect(
      store.closeNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 2,
        contextNodeIdentifier: "node-root",
        targetState: "accepted-closed",
      }),
    ).rejects.toMatchObject({ errorCode: "context-node-not-closable" });
  });

  it("非法边：未知锚点、自环、缺失豁免的 waived 边全部拒绝", async () => {
    await createGraphWithRoot();
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-b",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    const expectInvalidEdge = async (edge: Record<string, unknown>) => {
      await expect(
        store.addEdge({
          ownerAgentInstanceId: "agent-a",
          graphIdentifier: "graph-1",
          expectedGraphRevision: 3,
          ...edge,
        } as never),
      ).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
    };
    await expectInvalidEdge({
      edgeIdentifier: "edge-missing",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-ghost",
      edgeType: "required",
    });
    await expectInvalidEdge({
      edgeIdentifier: "edge-self",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-root",
      edgeType: "required",
    });
    await expectInvalidEdge({
      edgeIdentifier: "edge-waived-no-grant",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-b",
      edgeType: "waived",
    });
  });

  it("环检测：A→B 之后 B→A 被拒绝", async () => {
    await createGraphWithRoot();
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-b",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      edgeIdentifier: "edge-ab",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-b",
      edgeType: "required",
    });
    await expect(
      store.addEdge({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 4,
        edgeIdentifier: "edge-ba",
        fromContextNodeIdentifier: "node-b",
        toContextNodeIdentifier: "node-root",
        edgeType: "required",
      }),
    ).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
  });

  it("重新开放已关闭节点：状态变 reopened 且父计数回增", async () => {
    await createGraphWithRoot();
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-child",
      missionId: "mission-1",
      contentFingerprint: HASH,
      state: "locally-verified",
    });
    await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      edgeIdentifier: "edge-required",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-child",
      edgeType: "required",
    });
    await store.closeNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 4,
      contextNodeIdentifier: "node-child",
      targetState: "deferred-review-closed",
    });
    const reopened = await store.reopenNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 5,
      contextNodeIdentifier: "node-child",
    });
    expect(reopened.nodes.find((node) => node.contextNodeIdentifier === "node-child")?.state).toBe("reopened");
    expect(reopened.nodes.find((node) => node.contextNodeIdentifier === "node-root")?.openRequiredChildCount).toBe(1);
    await expect(
      store.reopenNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 6,
        contextNodeIdentifier: "node-root",
      }),
    ).rejects.toMatchObject({ errorCode: "context-node-not-closable" });
  });

  it("故障注入：主文件损坏从 .bak 恢复；主备份均损坏 fail-closed（journal-corrupted）", async () => {
    await createGraphWithRoot();
    const graphFilePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-a",
      "context-graphs",
      "graph-1",
      "context-graph.json",
    );
    await fs.writeFile(graphFilePath, "{ 损坏的图", "utf8");
    const recovered = await store.readGraph("agent-a", "graph-1");
    expect(recovered?.nodes).toHaveLength(1);

    const backupFilePath = graphFilePath + ".bak";
    await fs.writeFile(graphFilePath, "{ 损坏", "utf8");
    await fs.writeFile(backupFilePath, "{ 也损坏", "utf8");
    await expect(store.readGraph("agent-a", "graph-1")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("跨 Agent 所有权：文件内节点属主与图属主不一致时 fail-closed", async () => {
    await createGraphWithRoot();
    const graphFilePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-a",
      "context-graphs",
      "graph-1",
      "context-graph.json",
    );
    const raw = JSON.parse(await fs.readFile(graphFilePath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    raw.nodes[0] = { ...(raw.nodes[0] as object), agentInstanceId: "agent-b" };
    await fs.writeFile(graphFilePath, JSON.stringify(raw), "utf8");
    await expect(store.readGraph("agent-a", "graph-1")).rejects.toMatchObject({
      errorCode: "context-graph-invalid",
    });
  });
  it("重复节点与重复边被拒绝", async () => {
    await createGraphWithRoot();
    await expect(
      store.addNode({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 2,
        contextNodeIdentifier: "node-root",
        missionId: "mission-1",
        contentFingerprint: HASH,
      }),
    ).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-b",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      edgeIdentifier: "edge-dup",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-b",
      edgeType: "required",
    });
    await expect(
      store.addEdge({
        ownerAgentInstanceId: "agent-a",
        graphIdentifier: "graph-1",
        expectedGraphRevision: 4,
        edgeIdentifier: "edge-dup",
        fromContextNodeIdentifier: "node-root",
        toContextNodeIdentifier: "node-b",
        edgeType: "required",
      }),
    ).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
  });

  it("带豁免的 waived 边成功且不增加 required 计数", async () => {
    await createGraphWithRoot();
    await store.addNode({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 2,
      contextNodeIdentifier: "node-b",
      missionId: "mission-1",
      contentFingerprint: HASH,
    });
    const graph = await store.addEdge({
      ownerAgentInstanceId: "agent-a",
      graphIdentifier: "graph-1",
      expectedGraphRevision: 3,
      edgeIdentifier: "edge-waived",
      fromContextNodeIdentifier: "node-root",
      toContextNodeIdentifier: "node-b",
      edgeType: "waived",
      waiver: { userId: "u-1", contextGraphRevision: 3, waivedAtIso: "2026-09-09T00:00:00.000Z" },
    });
    expect(graph.nodes.find((node) => node.contextNodeIdentifier === "node-root")?.openRequiredChildCount).toBe(0);
    expect(graph.edges).toHaveLength(1);
  });

  it("重复创建图被拒绝", async () => {
    await createGraphWithRoot();
    await expect(
      store.createGraph({
        graphIdentifier: "graph-1",
        ownerAgentInstanceId: "agent-a",
        missionId: "mission-1",
      }),
    ).rejects.toMatchObject({ errorCode: "context-graph-invalid" });
  });
});

