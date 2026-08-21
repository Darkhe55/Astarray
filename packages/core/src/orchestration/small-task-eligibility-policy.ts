/**
 * 小任务直投资格策略（T08C-02 / ADR-0025 §1）。
 *
 * "适合直达"的自动建议只能来自本地版本化资格策略；模型不得自行判定。
 * 默认要求：目标和验收标准明确、无需方案讨论、影响范围有界、
 * 不修改总体架构或公共契约、不含未决高风险裁决、没有跨项目协调。
 * 任一项不满足或无法确定时按 fail-closed 回到主 Agent。
 */
import { DomainError } from "../core/errors.js";

/** 资格策略版本（变更即需重新评估；冻结决策）。 */
export const SMALL_TASK_ELIGIBILITY_RULES_VERSION = 1;

export interface SmallTaskEligibilityInput {
  /** 目标/范围描述（有界）。 */
  scopeDescription: string;
  /** 验收标准（可核对）。 */
  acceptanceCriteria: string;
  /** 是否需要方案讨论（true → 不直达）。 */
  requiresDesignDiscussion: boolean;
  /** 是否修改总体架构或公共契约（true → 不直达）。 */
  modifiesArchitectureOrPublicContract: boolean;
  /** 是否含未决高风险裁决（true → 不直达）。 */
  hasUnresolvedHighRiskRuling: boolean;
  /** 是否跨项目协调（true → 不直达）。 */
  requiresCrossProjectCoordination: boolean;
}

export interface SmallTaskEligibilityResult {
  /** true = 适合直投；false = 回到主 Agent。 */
  isEligible: boolean;
  /** 不直达原因（isEligible=true 时为 null）。 */
  ineligibilityReason: string | null;
  rulesVersion: number;
}

/** 本地版本化资格策略：确定性判定，无法确定时 fail-closed。 */
export class SmallTaskEligibilityPolicy {
  evaluateEligibility(
    input: SmallTaskEligibilityInput,
  ): SmallTaskEligibilityResult {
    const ineligibilityReasons: string[] = [];
    if (input.scopeDescription.trim() === "") {
      ineligibilityReasons.push("任务范围描述为空");
    }
    if (input.acceptanceCriteria.trim() === "") {
      ineligibilityReasons.push("缺少可核对的验收标准");
    }
    if (input.requiresDesignDiscussion) {
      ineligibilityReasons.push("需要方案讨论");
    }
    if (input.modifiesArchitectureOrPublicContract) {
      ineligibilityReasons.push("修改总体架构或公共契约");
    }
    if (input.hasUnresolvedHighRiskRuling) {
      ineligibilityReasons.push("含未决高风险裁决");
    }
    if (input.requiresCrossProjectCoordination) {
      ineligibilityReasons.push("需要跨项目协调");
    }
    if (ineligibilityReasons.length > 0) {
      return {
        isEligible: false,
        ineligibilityReason: ineligibilityReasons.join("；"),
        rulesVersion: SMALL_TASK_ELIGIBILITY_RULES_VERSION,
      };
    }
    return {
      isEligible: true,
      ineligibilityReason: null,
      rulesVersion: SMALL_TASK_ELIGIBILITY_RULES_VERSION,
    };
  }
}

/** 供 DomainError 校验规则版本的辅助（校验失败时给出明确原因）。 */
export function assertEligibilityRulesVersion(
  actualRulesVersion: number,
): void {
  if (actualRulesVersion !== SMALL_TASK_ELIGIBILITY_RULES_VERSION) {
    throw new DomainError(
      "invalid-task-chain",
      `小任务资格规则版本不匹配: ${actualRulesVersion}，期望 ${SMALL_TASK_ELIGIBILITY_RULES_VERSION}`,
    );
  }
}
