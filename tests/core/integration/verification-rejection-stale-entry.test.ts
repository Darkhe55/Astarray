/**
 * 行为反例（2026-10-10 **真实用户人工体验发现**）：
 * 「否决」之后那条待追认条目会**永久卡死** —— 列表里还在，但追认必然
 * `stale-revision`，且不会再刷新出可用的条目。
 *
 * **用户实测复现**（GUI 待追认区，`127.0.0.1:6115`）：
 *  1. 点「否决」→ 提示"节点重开"，但**条目未消失**；
 *  2. 点「刷新」→ 条目**还在**；
 *  3. 点「追认」→ **裁决失败：stale-revision**。
 *
 * **实测根因**（生产状态目录直接读数）：
 *  - 待追认条目 `verify-T-001` 的 `contextGraphRevision = 4`；
 *  - 而该 mission 上下文图**当前** `revision = 5`，节点 `node-T-001` 状态 = `reopened`。
 *
 * **代码根因**：
 *  - `recordUserRejection` 只做 `graphStore.reopenNode(...)`（使 revision 前进），
 *    **既不删除也不更新**那条 deferred 条目；
 *  - 于是 `listPendingVerifications()` 仍把**旧 revision 4** 的条目列出来；
 *  - 而 `recordUserAcceptance` 要求
 *    `contextGraphRevision === currentContextGraphRevision`（4 === 5 不成立）
 *    ⇒ 必然 `stale-revision`。
 * **本文件实际钉住的语义（不夸大）**：
 *  - ① 否决后，**不得**继续列出该节点的陈旧待追认条目（列出就必然是死条目）。
 *    这一条**在修复前必须失败**，已实测（"否决后仍列出陈旧条目"）。
 *  - ② 同 taskIdentifier **以新 revision 重新写入**时，条目必须绑定**当前** revision。
 *    这一条**不是回归防护**：`createDeferredVerificationTask` 用原子写覆盖同路径文件，
 *    故它**修复前也通过**。它在此处的价值是钉住"重新完成后条目 revision 正确"这一前提，
 *    避免日后有人把覆盖写改成追加/保留旧条目。
 *
 * **未覆盖（如实声明）**：`context-node-lifecycle.ensureDeferredVerificationTask` 的
 * **复用条件**只比 `contextNodeIdentifier` 与 `closureCapsuleHash`、**不比 revision**，
 * 因此走完整生命周期路径时仍可能复用一条旧 revision 条目。本文件**没有**测试该复用路径
 * （那需要装配完整生命周期控制器）；故该路径**仍待单独修复与验证**，见报告。
 *
 * 本文件在修复前，① 必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HumanVerificationController } from "../../../packages/core/src/orchestration/human-verification-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

const OWNER = "worker:mission-reject-test:T-001:1";

let baseDirectory: string;
let graphStore: LocalContextGraphStore;
let controller: HumanVerificationController;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-reject-stale-"));
  graphStore = new LocalContextGraphStore({ baseDirectory });
  controller = new HumanVerificationController({
    baseDirectory,
    graphStore,
  });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

/** 建图 + 建节点，返回当前 revision。 */
async function seedGraph(): Promise<number> {
  const created = await graphStore.createGraph({
    ownerAgentInstanceId: OWNER,
    graphIdentifier: "mission-reject-test",
    missionId: "mission-reject-test",
  });
  const withNode = await graphStore.addNode({
    ownerAgentInstanceId: OWNER,
    graphIdentifier: "mission-reject-test",
    missionId: "mission-reject-test",
    expectedGraphRevision: created.revision,
    contextNodeIdentifier: "node-T-001",
    contentFingerprint: "sha256:" + "a".repeat(64),
  });
  /**
   * 种子必须让节点**处于可重开的已关闭态**，否则 `recordUserRejection` 的
   * `reopenNode` 会因"只有已关闭节点可以重新开放"失败（那是种子问题，不是缺陷）。
   * 真实链路里这一步由 `context-node-lifecycle` 完成：local-verified → closeNode。
   */
  const verified = await graphStore.markNodeState({
    ownerAgentInstanceId: OWNER,
    graphIdentifier: "mission-reject-test",
    expectedGraphRevision: withNode.revision,
    contextNodeIdentifier: "node-T-001",
    state: "locally-verified",
  });
  const closed = await graphStore.closeNode({
    ownerAgentInstanceId: OWNER,
    graphIdentifier: "mission-reject-test",
    expectedGraphRevision: verified.revision,
    contextNodeIdentifier: "node-T-001",
    targetState: "deferred-review-closed",
  });
  return closed.revision;
}

