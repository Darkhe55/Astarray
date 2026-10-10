/**
 * NODECTX-01-02 反例（2026-10-10）：无损暂存、自动补回、永久关闭与显式回访。
 *
 * 卡内 §2.3/§2.4 明文：
 *  - "**仅把当前不需要的非紧急/非重要节点完整落盘**；先校验**原文可读、
 *    hash/revision 与写入成功**，**再**提交 temporarily-closed 及队列索引。
 *    **磁盘失败不移出上下文、不假报暂存成功**；**不通过模型重写原文**"；
 *  - "处理当前**前置节点**；在完成、关闭、取消、显式调整预算等**安全点**触发本地准入器。
 *    按偏序 ready set、优先级与稳定顺序补回合适片段，**保持用户来源优先**"；
 *  - "自动补回按 **node/revision/activation ID 幂等**，恢复时**从磁盘索引对账**，
 *    防止**重复注入与丢节点**"；
 *  - "设置关闭/恢复阈值**滞回**及**每轮迁移上限**……防止**临时关闭—补回反复振荡**；
 *    **同 revision 无进展时停止并报告**，不周期性唤醒模型"；
 *  - 测试重点："**工具调用与结果不拆散**"、"**低优先内容落盘不丢原指令、不越 SMART 窗口**"、
 *    "**磁盘满、写入后崩溃、重复补回、无进展振荡**均有反例"。
 *
 * 本片钉住的语义（全部 fail-closed）：
 *  - **紧急/重要或当前需要**的节点**不得**暂存；
 *  - **工具调用与其结果必须同进同出**（不得拆散）；
 *  - **磁盘失败 ⇒ 状态完全不变**（不移出上下文、不假报成功）；
 *  - **暂存前必须校验原文可读与 hash/revision 一致**，不一致即拒绝；
 *  - **补回幂等**（同 node/revision/activation 重复补回不得重复注入）；
 *  - **振荡保护**：超过阈值滞回带即停止补回；**同 revision 无进展时停止并报告**；
 *  - **每轮迁移上限**必须被遵守；
 *  - **永久关闭不自动复活**，但允许**显式回访**。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLosslessContextManager,
  type LosslessContextNode,
} from "../../../packages/core/src/toolkit/lossless-context-manager.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-nodectx02-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildNode(overrides: Partial<LosslessContextNode> = {}): LosslessContextNode {
  return {
    nodeIdentifier: "node-1",
    revision: 1,
    // 默认为**可暂存**形态（非用户、非最高层级）；用户约束保护另有用例单独覆盖。
    sourceKind: "agent",
    priorityTier: 1,
    contentText: "原文内容",
    isUrgent: false,
    isImportant: false,
    isNeededForCurrentExecution: false,
    toolCallIdentifier: null,
    dependencyNodeIdentifiers: [],
    ...overrides,
  };
}

function buildManager(options?: { maximumMigrationsPerRound?: number }) {
  return createLosslessContextManager({
    stagingDirectory: path.join(stateDirectory, "staging"),
    maximumMigrationsPerRound: options?.maximumMigrationsPerRound ?? 8,
  });
}

describe("NODECTX-01-02：只有「当前不需要的非紧急非重要」节点才可暂存", () => {
  it("① 紧急 / 重要 / 当前执行需要 / 用户未完成约束 ⇒ **不得**暂存", async () => {
    const manager = buildManager();
    for (const flag of [
      { isUrgent: true },
      { isImportant: true },
      { isNeededForCurrentExecution: true },
    ]) {
      const outcome = await manager.stageNode(buildNode(flag));
      expect(outcome.isStaged, JSON.stringify(flag) + " 不得被暂存").toBe(false);
      expect(String(outcome.reason)).toMatch(/紧急|重要|当前|保护/);
    }
  });

  it("①b **用户来源未完成约束**优先保护，不得因「低优先」被移出上下文", async () => {
    const manager = buildManager();
    const outcome = await manager.stageNode(
      buildNode({ sourceKind: "user", priorityTier: 0 }),
    );
    expect(outcome.isStaged).toBe(false);
    expect(String(outcome.reason)).toMatch(/用户|约束|优先/);
  });
  it("② 普通非紧急节点可暂存，且状态为 temporarily-closed、原文完整落盘", async () => {
    const manager = buildManager();
    const node = buildNode({ contentText: "需要暂存的正文" });
    const outcome = await manager.stageNode(node);
    expect(outcome.isStaged).toBe(true);
    expect(manager.getVisibilityState("node-1")).toBe("temporarily-closed");
    // 原文**逐字**在磁盘上
    const staged = await manager.readStagedContent("node-1");
    expect(staged).toBe("需要暂存的正文");
    // 业务状态**不受影响**（"暂不入提示词"不是 done）
    expect(manager.getBusinessStatus("node-1")).toBe("pending");
  });
});

describe("NODECTX-01-02：工具调用与结果不得拆散", () => {
  it("③ 工具调用节点与其结果节点必须**同进同出**", async () => {
    const manager = buildManager();
    manager.registerNode(
      buildNode({ nodeIdentifier: "node-call", toolCallIdentifier: "call-1" }),
    );
    manager.registerNode(buildNode({ nodeIdentifier: "node-result" }));
    manager.registerToolPair({
      toolCallIdentifier: "call-1",
      toolCallNodeIdentifier: "node-call",
      toolResultNodeIdentifier: "node-result",
    });
    // 只暂存调用节点 ⇒ 必须被拒（拆散配对）
    const partialOutcome = await manager.stageNode(
      buildNode({
        nodeIdentifier: "node-call",
        toolCallIdentifier: "call-1",
        isNeededForCurrentExecution: false,
      }),
    );
    expect(partialOutcome.isStaged).toBe(false);
    expect(String(partialOutcome.reason)).toMatch(/配对|拆分|工具调用|结果/);

    // 同时暂存两者 ⇒ 允许
    const pairedOutcome = await manager.stageNodePair({ toolCallIdentifier: "call-1" });
    expect(pairedOutcome.isStaged).toBe(true);
    expect(manager.getVisibilityState("node-call")).toBe("temporarily-closed");
    expect(manager.getVisibilityState("node-result")).toBe("temporarily-closed");
  });
});

describe("NODECTX-01-02：磁盘失败不得假报成功", () => {
  it("④ 暂存写入失败 ⇒ 状态**完全不变**（不移出上下文、不假报成功）", async () => {
    const manager = buildManager();
    const node = buildNode();
    // 注入一个总是失败的写入端口
    manager.setStagingWriterForTesting(async () => {
      throw new Error("模拟磁盘已满");
    });
    const outcome = await manager.stageNode(node);
    expect(outcome.isStaged).toBe(false);
    expect(String(outcome.reason)).toMatch(/磁盘|写入|失败/);
    // 关键：仍未移出上下文
    expect(manager.getVisibilityState("node-1")).toBe("active");
    expect(manager.listStagedNodeIdentifiers()).toEqual([]);
  });

  it("⑤ 原文 hash/revision 不一致 ⇒ 拒绝暂存（不得落错版本）", async () => {
    const manager = buildManager();
    manager.registerKnownRevision({
      nodeIdentifier: "node-1",
      revision: 2,
      contentHash: "sha256:" + "f".repeat(64),
    });
    const outcome = await manager.stageNode(buildNode({ revision: 1 }));
    expect(outcome.isStaged).toBe(false);
    expect(String(outcome.reason)).toMatch(/revision|hash|不一致/);
  });
});

describe("NODECTX-01-02：自动补回（幂等、偏序、优先级、上限）", () => {
  it("⑥ 补回按 **node/revision/activation** 幂等：重复补回不得重复注入", async () => {
    const manager = buildManager();
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    await manager.stageNode(buildNode({ nodeIdentifier: "node-2" }));

    const firstRound = await manager.reclaimAtSafetyPoint();
    expect(firstRound.reclaimedNodeIdentifiers).toHaveLength(2);
    // 再次触发（同一 revision、同一 activation）⇒ 不得重复注入
    const secondRound = await manager.reclaimAtSafetyPoint();
    expect(secondRound.reclaimedNodeIdentifiers).toEqual([]);
    expect(secondRound.isIdempotentSkip).toBe(true);
  });

  it("⑦ 补回遵循偏序：前驱未完成时不得补回其后继", async () => {
    const manager = buildManager();
    manager.registerDependency({
      nodeIdentifier: "node-successor",
      predecessorNodeIdentifiers: ["node-predecessor"],
    });
    await manager.stageNode(buildNode({ nodeIdentifier: "node-predecessor" }));
    await manager.stageNode(buildNode({ nodeIdentifier: "node-successor" }));
    // 前驱仍未完成 ⇒ 后继不得补回
    const outcome = await manager.reclaimAtSafetyPoint();
    expect(outcome.reclaimedNodeIdentifiers).toContain("node-predecessor");
    expect(outcome.reclaimedNodeIdentifiers).not.toContain("node-successor");
  });

  it("⑧ 补回必须遵守**每轮迁移上限**", async () => {
    const manager = buildManager({ maximumMigrationsPerRound: 2 });
    for (const identifier of ["n1", "n2", "n3", "n4"]) {
      await manager.stageNode(buildNode({ nodeIdentifier: identifier }));
    }
    const outcome = await manager.reclaimAtSafetyPoint();
    expect(outcome.reclaimedNodeIdentifiers).toHaveLength(2);
    expect(outcome.isMigrationsCapped).toBe(true);
  });

  it("⑨ 同 revision **无进展**时停止并报告（不周期性唤醒模型）", async () => {
    const manager = buildManager();
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    await manager.reclaimAtSafetyPoint();
    // 再次暂存同一 revision 并再次补回 ⇒ 判定为振荡
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    const oscillationRound = await manager.reclaimAtSafetyPoint();
    expect(oscillationRound.isOscillationDetected).toBe(true);
    expect(String(oscillationRound.reason)).toMatch(/无进展|振荡|振荡保护|停止/);
    /**
     * 关键在"**停止**"而不是"本轮不补回"：本轮补回本身合法（它把节点放回上下文），
     * 但此后**不得**再周期性补回。这里通过"再暂存同一 revision 后补回为空"验证停止生效。
     */
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    const afterStallRound = await manager.reclaimAtSafetyPoint();
    expect(afterStallRound.reclaimedNodeIdentifiers).toEqual([]);
    expect(afterStallRound.isOscillationDetected).toBe(true);
  });
});

