/**
 * MERGE-01 反例（2026-10-10）：把"执行组映射"**接到实际 SMART 窗口装配入口**。
 *
 * 卡内 §1.1/§1.2 明文："SMART 窗口按**原始未完成意图**计数，**不按执行组数量**计数：
 * 窗口 3 条不能通过合并塞入第 4 条。**未准入候选只保存关联**，轮到它时可复用已验证结果；
 * **组完成不自动关闭全部原指令**，逐项由本地门禁核验。"
 *
 * 现状缺口（本轮实测）：上一轮实现了 `createInstructionMergeController`（纯判定层），
 * 但 SMART 侧真实使用的是 `InstructionWindowStore` —— 两者**各自计数、互不相识**
 * ⇒ "窗口按原始未完成意图计数"在**真实装配路径上并不成立**：
 * 窗口只看到它自己的记录，看不到"某条原指令其实已被逐项核验关闭"。
 *
 * 本片钉住的语义：
 *  - 窗口侧的**未完成意图数**必须由原指令的**逐项完成状态**决定（而非窗口记录本身）；
 *  - **合并不得减少**未完成意图数：把 N 条合为一组后，未完成意图仍是 N；
 *  - 已逐项核验关闭的原指令必须从计数中扣除（否则窗口被永久占满）；
 *  - **组不是意图**：执行组数量不得参与窗口计数（即便组数远超容量）。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countUnfinishedIntentionsInWindow } from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";
import { createInstructionMergeController } from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";
import { InstructionWindowStore } from "../../../packages/core/src/orchestration/instruction-window-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge-window-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * 构造"够格的合并候选"（MERGE-01-02 起建组**必须**附带资格候选）。
 *
 * 本套件关注**窗口计数**语义，故给出**一律够格**的候选，
 * 使资格门禁不干扰原断言。
 */
function buildEligibleMergeCandidates(instructionIdentifiers: readonly string[]) {
  return instructionIdentifiers.map((instructionIdentifier) => ({
    instructionIdentifier,
    revision: 1,
    instructionText: "指令 " + instructionIdentifier,
    projectIdentifier: "project-alpha",
    taskAuthorityIdentifier: "authority-1",
    permissionScopeIdentifier: "scope-1",
    goalIdentifier: "goal-1",
    priorityTier: 0,
    supersedesInstructionIdentifiers: [],
    dependencyNodeIdentifiers: [],
    completedDependencyNodeIdentifiers: [],
    isSemanticallyConflicting: false,
    isGoalAmbiguous: false,
    requiresIndependentAuthorization: false,
    hasSideEffectInFlight: false,
  }));
}

function buildInstruction(instructionIdentifier: string) {
  return {
    instructionIdentifier,
    instructionText: "指令 " + instructionIdentifier,
    sourceKind: "user" as const,
    sourceActorIdentifier: "user-1",
    revision: 1,
    priorityTier: 0,
    cancellationRightHolderIdentifier: "user-1",
    acceptanceCriteria: ["完成"],
    isCompleted: false,
  };
}

