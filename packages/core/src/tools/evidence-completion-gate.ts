/**
 * 证据完成门禁（T06D / ADR-0016）。
 * 高严谨性任务结案前检查有效 EvidenceBundle：
 * - 必须调用过 factVerification（存在证据包）；
 * - 关键主张必须被覆盖（entries 非空且 relation 不是 unavailable）；
 * - 仅纯推理（无来源正文/本地实验）不足以宣称完成。
 * 门禁未满足 → 任务不得宣称完成；应补证或向用户明确报告"证据不足/工具不可用"。
 * 门禁通过只说明验证流程已执行，不替用户作最终合格判断。
 */
import type { EvidenceBundle } from "../core/types.js";

export interface EvidenceCompletionGateResult {
  isPassable: boolean;
  /** 未满足项（可读原因）。 */
  unmetRequirements: string[];
}

export class EvidenceCompletionGate {
  /** 检查证据包是否满足高严谨性任务的完成门禁。 */
  evaluateEvidenceBundle(
    bundle: EvidenceBundle | null,
    options: {
      requiredClaimIdentifier: string;
      requireSourceText: boolean;
    },
  ): EvidenceCompletionGateResult {
    const unmetRequirements: string[] = [];
    if (bundle === null) {
      unmetRequirements.push("未调用 factVerification，缺少证据包");
      return { isPassable: false, unmetRequirements };
    }
    if (bundle.claimIdentifier !== options.requiredClaimIdentifier) {
      unmetRequirements.push(
        `证据包主张 ${bundle.claimIdentifier} 与任务关键主张 ${options.requiredClaimIdentifier} 不一致`,
      );
    }
    if (bundle.entries.length === 0) {
      unmetRequirements.push("证据包为空，关键主张未被覆盖");
    }
    if (bundle.relation === "unavailable") {
      unmetRequirements.push("证据不可用（离线/搜索失败），不得宣称已证实");
    }
    if (
      options.requireSourceText &&
      bundle.entries.filter((entry) => entry.entryType === "source").length === 0
    ) {
      unmetRequirements.push("关键主张缺少可定位的资料正文（仅推理/实验不足）");
    }
    return {
      isPassable: unmetRequirements.length === 0,
      unmetRequirements,
    };
  }
}