describe("NODECTX-01-02：永久关闭与显式回访", () => {
  it("⑩ 永久关闭**不自动复活**；显式回访可读原文，且原文仍在盘上", async () => {
    const manager = buildManager();
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    const closure = await manager.closePermanently({
      nodeIdentifier: "node-1",
      verifiedByGateIdentifier: "completion-gate",
      isAccepted: true,
    });
    expect(closure.isClosed).toBe(true);
    expect(manager.getVisibilityState("node-1")).toBe("permanently-closed");
    // 自动补回**不得**复活它
    const round = await manager.reclaimAtSafetyPoint();
    expect(round.reclaimedNodeIdentifiers).not.toContain("node-1");
    // 显式回访可读原文
    const recalled = await manager.recallExplicitly({ nodeIdentifier: "node-1" });
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.contentText).toBe("原文内容");
  });

  it("⑪ 未通过核验时不得永久关闭（fail-closed）", async () => {
    const manager = buildManager();
    await manager.stageNode(buildNode({ nodeIdentifier: "node-1" }));
    const closure = await manager.closePermanently({
      nodeIdentifier: "node-1",
      verifiedByGateIdentifier: "completion-gate",
      isAccepted: false,
    });
    expect(closure.isClosed).toBe(false);
    expect(manager.getVisibilityState("node-1")).toBe("temporarily-closed");
  });
});
