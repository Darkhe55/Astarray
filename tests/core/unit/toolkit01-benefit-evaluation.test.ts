/**
 * TOOLKIT-01-02/06 反例（2026-10-10）：**收益判断**（复用前的证据化评估）。
 *
 * 卡内 §2 原文："收益判断**不设机械重复次数门槛**：记录**预计复用次数、单次节省、
 * 构建/验证/维护成本及不确定性**。自动发现**只提案**，不按高频日志自动批量造工具；
 * 自动节点保持 Agent 来源和优先层级 1 或以下。"
 *
 * 现状缺口：本卡此前只有"能不能用"（登记/作用域/隔离/包验收），
 * **没有"值不值得做"的判定** ⇒ 检查点 06 要求的"收益评估"与 §2 的收益纪律均无落地。
 *
 * 本片钉住的语义：
 *  - 必须**逐项记录**复用次数、单次节省、构建/验证/维护成本与不确定性；
 *  - **不设机械重复次数门槛**：低复用次数但高单次节省，只要净收益为正就应建议采用
 *    （不得写成"次数 < N 一律不做"）；
 *  - 缺失任一必需项 ⇒ **拒绝/不完整**（fail-closed，不得用默认值悄悄补 0）；
 *  - **不得伪造精确数字**：输入为区间/不确定时必须保留不确定性说明，
 *    并明确标注是否"高不确定性导致结论不可靠"；
 *  - **自动发现只提案**：来源为自动发现时，结论**最多**是"提案"，
 *    绝不能得出"直接创建/启用"；
 *  - 自动节点的优先层级必须 ≤ 1。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateToolBenefit,
  type ToolBenefitEvidence,
} from "../../../packages/core/src/toolkit/tool-benefit-evaluation.js";

function buildEvidence(
  overrides: Partial<ToolBenefitEvidence> = {},
): ToolBenefitEvidence {
  return {
    candidateIdentifier: "candidate-test-report",
    discoverySource: "user-request",
    /** 预计复用次数（含区间：低/高）。 */
    expectedReuseCountRange: { minimum: 30, maximum: 50 },
    /** 单次节省（分钟）。 */
    savedMinutesPerUse: { minimum: 10, maximum: 20 },
    /** 构建成本（分钟）。 */
    buildCostMinutes: 60,
    /** 验证成本（分钟）。 */
    verificationCostMinutes: 30,
    /** 维护成本（每次复用摊销分钟）。 */
    maintenanceCostMinutesPerUse: 2,
    /** 不确定性说明（**必须显式记录**，不得留空）。 */
    uncertaintyNotes: ["复用次数来自单次观察，可能高估"],
    /** 自动来源节点的优先层级（仅自动来源相关）。 */
    agentPriorityTier: 1,
    ...overrides,
  };
}

