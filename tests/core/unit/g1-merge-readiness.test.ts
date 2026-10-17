/**
 * G1 Step 3 反例（2026-11-08 第 261 轮）：**受控合并的五门禁**必须 fail-closed。
 *
 * 依据原文：
 * - `AGENTS.md`：「次级只有在**提交哈希、测试、验收、人工体验和操作授权**门禁均满足时
 *   才能判定 `merge-ready`，否则必须返修或等待用户。」
 * - `MERGE01_NODECTX01_TASK_CARDS.md`：「**人工体验结论与 Linux/macOS 平台证据只能由用户/平台提供**」。
 *
 * 因此本文件断言：**任一缺失 ⇒ 不可合并**；后两门（人工体验/操作授权）**空串也算缺失**
 * （不得由 Agent 推断或代填）。
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

import { evaluateGitMergeReadiness } from "../../../packages/core/src/orchestration/git-merge-readiness.js";

/** 五门全满足的基线证据。 */
function buildAllGatesSatisfied() {
  return {
    commitHash: "0123456789abcdef0123456789abcdef01234567",
    areTestsPassed: true,
    isAcceptancePassed: true,
    humanExperienceConclusion: "人工体验通过（2026-11-08，用户）",
    operationAuthorizationIdentifier: "authz-2026-11-08-001",
  };
}

describe("G1 Step 3：五门禁 fail-closed", () => {
  it("五门全满足 ⇒ merge-ready", () => {
    const result = evaluateGitMergeReadiness(buildAllGatesSatisfied());
    expect(result.isMergeReady).toBe(true);
    expect(result.unmetGateNames).toEqual([]);
  });

  it("缺提交哈希 ⇒ 不可合并，且点名「提交哈希」", () => {
    const result = evaluateGitMergeReadiness({ ...buildAllGatesSatisfied(), commitHash: null });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toContain("提交哈希");
  });

  it("测试未通过 ⇒ 不可合并", () => {
    const result = evaluateGitMergeReadiness({ ...buildAllGatesSatisfied(), areTestsPassed: false });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toContain("测试");
  });

  it("验收未通过 ⇒ 不可合并", () => {
    const result = evaluateGitMergeReadiness({
      ...buildAllGatesSatisfied(),
      isAcceptancePassed: false,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toContain("验收");
  });

  it("**人工体验结论缺失** ⇒ 不可合并（只能由用户/平台提供）", () => {
    const result = evaluateGitMergeReadiness({
      ...buildAllGatesSatisfied(),
      humanExperienceConclusion: null,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toContain("人工体验");
  });

  it("**操作授权缺失** ⇒ 不可合并（只能由用户逐次给出）", () => {
    const result = evaluateGitMergeReadiness({
      ...buildAllGatesSatisfied(),
      operationAuthorizationIdentifier: null,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toContain("操作授权");
  });

  it("空串不算满足（不得用空白占位绕过）", () => {
    const result = evaluateGitMergeReadiness({
      ...buildAllGatesSatisfied(),
      humanExperienceConclusion: "   ",
      operationAuthorizationIdentifier: "",
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toEqual(["人工体验", "操作授权"]);
  });

  it("**当前产品装配**（所有证据都为空）⇒ 五项全部缺失 ⇒ 永不合并", () => {
    const result = evaluateGitMergeReadiness({
      commitHash: null,
      areTestsPassed: false,
      isAcceptancePassed: false,
      humanExperienceConclusion: null,
      operationAuthorizationIdentifier: null,
    });
    expect(result.isMergeReady).toBe(false);
    expect(result.unmetGateNames).toEqual(["提交哈希", "测试", "验收", "人工体验", "操作授权"]);
  });
});
