/**
 * MERGE-01 反例（2026-10-10）：**确定性合并的资格判定**。
 *
 * 卡内 §1.1 明文：
 *  - "**第一版仅做确定性去重/明确补充合并**；模型可提出相似候选，**本地检查后才采纳**，
 *    不引入独立长时合并模型"；
 *  - "**只合并同项目、同任务权威、相容目标和权限作用域的 ready 指令**；
 *    保留前驱/后继偏序，**不跨依赖障碍**；**语义冲突、目标不明、独立授权、跨项目、
 *    已产生副作用的在途操作不合并**"；
 *  - "用户明确修订走 **supersedes**，**不按"最新文本"猜测废弃旧任务**"；
 *  - "多项可共用一次读取/检索，但**每个子结果映射回原 ID**；**部分失败只影响对应节点**；
 *    取消一项**不得取消其他项**，**执行后不能通过拆组合并重放副作用**"；
 *  - "指令合并提供**独立开关，初始关闭**；用户启用后运行以上保守规则。
 *    **关闭后不丢组内原指令，不重放在途操作，安全点拆回未执行项**"。
 *
 * 现状缺口：检查点 01 只交付了"执行组容器 + 合并开关"（能否建组），
 * **完全没有**"哪些指令**够格**被合并"的判定 ⇒ §1.1 那串排除规则无判定点。
 *
 * 本片钉住的语义（全部 fail-closed）：
 *  - 跨项目 / 独立授权 / 权限作用域不同 ⇒ **不合并**；
 *  - 语义冲突 / 目标不明 ⇒ **不合并**；
 *  - 依赖未 ready（前驱未完成）⇒ **不合并**；
 *  - **已产生副作用的在途操作** ⇒ **不合并**；
 *  - 明确 `supersedes` 关系 ⇒ 走取代语义，**不按最新文本猜测**；
 *  - 可合并时给出**逐条理由**与**每个子结果映射回原 ID**的映射表；
 *  - 开关**初始关闭**：关闭时**不合并但不丢原指令**，且**安全点可拆回未执行项**。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_INSTRUCTION_MERGE_SETTINGS,
  evaluateInstructionMergeEligibility,
  splitExecutionGroupAtSafetyPoint,
  type InstructionMergeCandidate,
} from "../../../packages/core/src/toolkit/instruction-merge-eligibility.js";

function buildCandidate(
  overrides: Partial<InstructionMergeCandidate> = {},
): InstructionMergeCandidate {
  return {
    instructionIdentifier: "ins-1",
    revision: 1,
    instructionText: "请实现报告功能",
    projectIdentifier: "project-alpha",
    taskAuthorityIdentifier: "task-authority-1",
    permissionScopeIdentifier: "scope-1",
    goalIdentifier: "goal-report",
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

describe("MERGE-01：确定性合并的资格判定", () => {
  it("① 同项目/同任务权威/相容目标/同权限作用域且 ready ⇒ 可合并，并逐条给出映射", () => {
    const outcome = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", instructionText: "请补充导出" }),
      ],
      isMergeEnabled: true,
    });
    expect(outcome.canMerge).toBe(true);
    expect(outcome.mergedInstructionIdentifiers).toEqual(["ins-1", "ins-2"]);
    // **每个子结果映射回原 ID**
    expect(outcome.resultMappingByInstructionIdentifier).toEqual({
      "ins-1": "ins-1",
      "ins-2": "ins-2",
    });
    expect(outcome.rejectedInstructionIdentifiers).toEqual([]);
  });

  it("② 跨项目 ⇒ 不合并", () => {
    const outcome = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", projectIdentifier: "project-beta" }),
      ],
      isMergeEnabled: true,
    });
    expect(outcome.canMerge).toBe(false);
    expect(outcome.rejectedInstructionIdentifiers).toContain("ins-2");
    expect(String(outcome.reason)).toMatch(/跨项目|项目/);
  });

  it("③ 任务权威不同 / 权限作用域不同 ⇒ 不合并", () => {
    const differentAuthority = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", taskAuthorityIdentifier: "other" }),
      ],
      isMergeEnabled: true,
    });
    expect(differentAuthority.canMerge).toBe(false);
    expect(String(differentAuthority.reason)).toMatch(/任务权威|权威/);

    const differentScope = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", permissionScopeIdentifier: "other" }),
      ],
      isMergeEnabled: true,
    });
    expect(differentScope.canMerge).toBe(false);
    expect(String(differentScope.reason)).toMatch(/权限作用域|作用域/);
  });

  it("④ 语义冲突 / 目标不明 ⇒ 不合并", () => {
    const conflicting = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", isSemanticallyConflicting: true }),
      ],
      isMergeEnabled: true,
    });
    expect(conflicting.canMerge).toBe(false);
    expect(String(conflicting.reason)).toMatch(/语义冲突|冲突/);

    const ambiguous = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", isGoalAmbiguous: true }),
      ],
      isMergeEnabled: true,
    });
    expect(ambiguous.canMerge).toBe(false);
    expect(String(ambiguous.reason)).toMatch(/目标不明|不明/);
  });

  it("⑤ 独立授权 / 在途副作用 ⇒ 不合并", () => {
    const needsAuthorization = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", requiresIndependentAuthorization: true }),
      ],
      isMergeEnabled: true,
    });
    expect(needsAuthorization.canMerge).toBe(false);
    expect(String(needsAuthorization.reason)).toMatch(/独立授权|授权/);

    const inFlight = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2", hasSideEffectInFlight: true }),
      ],
      isMergeEnabled: true,
    });
    expect(inFlight.canMerge).toBe(false);
    expect(String(inFlight.reason)).toMatch(/在途|副作用/);
  });

  it("⑥ 依赖未 ready（前驱未完成）⇒ 不合并（不跨依赖障碍）", () => {
    const outcome = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({
          instructionIdentifier: "ins-2",
          dependencyNodeIdentifiers: ["node-predecessor"],
          completedDependencyNodeIdentifiers: [],
        }),
      ],
      isMergeEnabled: true,
    });
    expect(outcome.canMerge).toBe(false);
    expect(outcome.rejectedInstructionIdentifiers).toContain("ins-2");
    expect(String(outcome.reason)).toMatch(/依赖|ready|前驱/);
  });

  it("⑦ 明确 supersedes ⇒ 走取代语义，**不按最新文本猜测**", () => {
    const outcome = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({
          instructionIdentifier: "ins-2",
          revision: 2,
          instructionText: "请实现报告功能（修订）",
          supersedesInstructionIdentifiers: ["ins-1"],
        }),
      ],
      isMergeEnabled: true,
    });
    expect(outcome.canMerge).toBe(false);
    expect(outcome.supersededInstructionIdentifiers).toEqual(["ins-1"]);
    expect(String(outcome.reason)).toMatch(/supersedes|取代|修订/);
  });

  it("⑧ 开关**初始关闭**；关闭时**不合并但不丢原指令**", () => {
    expect(DEFAULT_INSTRUCTION_MERGE_SETTINGS.isMergeEnabled).toBe(false);
    const outcome = evaluateInstructionMergeEligibility({
      candidates: [
        buildCandidate({ instructionIdentifier: "ins-1" }),
        buildCandidate({ instructionIdentifier: "ins-2" }),
      ],
      isMergeEnabled: DEFAULT_INSTRUCTION_MERGE_SETTINGS.isMergeEnabled,
    });
    expect(outcome.canMerge).toBe(false);
    // **不丢原指令**
    expect(outcome.retainedInstructionIdentifiers).toEqual(["ins-1", "ins-2"]);
    expect(String(outcome.reason)).toMatch(/开关|未启用/);
  });

  it("⑨ 关闭后在安全点可**拆回未执行项**，且**不重放在途操作**", () => {
    const outcome = splitExecutionGroupAtSafetyPoint({
      groupIdentifier: "group-1",
      members: [
        { instructionIdentifier: "ins-1", hasExecuted: true, hasSideEffectInFlight: false },
        { instructionIdentifier: "ins-2", hasExecuted: false, hasSideEffectInFlight: false },
        { instructionIdentifier: "ins-3", hasExecuted: false, hasSideEffectInFlight: true },
      ],
    });
    // 已执行的保留（不得重放），在途的不拆（不得重放），只拆**未执行且无在途副作用**的
    expect(outcome.splitBackInstructionIdentifiers).toEqual(["ins-2"]);
    expect(outcome.retainedInstructionIdentifiers).toEqual(["ins-1", "ins-3"]);
    expect(outcome.isSideEffectReplayed).toBe(false);
  });
});