describe("否定裁决后的待追认条目不得变成死条目（stale-revision）", () => {
  it("① 否决后不得再列出该节点的陈旧待追认条目", async () => {
    const graphRevision = await seedGraph();
    await controller.createDeferredVerificationTask({
      taskIdentifier: "verify-T-001",
      ownerAgentInstanceId: OWNER,
      contextNodeIdentifier: "node-T-001",
      contextGraphRevision: graphRevision,
      closureCapsuleHash: "sha256:" + "b".repeat(64),
      humanSteps: "人工复核后再追认",
      priorityTier: 1,
    });
    expect(await controller.listDeferredVerificationTasks(OWNER)).toHaveLength(1);

    const rejection = await controller.recordUserRejection({
      ownerAgentInstanceId: OWNER,
      graphIdentifier: "mission-reject-test",
      allNodeIdentifiers: ["node-T-001"],
      reason: "产物不合格，返修",
    });
    expect(rejection.reopenedNodeIdentifiers).toContain("node-T-001");

    const graphAfterRejection = await graphStore.readGraph(OWNER, "mission-reject-test");
    expect(graphAfterRejection?.revision).toBeGreaterThan(graphRevision);

    /**
     * 关键断言：图已前进到新 revision，旧条目**不再可被合法追认**，
     * 故不得继续列在"待追认"里（否则用户只会拿到 stale-revision）。
     */
    const stillPending = await controller.listDeferredVerificationTasks(OWNER);
    expect(
      stillPending.filter((task) => task.contextNodeIdentifier === "node-T-001"),
      "否决后仍列出陈旧条目 ⇒ 用户点追认必然 stale-revision",
    ).toEqual([]);
  });

  it("② 以新 revision 重新写入同 taskIdentifier 时，条目必须绑定当前 revision", async () => {
    const graphRevision = await seedGraph();
    await controller.createDeferredVerificationTask({
      taskIdentifier: "verify-T-001",
      ownerAgentInstanceId: OWNER,
      contextNodeIdentifier: "node-T-001",
      contextGraphRevision: graphRevision,
      closureCapsuleHash: "sha256:" + "b".repeat(64),
      humanSteps: "人工复核后再追认",
      priorityTier: 1,
    });
    await controller.recordUserRejection({
      ownerAgentInstanceId: OWNER,
      graphIdentifier: "mission-reject-test",
      allNodeIdentifiers: ["node-T-001"],
      reason: "产物不合格，返修",
    });

    /**
     * 模拟真实返修流程：**重新完成并关闭节点**（关闭态），再用**当前** revision 写入条目。
     * 注意不能只写条目就断言可见 —— 节点仍是 `reopened` 时，条目**本就不该**被列出
     * （见用例 ③）。
     */
    const afterReopen = await graphStore.readGraph(OWNER, "mission-reject-test");
    const reVerified = await graphStore.markNodeState({
      ownerAgentInstanceId: OWNER,
      graphIdentifier: "mission-reject-test",
      expectedGraphRevision: afterReopen?.revision ?? 0,
      contextNodeIdentifier: "node-T-001",
      state: "locally-verified",
    });
    const reClosed = await graphStore.closeNode({
      ownerAgentInstanceId: OWNER,
      graphIdentifier: "mission-reject-test",
      expectedGraphRevision: reVerified.revision,
      contextNodeIdentifier: "node-T-001",
      targetState: "deferred-review-closed",
    });
    const currentRevision = reClosed.revision;
    await controller.createDeferredVerificationTask({
      taskIdentifier: "verify-T-001",
      ownerAgentInstanceId: OWNER,
      contextNodeIdentifier: "node-T-001",
      contextGraphRevision: currentRevision,
      closureCapsuleHash: "sha256:" + "b".repeat(64),
      humanSteps: "人工复核后再追认",
      priorityTier: 1,
    });

    const pending = await controller.listDeferredVerificationTasks(OWNER);
    const entry = pending.find((task) => task.taskIdentifier === "verify-T-001");
    expect(entry).toBeDefined();
    expect(
      entry?.contextGraphRevision,
      "重新完成后的条目仍绑定旧 revision ⇒ 追认必然 stale-revision（缺陷不会自愈）",
    ).toBe(currentRevision);
  });

  /**
   * **2026-10-10 第二个面（同一缺陷，真实用户报告 `裁决失败：internal-error`）**：
   *
   * 用户此前在**修复前**的服务器上否决过，那条陈旧条目就**留在了磁盘上**。
   * 修复后的服务器**照样把它列出来并给出「否决」按钮**，可节点早已是 `reopened`
   * （非关闭态），于是 `reopenNode` 必然抛
   * `context-node-not-closable`（"只有已关闭节点可以重新开放"）；
   * 而 GUI 路由只映射 `stale-revision` / `verification-not-found` /
   * `verification-context-missing`，其余**直接 rethrow** ⇒ 500 `internal-error`。
   *
   * 实测证据（生产状态目录 + 服务端日志）：
   *   条目 verify-T-001 绑定 revision 4；图当前 revision 5；节点 state=`reopened`。
   *   POST /commands/verification-decision ⇒ HTTP 500 {"error":"internal-error"}；
   *   服务端日志 `PROBE-DECISION-ERROR code=context-node-not-closable`。
   *
   * 本用例钉住：**不可执行（节点非关闭态）的条目不得出现在待追认列表里** ——
   * 否则界面必然提供一个点了就失败的按钮。
   */
  it("③ 节点已非关闭态时，陈旧条目不得出现在待追认列表中", async () => {
    const graphRevision = await seedGraph();
    await controller.createDeferredVerificationTask({
      taskIdentifier: "verify-T-001",
      ownerAgentInstanceId: OWNER,
      contextNodeIdentifier: "node-T-001",
      contextGraphRevision: graphRevision,
      closureCapsuleHash: "sha256:" + "b".repeat(64),
      humanSteps: "人工复核后再追认",
      priorityTier: 1,
    });
    // 直接重开节点（模拟"修复前的旧服务器已否决过，条目却残留"的历史现场）
    const graph = await graphStore.readGraph(OWNER, "mission-reject-test");
    await graphStore.reopenNode({
      ownerAgentInstanceId: OWNER,
      graphIdentifier: "mission-reject-test",
      expectedGraphRevision: graph?.revision ?? 0,
      contextNodeIdentifier: "node-T-001",
    });

    const nodeNow = (await graphStore.readGraph(OWNER, "mission-reject-test"))?.nodes.find(
      (node) => node.contextNodeIdentifier === "node-T-001",
    );
    expect(nodeNow?.state).toBe("reopened");

    /**
     * 该条目已不可能被裁决（否决会因节点非关闭态失败，追认会因 revision 过期失败）。
     * 列出它 = 给用户一个必然失败的按钮。
     */
    const entriesForNode = (
      await controller.listDeferredVerificationTasks(OWNER)
    ).filter((task) => task.contextNodeIdentifier === "node-T-001");
    expect(
      entriesForNode,
      "节点已是 reopened（非关闭态）却仍列出条目 ⇒ 界面提供的裁决按钮点了必然失败",
    ).toEqual([]);
  });

  /**
   * **2026-10-10 第三个面（真实用户追认后发现）**：追认成功写入签收记录后，
   * 条目**仍留在待追认列表**，于是可以**重复追认**，界面也不反映"已验收"。
   *
   * 实测证据：用户追认返回
   * `accept-worker~003amission-ea8d2dbb~003aT-001~003a1-4-mv3vpssz`，
   * 签收文件确实落盘（`acceptances/<id>.json`），
   * 但节点 state 仍是 `deferred-review-closed`、`/verifications` 仍返回该条目。
   *
   * 根因：`recordUserAcceptance` **只写签收记录，不推进上下文图节点状态**；
   * 而列表过滤若按"任一已关闭态"判断，`deferred-review-closed` 仍算关闭 ⇒ 继续列出。
   *
   * 本用例钉住：**已签收（存在绑定同一节点与 revision 的签收记录）后，条目不得再列出**。
   */
  it("④ 已签收的条目不得继续出现在待追认列表中（否则可重复追认）", async () => {
    const graphRevision = await seedGraph();
    const capsuleHash = "sha256:" + "b".repeat(64);
    await controller.createDeferredVerificationTask({
      taskIdentifier: "verify-T-001",
      ownerAgentInstanceId: OWNER,
      contextNodeIdentifier: "node-T-001",
      contextGraphRevision: graphRevision,
      closureCapsuleHash: capsuleHash,
      humanSteps: "人工复核后再追认",
      priorityTier: 1,
    });
    expect(await controller.listDeferredVerificationTasks(OWNER)).toHaveLength(1);

    const acceptance = await controller.recordUserAcceptance({
      ownerAgentInstanceId: OWNER,
      contextGraphRevision: graphRevision,
      currentContextGraphRevision: graphRevision,
      nodeIdentifiers: ["node-T-001"],
      summaryHash: capsuleHash,
      userId: "authenticated-user",
    });
    expect(acceptance.acceptanceIdentifier).toMatch(/^accept-/);

    const afterAcceptance = await controller.listDeferredVerificationTasks(OWNER);
    expect(
      afterAcceptance.filter((task) => task.contextNodeIdentifier === "node-T-001"),
      "已签收却仍列出条目 ⇒ 用户可对同一节点重复追认，界面也不反映已验收",
    ).toEqual([]);
  });
});
