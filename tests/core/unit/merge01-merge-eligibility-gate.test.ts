/**
 * MERGE-01-02 反例（2026-10-10）：**资格判定必须真正把住建组这道门**。
 *
 * 卡内 §1.1：合并必须"**本地检查后才采纳**"，且只有够格的指令才可合并。
 *
 * 现状缺口（本轮实测）：上一轮交付了 `evaluateInstructionMergeEligibility()`，
 * 但 `createInstructionMergeController().createExecutionGroup()` **完全没有调用它**
 * ⇒ 判定层与建组层**各自成立却互不相识**：
 * 跨项目 / 语义冲突 / 目标不明 / 在途副作用 / 依赖未 ready 的指令**照样能建组**，
 * §1.1 的排除规则在**真实装配路径上并不生效**。
 *
 * 本片钉住的语义：
 *  - 建组必须**逐条**通过资格判定；任一不够格 ⇒ **拒绝建组**并给出**具体原因**；
 *  - 跨项目 / 语义冲突 / 目标不明 / 独立授权 / 在途副作用 / 依赖未 ready 一律拒绝；
 *  - 存在明确 `supersedes` ⇒ 拒绝建组（走取代语义）；
 *  - **够格时行为不变**（既有建组与映射能力保留）；
 *  - **未提供资格数据 ⇒ fail-closed 拒绝**（不得"没数据就当通过"）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  createInstructionMergeController,
  type InstructionMergeCandidate,
} from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";

function buildCandidate(
  instructionIdentifier: string,
  overrides: Partial<InstructionMergeCandidate> = {},
): InstructionMergeCandidate {
  return {
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
    ...overrides,
  };
}

/** 把候选登记为**原指令记录**（建组要求引用真实存在的原指令）。 */
function registerOriginals(
  controller: ReturnType<typeof createInstructionMergeController>,
  candidates: readonly InstructionMergeCandidate[],
): void {
  for (const candidate of candidates) {
    controller.appendInstruction({
      instructionIdentifier: candidate.instructionIdentifier,
      instructionText: candidate.instructionText,
      sourceKind: "user",
      sourceActorIdentifier: "user-1",
      revision: candidate.revision,
      priorityTier: candidate.priorityTier,
      cancellationRightHolderIdentifier: "user-1",
      acceptanceCriteria: ["完成"],
      isCompleted: false,
    });
  }
}

function buildController(options?: { isMergeEnabled?: boolean }) {
  return createInstructionMergeController({
    isMergeEnabled: options?.isMergeEnabled ?? true,
    windowCapacity: 8,
  });
}

describe("MERGE-01-02：资格判定必须把住建组这道门", () => {
  it("① 全部够格 ⇒ 允许建组（既有能力不退化）", () => {
    const controller = buildController();
    const candidates = [buildCandidate("ins-1"), buildCandidate("ins-2")];
    registerOriginals(controller, candidates);
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: candidates,
    });
    expect(outcome.isCreated).toBe(true);
    expect(controller.describeGroupMapping({ groupIdentifier: "group-1" })).toHaveLength(2);
  });

  it("② 跨项目 ⇒ **拒绝建组**并指出具体原因（判定在装配路径上真实生效）", () => {
    const controller = buildController();
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [
        buildCandidate("ins-1"),
        buildCandidate("ins-2", { projectIdentifier: "project-beta" }),
      ],
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/跨项目|项目/);
    // 被拒 ⇒ 不得留下任何组映射
    expect(controller.describeGroupMapping({ groupIdentifier: "group-1" })).toEqual([]);
  });

  it("③ 语义冲突 / 目标不明 / 独立授权 / 在途副作用 / 依赖未 ready 均拒绝建组", () => {
    const rejectedCases: Array<{ name: string; overrides: Partial<InstructionMergeCandidate> }> = [
      { name: "语义冲突", overrides: { isSemanticallyConflicting: true } },
      { name: "目标不明", overrides: { isGoalAmbiguous: true } },
      { name: "独立授权", overrides: { requiresIndependentAuthorization: true } },
      { name: "在途副作用", overrides: { hasSideEffectInFlight: true } },
      {
        name: "依赖未 ready",
        overrides: {
          dependencyNodeIdentifiers: ["node-predecessor"],
          completedDependencyNodeIdentifiers: [],
        },
      },
    ];
    for (const rejectedCase of rejectedCases) {
      const controller = buildController();
      const outcome = controller.createExecutionGroup({
        groupIdentifier: "group-1",
        referencedInstructionIdentifiers: ["ins-1", "ins-2"],
        createdByAgentInstanceId: "agent-1",
        mergeCandidates: [
          buildCandidate("ins-1"),
          buildCandidate("ins-2", rejectedCase.overrides),
        ],
      });
      expect(outcome.isCreated, rejectedCase.name + " 必须被拒绝").toBe(false);
      expect(controller.describeGroupMapping({ groupIdentifier: "group-1" })).toEqual([]);
    }
  });

  it("④ 明确 supersedes ⇒ 拒绝建组（走取代语义，不按最新文本猜测）", () => {
    const controller = buildController();
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [
        buildCandidate("ins-1"),
        buildCandidate("ins-2", { supersedesInstructionIdentifiers: ["ins-1"] }),
      ],
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/supersedes|取代/);
  });

  it("⑤ **未提供资格数据 ⇒ fail-closed 拒绝**（不得'没数据就当通过'）", () => {
    const controller = buildController();
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/资格|未提供|候选|判定/);
    expect(controller.describeGroupMapping({ groupIdentifier: "group-1" })).toEqual([]);
  });

  it("⑥ 合并开关关闭时仍**优先**按开关拒绝（既有语义不回退）", () => {
    const controller = buildController({ isMergeEnabled: false });
    const outcome = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: [buildCandidate("ins-1"), buildCandidate("ins-2")],
    });
    expect(outcome.isCreated).toBe(false);
    expect(String(outcome.reason)).toMatch(/合并开关|未启用/);
  });
});