describe("TOOLKIT-01：收益判断必须逐项记录证据", () => {
  it("① 证据齐全且净收益为正 ⇒ 建议采用，并给出各项记录", () => {
    const outcome = evaluateToolBenefit(buildEvidence());
    expect(outcome.isEvidenceComplete).toBe(true);
    expect(outcome.recommendation).toBe("adopt");
    expect(outcome.netSavedMinutes).toBeGreaterThan(0);
    expect(outcome.evidenceSummary).toContain("复用次数");
    expect(outcome.evidenceSummary).toContain("单次节省");
    expect(outcome.evidenceSummary).toContain("构建");
    expect(outcome.evidenceSummary).toContain("不确定性");
  });

  it("② 缺失任一必需项 ⇒ 证据不完整且**不得**给出 adopt（fail-closed）", () => {
    const requiredKeys = [
      "expectedReuseCountRange",
      "savedMinutesPerUse",
      "buildCostMinutes",
      "verificationCostMinutes",
      "maintenanceCostMinutesPerUse",
      "uncertaintyNotes",
    ] as const;
    for (const key of requiredKeys) {
      const evidence = buildEvidence();
      delete (evidence as unknown as Record<string, unknown>)[key];
      const outcome = evaluateToolBenefit(evidence as ToolBenefitEvidence);
      expect(
        outcome.isEvidenceComplete,
        "缺失 " + key + " 必须判为证据不完整（实际 recommendation=" + outcome.recommendation + ", reason=" + String(outcome.reason) + "）",
      ).toBe(false);
      expect(outcome.recommendation).not.toBe("adopt");
    }
    // 不确定性说明为空数组等同于"未记录"
    const emptyUncertainty = evaluateToolBenefit(buildEvidence({ uncertaintyNotes: [] }));
    expect(emptyUncertainty.isEvidenceComplete).toBe(false);
  });

  it("③ **不设机械重复次数门槛**：复用次数很低但单次节省很高仍应建议采用", () => {
    const outcome = evaluateToolBenefit(
      buildEvidence({
        expectedReuseCountRange: { minimum: 2, maximum: 2 },
        savedMinutesPerUse: { minimum: 600, maximum: 600 },
        buildCostMinutes: 60,
        verificationCostMinutes: 30,
        maintenanceCostMinutesPerUse: 0,
      }),
    );
    expect(outcome.recommendation).toBe("adopt");
    // 明确标注"未使用机械次数门槛"，避免被误读成通过次数阈值
    expect(outcome.isRepetitionThresholdApplied).toBe(false);
  });

  it("④ 净收益为负 ⇒ 建议不做（并给出原因）", () => {
    const outcome = evaluateToolBenefit(
      buildEvidence({
        expectedReuseCountRange: { minimum: 1, maximum: 1 },
        savedMinutesPerUse: { minimum: 1, maximum: 1 },
        buildCostMinutes: 600,
        verificationCostMinutes: 300,
        maintenanceCostMinutesPerUse: 5,
      }),
    );
    expect(outcome.recommendation).toBe("do-not-adopt");
    expect(String(outcome.reason)).toMatch(/净收益|成本|不值得/);
  });

  it("⑤ 高不确定性导致结论不可靠时必须显式标注（不得当作确定结论）", () => {
    const outcome = evaluateToolBenefit(
      buildEvidence({
        expectedReuseCountRange: { minimum: 20, maximum: 5_000 },
        savedMinutesPerUse: { minimum: 20, maximum: 2_000 },
        uncertaintyNotes: ["复用次数与单次节省均只有一次观察，区间极宽"],
      }),
    );
    expect(outcome.isConclusionReliable).toBe(false);
    // 不可靠时不得声称"确定采用"
    expect(outcome.recommendation).not.toBe("adopt");
    expect(outcome.recommendation).toBe("propose");
    expect(String(outcome.reason)).toMatch(/不确定|不可靠/);
  });

  it("⑥ 自动发现来源**只提案**：绝不直接给出 adopt/创建", () => {
    const outcome = evaluateToolBenefit(
      buildEvidence({ discoverySource: "automatic-discovery" }),
    );
    expect(outcome.recommendation).toBe("propose");
    expect(outcome.isAdoptionAuthorized).toBe(false);
    // 即便净收益为正也不得自动采用
    expect(outcome.netSavedMinutes).toBeGreaterThan(0);
  });

  it("⑦ 自动来源节点的优先层级必须 ≤ 1；越界即拒绝", () => {
    const tooHighTier = evaluateToolBenefit(
      buildEvidence({ discoverySource: "automatic-discovery", agentPriorityTier: 2 }),
    );
    expect(tooHighTier.isEvidenceComplete).toBe(false);
    expect(String(tooHighTier.reason)).toMatch(/优先层级|层级|tier/);

    const tierZero = evaluateToolBenefit(
      buildEvidence({ discoverySource: "automatic-discovery", agentPriorityTier: 0 }),
    );
    expect(tierZero.isEvidenceComplete).toBe(true);
  });

  it("⑧ 用户显式请求不受自动节点层级限制（但层级越界仍应记录）", () => {
    const userRequested = evaluateToolBenefit(
      buildEvidence({ discoverySource: "user-request", agentPriorityTier: 3 }),
    );
    // 用户来源不以层级判定证据完整性
    expect(userRequested.isEvidenceComplete).toBe(true);
  });

  it("⑨ 净收益计算必须用**区间下限**（保守），不得用上限乐观估计", () => {
    const conservative = evaluateToolBenefit(
      buildEvidence({
        expectedReuseCountRange: { minimum: 2, maximum: 100 },
        savedMinutesPerUse: { minimum: 10, maximum: 100 },
        buildCostMinutes: 60,
        verificationCostMinutes: 30,
        maintenanceCostMinutesPerUse: 0,
      }),
    );
    // 下限口径：2 次 × 10 分钟 = 20 分钟毛收益，减 60+30 = -70
    expect(conservative.netSavedMinutes).toBe(-70);
    expect(conservative.recommendation).toBe("do-not-adopt");
    expect(conservative.isEstimatedFromRangeMinimum).toBe(true);
  });
});