describe("MERGE-01：窗口计数必须由原指令逐项状态决定", () => {
  it("① 窗口内若干原指令未完成 ⇒ 未完成意图数等于**原指令条数**（与组数无关）", async () => {
    const store = new InstructionWindowStore({
      baseDirectory: stateDirectory,
      windowCapacity: 3,
    });
    for (const identifier of ["ins-1", "ins-2", "ins-3"]) {
      await store.admitInstruction({
        instructionIdentifier: identifier,
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "指令 " + identifier,
        idempotencyKey: "key-" + identifier,
        nowIso: "2026-10-10T00:00:00.000Z",
      });
    }
    const snapshot = await store.snapshot();

    const mergeController = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 3,
    });
    for (const identifier of ["ins-1", "ins-2", "ins-3"]) {
      mergeController.appendInstruction(buildInstruction(identifier));
    }
    // 三条合成一组
    mergeController.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
        mergeCandidates: buildEligibleMergeCandidates(["ins-1", "ins-2", "ins-3"]),
    });

    const counted = countUnfinishedIntentionsInWindow({
      windowSnapshot: snapshot,
      mergeController,
    });
    // 未完成意图仍是 3（**不是** 1 个组）
    expect(counted.unfinishedIntentionCount).toBe(3);
    expect(counted.isCapacityExceeded).toBe(false);
    // 组数不得参与计数
    expect(mergeController.countExecutionGroups()).toBe(1);
  });

  it("② 合并**不得**让第 4 条塞进容量 3 的窗口", async () => {
    const store = new InstructionWindowStore({
      baseDirectory: stateDirectory,
      windowCapacity: 3,
    });
    // 窗口只准入 3 条（第 4 条会被排队），这正是"未准入候选只保存关联"
    for (const identifier of ["ins-1", "ins-2", "ins-3"]) {
      await store.admitInstruction({
        instructionIdentifier: identifier,
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "指令 " + identifier,
        idempotencyKey: "key-" + identifier,
        nowIso: "2026-10-10T00:00:00.000Z",
      });
    }
    const fourthAdmission = await store.admitInstruction({
      instructionIdentifier: "ins-4",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "指令 ins-4",
      idempotencyKey: "key-ins-4",
      nowIso: "2026-10-10T00:00:01.000Z",
    });
    expect(fourthAdmission.outcome).toBe("queued");

    const mergeController = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 3,
    });
    for (const identifier of ["ins-1", "ins-2", "ins-3", "ins-4"]) {
      mergeController.appendInstruction(buildInstruction(identifier));
    }
    mergeController.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
        mergeCandidates: buildEligibleMergeCandidates(["ins-1", "ins-2", "ins-3"]),
    });

    const snapshot = await store.snapshot();
    const counted = countUnfinishedIntentionsInWindow({
      windowSnapshot: snapshot,
      mergeController,
    });
    /**
     * 关键：合并三条后，**排队的第 4 条仍然未被准入**。
     * 若窗口按"组数"计数（1 组），就会误以为还有空位而把第 4 条提上来 —— 这正是要禁止的。
     */
    expect(counted.unfinishedIntentionCount).toBeGreaterThanOrEqual(3);
    expect(counted.isCapacityExceeded).toBe(true);
  });

  it("③ 逐项核验关闭后必须从计数中扣除（否则窗口被永久占满）", async () => {
    const store = new InstructionWindowStore({
      baseDirectory: stateDirectory,
      windowCapacity: 3,
    });
    for (const identifier of ["ins-1", "ins-2"]) {
      await store.admitInstruction({
        instructionIdentifier: identifier,
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "指令 " + identifier,
        idempotencyKey: "key-" + identifier,
        nowIso: "2026-10-10T00:00:00.000Z",
      });
    }
    const mergeController = createInstructionMergeController({
      isMergeEnabled: true,
      windowCapacity: 3,
    });
    for (const identifier of ["ins-1", "ins-2"]) {
      mergeController.appendInstruction(buildInstruction(identifier));
    }
    mergeController.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
        mergeCandidates: buildEligibleMergeCandidates(["ins-1", "ins-2"]),
    });
    mergeController.markGroupCompleted({ groupIdentifier: "group-1" });

    const beforeVerification = countUnfinishedIntentionsInWindow({
      windowSnapshot: await store.snapshot(),
      mergeController,
    });
    // 组完成**不**关闭原指令 ⇒ 仍是 2
    expect(beforeVerification.unfinishedIntentionCount).toBe(2);

    mergeController.verifyInstructionCompletion({
      instructionIdentifier: "ins-1",
      verifiedByGateIdentifier: "completion-gate",
      isAccepted: true,
    });
    const afterVerification = countUnfinishedIntentionsInWindow({
      windowSnapshot: await store.snapshot(),
      mergeController,
    });
    // 逐项核验关闭一条后扣除为 1
    expect(afterVerification.unfinishedIntentionCount).toBe(1);
  });
});
