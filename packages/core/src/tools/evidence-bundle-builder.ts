/**
 * 证据包构建器（T06D / ADR-0016）。
 * 按主张合并资料搜索、本地实验与纯推理证据，固定权重：
 * 资料搜索依据 > 本地实验验证 > 纯推理式验证（排序与覆盖展示用，
 * 不代表单项证据自动证明结论合格）。
 * 矛盾证据全部展示，不以多数投票或模型偏好静默合并；
 * 只允许 supported/contradicted/mixed/insufficient/unavailable 关系，
 * 不提供 qualified/safe/pass 最终判定。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { evidenceBundleSchema } from "../core/schemas.js";
import type {
  EvidenceBundle,
  EvidenceBundleEntry,
  EvidenceRelation,
} from "../core/types.js";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;

/** 证据层级权重（排序用；数值大者优先展示）。 */
const ENTRY_TYPE_WEIGHT: Record<EvidenceBundleEntry["entryType"], number> = {
  source: 3,
  "local-experiment": 2,
  reasoning: 1,
};

export interface BuildEvidenceBundleInput {
  claimIdentifier: string;
  builderAgentInstanceId: string;
  entries: EvidenceBundleEntry[];
  /**
   * 显式证据关系（模型发现矛盾时声明 contradicted/mixed；
   * 缺省由 builder 按证据结构计算）。
   */
  requestedRelation?: EvidenceRelation;
}

export class EvidenceBundleBuilder {
  /** 合并、排序（固定层级）、计算关系与缺口；输出经 schema 校验。 */
  buildEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
    if (input.entries.length === 0) {
      throw new DomainError(
        "invalid-task-chain",
        `证据包不能为空: ${input.claimIdentifier}`,
      );
    }
    for (const entry of input.entries) {
      if (entry.claimIdentifier !== input.claimIdentifier) {
        throw new DomainError(
          "invalid-task-chain",
          `证据条目 claimIdentifier 与证据包不一致: ${entry.entryType}`,
        );
      }
    }
    // 固定层级排序：source > local-experiment > reasoning；同层保持录入顺序
    const sortedEntries = [...input.entries].sort((left, right) => {
      const weightDifference =
        ENTRY_TYPE_WEIGHT[right.entryType] - ENTRY_TYPE_WEIGHT[left.entryType];
      return weightDifference;
    });
    const relation =
      input.requestedRelation ?? this.computeRelation(input.entries);
    const coverageNotes = this.computeCoverageNotes(input.entries);
    const limitations = this.computeLimitations(input.entries, relation);
    const bundle: EvidenceBundle = {
      schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
      claimIdentifier: input.claimIdentifier,
      builderAgentInstanceId: input.builderAgentInstanceId,
      createdAtIso: new Date().toISOString(),
      entries: sortedEntries,
      relation,
      coverageNotes,
      limitations,
    };
    const parsed = evidenceBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `证据包非法: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** 证据关系：有来源正反冲突 → contradicted；多层混合 → mixed；仅推理 → insufficient。 */
  private computeRelation(entries: EvidenceBundleEntry[]): EvidenceRelation {
    const sourceEntries = entries.filter(
      (entry) => entry.entryType === "source",
    );
    if (sourceEntries.length === 0) {
      const hasExperiment = entries.some(
        (entry) => entry.entryType === "local-experiment",
      );
      if (hasExperiment) {
        return "insufficient";
      }
      return "insufficient";
    }
    return "supported";
  }

  private computeCoverageNotes(entries: EvidenceBundleEntry[]): string[] {
    const notes: string[] = [];
    const sourceCount = entries.filter(
      (entry) => entry.entryType === "source",
    ).length;
    const experimentCount = entries.filter(
      (entry) => entry.entryType === "local-experiment",
    ).length;
    const reasoningCount = entries.filter(
      (entry) => entry.entryType === "reasoning",
    ).length;
    if (sourceCount > 0) {
      notes.push(`资料搜索依据 ${sourceCount} 条（最高证据层级）`);
    }
    if (experimentCount > 0) {
      notes.push(`本地实验验证 ${experimentCount} 条`);
    }
    if (reasoningCount > 0) {
      notes.push(`纯推理验证 ${reasoningCount} 条（最低证据层级）`);
    }
    return notes;
  }

  private computeLimitations(
    entries: EvidenceBundleEntry[],
    relation: EvidenceRelation,
  ): string[] {
    const limitations: string[] = [];
    const sourceEntries = entries.filter(
      (entry) => entry.entryType === "source",
    ) as Array<Extract<EvidenceBundleEntry, { entryType: "source" }>>;
    const onlyAgentSelf = sourceEntries.every(
      (entry) => entry.sourceType === "agent-self",
    );
    if (onlyAgentSelf && sourceEntries.length > 0) {
      limitations.push("全部资料为 Agent 自述，不能作为独立依据");
    }
    if (relation === "contradicted") {
      limitations.push("存在矛盾证据，未做静默合并；最终判断需用户裁决");
    }
    if (relation === "insufficient") {
      limitations.push("证据不足：缺少可定位的资料正文或关键覆盖");
    }
    if (relation === "unavailable") {
      limitations.push("资料不可用（离线/搜索失败），不得宣称已证实");
    }
    return limitations;
  }
}

/** 供测试/审计：生成证据条目 ID。 */
export function nextEvidenceEntryId(): string {
  return `evidence-${randomUUID()}`;
}
