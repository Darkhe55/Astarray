/**
 * G1 Step 3（2026-11-08 第 261 轮）：**受控合并的五门禁评估**（纯函数，无副作用）。
 *
 * 依据（原文）：
 * - `AGENTS.md`：「次级只有在**提交哈希、测试、验收、人工体验和操作授权**门禁均满足时
 *   才能判定 `merge-ready`，否则必须返修或等待用户。」
 * - `MERGE01_NODECTX01_TASK_CARDS.md`：「**人工体验结论与 Linux/macOS 平台证据只能由用户/平台提供**」。
 *
 * 因此本模块把五门**显式建模**：前三门可由本地判定，后两门**只能由用户/平台提供的证据**满足；
 * 缺任何一门 ⇒ 返回 `isMergeReady: false` 并列出缺口。**本模块不执行合并**，只做判定。
 */

export interface GitMergeReadinessEvidence {
  /** 门①：贡献提交哈希存在且可验证（`GitContributionVerifier` 产出）。 */
  commitHash: string | null;
  /** 门②：集成测试**实际执行**并全绿。 */
  areTestsPassed: boolean;
  /** 门③：独立验收结论通过（实现者不得自验收）。 */
  isAcceptancePassed: boolean;
  /**
   * 门④：**人工体验结论**——只能由用户/平台提供。
   * 空串或 `null` 视为**未提供**（不得由 Agent 推断或代填）。
   */
  humanExperienceConclusion: string | null;
  /**
   * 门⑤：**逐次操作授权标识**——只能由用户逐次给出。
   * `null` 视为未授权（不得用会话记忆、批量许可或 Agent 推断替代）。
   */
  operationAuthorizationIdentifier: string | null;
}

export type GitMergeReadiness =
  | { isMergeReady: true; unmetGateNames: [] }
  | { isMergeReady: false; unmetGateNames: string[] };

/** 五门禁判定：**任一缺失即不可合并**（fail-closed）。 */
export function evaluateGitMergeReadiness(
  evidence: GitMergeReadinessEvidence,
): GitMergeReadiness {
  const unmetGateNames: string[] = [];
  if (evidence.commitHash === null || evidence.commitHash.trim() === "") {
    unmetGateNames.push("提交哈希");
  }
  if (!evidence.areTestsPassed) unmetGateNames.push("测试");
  if (!evidence.isAcceptancePassed) unmetGateNames.push("验收");
  if (
    evidence.humanExperienceConclusion === null ||
    evidence.humanExperienceConclusion.trim() === ""
  ) {
    unmetGateNames.push("人工体验");
  }
  if (
    evidence.operationAuthorizationIdentifier === null ||
    evidence.operationAuthorizationIdentifier.trim() === ""
  ) {
    unmetGateNames.push("操作授权");
  }
  return unmetGateNames.length === 0
    ? { isMergeReady: true, unmetGateNames: [] }
    : { isMergeReady: false, unmetGateNames };
}
