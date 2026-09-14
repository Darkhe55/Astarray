/**
 * SUM-01-04a：真实来源 → 摘要来源条目（本地、确定性、不改写语义）。
 *
 * 首期来源为 Agent 工作存档（`missions/<missionId>/agents/<agentInstanceId>/work-archive.json`）：
 * 一个 mission 的多份存档合并为**一个**摘要来源（sourceIdentifier = missionId），
 * 每条证据指针保留 `agentInstanceId#archiveEntryId` 以便回溯到原始个体存档，
 * 不把不同 Agent 的记忆域合成同一份可变存档。
 */
import { createHash } from "node:crypto";

import type { AgentWorkArchiveEntry } from "../core/types.js";
import type {
  SummaryEntryType,
  SummaryFact,
  SummarySourceEntry,
} from "./summary-fact-extractor.js";

export interface WorkArchiveSummarySourceInput {
  missionId: string;
  agentInstanceId: string;
  entries: AgentWorkArchiveEntry[];
}

const ARCHIVE_ENTRY_TYPE_TO_SUMMARY_ENTRY_TYPE: Record<
  AgentWorkArchiveEntry["entryType"],
  SummaryEntryType
> = {
  assignment: "message",
  progress: "note",
  decision: "decision",
  result: "result",
  failure: "note",
  handoff: "note",
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 合并一个 mission 的多份工作存档为摘要来源条目：
 * 按 recordedAtIso（同刻按 agentInstanceId/entryId）稳定排序后重排 sourceRevision 1..N。
 */
export function buildWorkArchiveSummaryEntries(
  inputs: WorkArchiveSummarySourceInput[],
): SummarySourceEntry[] {
  const flattened = inputs.flatMap((input) =>
    input.entries.map((entry) => ({
      missionId: input.missionId,
      agentInstanceId: input.agentInstanceId,
      entry,
    })),
  );
  flattened.sort((left, right) => {
    if (left.entry.recordedAtIso !== right.entry.recordedAtIso) {
      return left.entry.recordedAtIso.localeCompare(right.entry.recordedAtIso);
    }
    if (left.agentInstanceId !== right.agentInstanceId) {
      return left.agentInstanceId.localeCompare(right.agentInstanceId);
    }
    return left.entry.archiveEntryId.localeCompare(right.entry.archiveEntryId);
  });
  const seenArchiveEntryIds = new Set<string>();
  const sources: SummarySourceEntry[] = [];
  let sourceRevision = 0;
  for (const item of flattened) {
    const traceableEntryIdentifier =
      item.agentInstanceId + "#" + item.entry.archiveEntryId;
    // 同一 mission 内重复的存档条目（重读/重放）不得双计。
    if (seenArchiveEntryIds.has(traceableEntryIdentifier)) {
      continue;
    }
    seenArchiveEntryIds.add(traceableEntryIdentifier);
    sourceRevision += 1;
    sources.push({
      sourceKind: "work-archive",
      sourceIdentifier: traceableEntryIdentifier,
      sourceRevision,
      contentHash: sha256Hex(
        [
          item.missionId,
          traceableEntryIdentifier,
          item.entry.entryType,
          item.entry.summary,
          item.entry.artifactReferences.join(","),
        ].join("|"),
      ),
      entryType:
        ARCHIVE_ENTRY_TYPE_TO_SUMMARY_ENTRY_TYPE[item.entry.entryType],
      text: item.entry.summary,
      recordedAtIso: item.entry.recordedAtIso,
    });
  }
  return sources;
}

/**
 * 本地抽取式叙述（占位生成器，`generatorVersion = local-extractive-1`）：
 * 只做确定性统计与引用，不调用模型；SUM-02 将接入真实模型生成器并保留版本区分。
 */
export function buildLocalExtractiveNarrative(facts: SummaryFact[]): string {
  if (facts.length === 0) {
    return "（无工作记录）";
  }
  const countByEntryType = new Map<string, number>();
  for (const fact of facts) {
    countByEntryType.set(
      fact.entryType,
      (countByEntryType.get(fact.entryType) ?? 0) + 1,
    );
  }
  const entryTypeSummary = [...countByEntryType.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([entryType, count]) => entryType + "=" + count)
    .join("，");
  const firstRecordedAtIso = facts[0]?.recordedAtIso ?? "";
  const lastRecordedAtIso = facts.at(-1)?.recordedAtIso ?? "";
  return (
    "本地抽取式摘要：共 " +
    facts.length +
    " 条工作记录（" +
    entryTypeSummary +
    "），时间范围 " +
    firstRecordedAtIso +
    " ~ " +
    lastRecordedAtIso +
    "。"
  );
}
