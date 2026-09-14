/**
 * SUM-01-02：本地权威事实提取（不经过模型、不改写语义）。
 *
 * 事实与叙述分离：本模块只做去重、排序与稳定标识；模型生成的叙述
 * 由生成服务写入清单的 `narrativeText`，绝不混入权威事实。
 */
import { createHash } from "node:crypto";

import type {
  SummarySourceKind,
} from "./summary-manifest.js";

export const SUMMARY_ENTRY_TYPES = [
  "message",
  "decision",
  "result",
  "report",
  "note",
] as const;
export type SummaryEntryType = (typeof SUMMARY_ENTRY_TYPES)[number];

export interface SummarySourceEntry {
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
  /** 权威来源 revision（单调）。 */
  sourceRevision: number;
  /** 内容哈希：同 revision 内容变化必须被识别。 */
  contentHash: string;
  entryType: SummaryEntryType;
  text: string;
  recordedAtIso: string;
}

export interface SummaryFact {
  factIdentifier: string;
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
  entryType: SummaryEntryType;
  /** 本地抽取的权威事实文本（原文摘要片段，非模型叙述）。 */
  factText: string;
  recordedAtIso: string;
}

export function summaryFactDeduplicationKey(input: {
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
}): string {
  return (
    input.sourceIdentifier +
    "|" +
    String(input.sourceRevision) +
    "|" +
    input.contentHash
  );
}

function factIdentifierFor(input: {
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
  text: string;
}): string {
  return (
    "fact-" +
    createHash("sha256")
      .update(
        [
          input.sourceKind,
          input.sourceIdentifier,
          String(input.sourceRevision),
          input.contentHash,
          input.text,
        ].join("|"),
        "utf8",
      )
      .digest("hex")
      .slice(0, 20)
  );
}

/**
 * 确定性提取：按 (sourceIdentifier, sourceRevision, contentHash) 去重，
 * 按 (sourceRevision, sourceIdentifier, factIdentifier) 稳定排序。
 * 同一输入必然得到同一输出（可作为幂等/续跑基础）。
 */
export function extractSummaryFacts(
  entries: SummarySourceEntry[],
): SummaryFact[] {
  const byDeduplicationKey = new Map<string, SummaryFact>();
  for (const entry of entries) {
    const deduplicationKey = summaryFactDeduplicationKey(entry);
    if (byDeduplicationKey.has(deduplicationKey)) {
      continue;
    }
    byDeduplicationKey.set(deduplicationKey, {
      factIdentifier: factIdentifierFor(entry),
      sourceKind: entry.sourceKind,
      sourceIdentifier: entry.sourceIdentifier,
      sourceRevision: entry.sourceRevision,
      contentHash: entry.contentHash,
      entryType: entry.entryType,
      factText: entry.text,
      recordedAtIso: entry.recordedAtIso,
    });
  }
  return [...byDeduplicationKey.values()].sort((left, right) => {
    if (left.sourceRevision !== right.sourceRevision) {
      return left.sourceRevision - right.sourceRevision;
    }
    if (left.sourceIdentifier !== right.sourceIdentifier) {
      return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
    }
    return left.factIdentifier.localeCompare(right.factIdentifier);
  });
}
