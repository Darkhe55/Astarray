/**
 * MERGE-01 反例（2026-10-10）：**执行组到原指令映射**与**合并开关**。
 *
 * 卡内 §1.1/§1.2 明文：
 *  - "原始用户指令**追加保存**，保留每条**来源、ID、revision、优先级、取消权和验收条件**；
 *    执行组**仅引用原指令**，**不能覆盖原文、伪装用户指令或自动认定被合并项完成**"；
 *  - "SMART 窗口按**原始未完成意图**计数，**不按执行组数量**计数：
 *    窗口 3 条不能通过合并塞入第 4 条。**未准入候选只保存关联**，轮到它时可复用已验证结果；
 *    **组完成不自动关闭全部原指令**，逐项由本地门禁核验"。
 *
 * 现状缺口：本卡此前只有"参数级授权"一片落地；"执行组→原指令映射"与"合并开关"
 * **完全没有实现** ⇒ 上面两条硬约束无判定点。
 *
 * 本片钉住的语义（全部 fail-closed）：
 *  - 执行组**必须有**映射到的原指令（空映射的组不得存在）；
 *  - 组的引用必须绑定**原指令的 revision 与内容指纹**；原指令被改写 ⇒ 引用**失效**；
 *  - **不得覆盖原文**：组不得携带"替换原指令文本"的字段/能力；
 *  - **不得伪装用户指令**：由组派生的内容必须标记为派生物，来源保持原指令；
 *  - **合并开关关闭**时不得新建组（未准入候选**只保存关联**）；
 *  - **窗口按原始未完成意图计数**：合并**不能**让未完成意图数超过窗口容量；
 *  - **组完成不自动关闭原指令**：原指令只能由**逐项本地核验**关闭。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  createInstructionMergeController,
  type OriginalInstructionRecord,
} from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";

function buildInstruction(
  overrides: Partial<OriginalInstructionRecord> = {},
): OriginalInstructionRecord {
  return {
    instructionIdentifier: "ins-1",
    instructionText: "请实现报告功能",
    sourceKind: "user",
    sourceActorIdentifier: "user-1",
    revision: 1,
    priorityTier: 0,
    cancellationRightHolderIdentifier: "user-1",
    acceptanceCriteria: ["报告可下载"],
    isCompleted: false,
    ...overrides,
  };
}

function buildController(options?: { isMergeEnabled?: boolean; windowCapacity?: number }) {
  return createInstructionMergeController({
    isMergeEnabled: options?.isMergeEnabled ?? true,
    windowCapacity: options?.windowCapacity ?? 3,
  });
}

describe("MERGE-01：执行组必须有原指令映射", () => {
  it("① 没有映射到任何原指令的执行组不得存在", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction());
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: [],
      createdByAgentInstanceId: "agent-1",
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/映射|原指令|空/);
  });

  it("② 引用不存在的原指令必须被拒", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction());
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-does-not-exist"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/不存在|未找到/);
  });

  it("③ 合法组创建后必须给出**逐项可追溯**映射（来源/ID/revision/优先级/取消权/验收）", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-1" }));
    controller.appendInstruction(
      buildInstruction({
        instructionIdentifier: "ins-2",
        instructionText: "请补充导出",
        priorityTier: 1,
        acceptanceCriteria: ["可导出 CSV"],
      }),
    );
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(outcome.isCreated).toBe(true);
    const mapping = controller.describeGroupMapping({ groupIdentifier: "group-1" });
    expect(mapping).toHaveLength(2);
    const first = mapping.find((entry) => entry.instructionIdentifier === "ins-1");
    expect(first?.sourceKind).toBe("user");
    expect(first?.sourceActorIdentifier).toBe("user-1");
    expect(first?.revision).toBe(1);
    expect(first?.priorityTier).toBe(0);
    expect(first?.cancellationRightHolderIdentifier).toBe("user-1");
    expect(first?.acceptanceCriteria).toEqual(["报告可下载"]);
    // 原文必须**逐字保留**
    expect(first?.instructionText).toBe("请实现报告功能");
  });
});

describe("MERGE-01：不得覆盖原文、不得伪装用户指令", () => {
  it("④ 原指令被改写（revision 前进）后，旧组的引用必须**失效**", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction());
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1"],
      createdByAgentInstanceId: "agent-1",
    });
    // 原指令被追加为新 revision（内容变化）
    controller.appendInstruction(
      buildInstruction({ revision: 2, instructionText: "请实现报告功能（含 PDF）" }),
    );
    const validity = controller.isGroupReferenceStillValid({ groupIdentifier: "group-1" });
    expect(validity.isValid).toBe(false);
    expect(String(validity.reason)).toMatch(/revision|失效|变化/);
  });

  it("⑤ 组派生的内容必须标记为派生物，**来源仍是原指令**（不得伪装成用户指令）", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction());
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1"],
      createdByAgentInstanceId: "agent-1",
    });
    const derived = controller.createDerivedWorkItem({
      groupIdentifier: "group-1",
      derivedText: "拆分为三步执行",
      producedByAgentInstanceId: "agent-1",
    });
    expect(derived.sourceKind).toBe("group-derivative");
    expect(derived.sourceKind).not.toBe("user");
    expect(derived.originatingInstructionIdentifiers).toEqual(["ins-1"]);
    // 不得携带"覆盖原指令文本"的能力
    expect(derived.isOriginalInstructionTextOverridden).toBe(false);
  });
});

describe("MERGE-01：合并开关与窗口计数", () => {
  it("⑥ 合并开关关闭时不得新建组，但**候选只保存关联**", () => {
    const controller = buildController({ isMergeEnabled: false });
    controller.appendInstruction(buildInstruction());
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/合并开关|关闭|未启用/);
    // 候选关联仍被保存（轮到时可用）
    expect(controller.listCandidateAssociations()).toHaveLength(1);
    expect(controller.listCandidateAssociations()[0]?.instructionIdentifier).toBe("ins-1");
  });

  it("⑦ 窗口按**原始未完成意图**计数：合并不得让第 4 条塞进容量 3 的窗口", () => {
    const controller = buildController({ windowCapacity: 3 });
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-1" }));
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-2" }));
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-3" }));
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-4" }));
    // 把 1..3 合为一组：未完成**原始意图数仍是 4**
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(controller.countUnfinishedOriginalIntentions()).toBe(4);
    expect(controller.isWindowCapacityExceeded()).toBe(true);
    // 组数只有 1，但**不得**据此认为窗口没满
    expect(controller.countExecutionGroups()).toBe(1);
  });

  it("⑧ 已完成的原指令不计入未完成意图", () => {
    const controller = buildController({ windowCapacity: 3 });
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-1" }));
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-2" }));
    controller.appendInstruction(
      buildInstruction({ instructionIdentifier: "ins-3", isCompleted: true }),
    );
    expect(controller.countUnfinishedOriginalIntentions()).toBe(2);
    expect(controller.isWindowCapacityExceeded()).toBe(false);
  });
});

describe("MERGE-01：组完成不自动关闭原指令", () => {
  it("⑨ 组标记完成后，原指令**仍为未完成**，必须逐项核验才能关闭", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-1" }));
    controller.appendInstruction(buildInstruction({ instructionIdentifier: "ins-2" }));
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
    });
    controller.markGroupCompleted({ groupIdentifier: "group-1" });
    expect(controller.isInstructionCompleted("ins-1")).toBe(false);
    expect(controller.isInstructionCompleted("ins-2")).toBe(false);
    expect(controller.countUnfinishedOriginalIntentions()).toBe(2);

    // 逐项本地核验通过后才关闭其中一条
    const firstVerification = controller.verifyInstructionCompletion({
      instructionIdentifier: "ins-1",
      verifiedByGateIdentifier: "completion-gate",
      isAccepted: true,
    });
    expect(firstVerification.isCompleted).toBe(true);
    expect(controller.isInstructionCompleted("ins-1")).toBe(true);
    expect(controller.isInstructionCompleted("ins-2")).toBe(false);
    expect(controller.countUnfinishedOriginalIntentions()).toBe(1);
  });

  it("⑩ 核验**不通过**时不得关闭原指令（fail-closed）", () => {
    const controller = buildController();
    controller.appendInstruction(buildInstruction());
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1"],
      createdByAgentInstanceId: "agent-1",
    });
    controller.markGroupCompleted({ groupIdentifier: "group-1" });
    const verification = controller.verifyInstructionCompletion({
      instructionIdentifier: "ins-1",
      verifiedByGateIdentifier: "completion-gate",
      isAccepted: false,
    });
    expect(verification.isCompleted).toBe(false);
    expect(controller.isInstructionCompleted("ins-1")).toBe(false);
  });
});
