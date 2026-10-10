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
import type { SummarySourceKind } from "./summary-manifest.js";

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
 * SUM-01-04（2026-10-10）：卡内要求摘要覆盖"**会话历史、工作存档、报告和延后文件**"。
 * `work-archive` 已有适配器；本段补齐另外三类，纪律完全一致：
 *  - **确定性排序**（时间优先，同刻按稳定键）与**确定性内容哈希**；
 *  - **重复条目不得双计**（重读/重放不得灌水）；
 *  - `sourceRevision` 从 1 起单调重排；
 *  - `sourceIdentifier` 保留**可回溯**的原始标识（不得退化成不透明序号）；
 *  - **不改写来源正文**（本层只做条目化，不做摘要）；
 *  - 结构非法项**跳过**（不猜测、不因单项非法而中断整批）；空输入 ⇒ 空结果（不伪造）。
 */

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeSourceContentHash(parts: Array<string | number>): string {
  return sha256Hex(parts.map((part) => String(part)).join("|"));
}

/** 通用条目化：按 recordedAtIso 排序、按回溯标识去重、revision 从 1 重排。 */
function buildSummaryEntries(input: {
  sourceKind: SummarySourceKind;
  items: Array<{
    traceableIdentifier: string;
    contentHashParts: Array<string | number>;
    entryType: SummaryEntryType;
    text: string;
    recordedAtIso: string;
  }>;
}): SummarySourceEntry[] {
  const sorted = [...input.items].sort((left, right) => {
    if (left.recordedAtIso !== right.recordedAtIso) {
      return left.recordedAtIso.localeCompare(right.recordedAtIso);
    }
    return left.traceableIdentifier.localeCompare(right.traceableIdentifier);
  });
  const seenIdentifiers = new Set<string>();
  const entries: SummarySourceEntry[] = [];
  let sourceRevision = 0;
  for (const item of sorted) {
    if (seenIdentifiers.has(item.traceableIdentifier)) {
      continue;
    }
    seenIdentifiers.add(item.traceableIdentifier);
    sourceRevision += 1;
    entries.push({
      sourceKind: input.sourceKind,
      sourceIdentifier: item.traceableIdentifier,
      sourceRevision,
      contentHash: computeSourceContentHash(item.contentHashParts),
      entryType: item.entryType,
      text: item.text,
      recordedAtIso: item.recordedAtIso,
    });
  }
  return entries;
}

export interface ConversationSummaryTurn {
  turnIdentifier: string;
  speaker: string;
  text: string;
  recordedAtIso: string;
}

/** 会话历史 → 摘要来源条目。`sourceIdentifier` = `会话#轮次`（可回溯）。 */
export function buildConversationSummaryEntries(input: {
  sessionIdentifier: string;
  turns: ConversationSummaryTurn[];
}): SummarySourceEntry[] {
  const collected: Parameters<typeof buildSummaryEntries>[0]["items"] = [];
  for (const rawTurn of input.turns) {
    if (rawTurn === null || typeof rawTurn !== "object") {
      continue;
    }
    const record = rawTurn as unknown as Record<string, unknown>;
    const turnIdentifier = stringField(record, "turnIdentifier");
    const text = stringField(record, "text");
    const recordedAtIso = stringField(record, "recordedAtIso");
    if (turnIdentifier === null || text === null || recordedAtIso === null) {
      continue;
    }
    collected.push({
      traceableIdentifier: input.sessionIdentifier + "#" + turnIdentifier,
      contentHashParts: ["conversation", input.sessionIdentifier, turnIdentifier, text],
      entryType: "message",
      text,
      recordedAtIso,
    });
  }
  return buildSummaryEntries({ sourceKind: "conversation", items: collected });
}

export interface ReportSummaryRecord {
  reportIdentifier: string;
  taskIdentifier: string;
  summaryText: string;
  recordedAtIso: string;
}

/** 报告 → 摘要来源条目。`sourceIdentifier` = `报告#任务`（可回溯）。 */
export function buildReportSummaryEntries(input: {
  reports: ReportSummaryRecord[];
}): SummarySourceEntry[] {
  const collected: Parameters<typeof buildSummaryEntries>[0]["items"] = [];
  for (const rawReport of input.reports) {
    if (rawReport === null || typeof rawReport !== "object") {
      continue;
    }
    const record = rawReport as unknown as Record<string, unknown>;
    const reportIdentifier = stringField(record, "reportIdentifier");
    const taskIdentifier = stringField(record, "taskIdentifier");
    const summaryText = stringField(record, "summaryText");
    const recordedAtIso = stringField(record, "recordedAtIso");
    if (
      reportIdentifier === null ||
      taskIdentifier === null ||
      summaryText === null ||
      recordedAtIso === null
    ) {
      continue;
    }
    collected.push({
      traceableIdentifier: reportIdentifier + "#" + taskIdentifier,
      contentHashParts: ["report", reportIdentifier, taskIdentifier, summaryText],
      entryType: "report",
      text: summaryText,
      recordedAtIso,
    });
  }
  return buildSummaryEntries({ sourceKind: "report", items: collected });
}

export interface DeferredFileSummaryRecord {
  fileIdentifier: string;
  filePath: string;
  lineRangeStart: number;
  lineRangeEnd: number;
  excerptText: string;
  recordedAtIso: string;
}

/**
 * 延后文件 → 摘要来源条目。
 *
 * `sourceIdentifier` = `文件#起始行-结束行`：**同文件不同行区间是不同条目**
 * （不得因文件相同就合并，否则行区间信息会丢失）。
 */
export function buildDeferredFileSummaryEntries(input: {
  deferredFiles: DeferredFileSummaryRecord[];
}): SummarySourceEntry[] {
  const collected: Parameters<typeof buildSummaryEntries>[0]["items"] = [];
  for (const rawRecord of input.deferredFiles) {
    if (rawRecord === null || typeof rawRecord !== "object") {
      continue;
    }
    const record = rawRecord as unknown as Record<string, unknown>;
    const fileIdentifier = stringField(record, "fileIdentifier");
    const excerptText = stringField(record, "excerptText");
    const recordedAtIso = stringField(record, "recordedAtIso");
    const lineRangeStart = numberField(record, "lineRangeStart");
    const lineRangeEnd = numberField(record, "lineRangeEnd");
    if (
      fileIdentifier === null ||
      excerptText === null ||
      recordedAtIso === null ||
      lineRangeStart === null ||
      lineRangeEnd === null
    ) {
      continue;
    }
    collected.push({
      traceableIdentifier:
        fileIdentifier +
        "#" +
        String(lineRangeStart) +
        "-" +
        String(lineRangeEnd),
      contentHashParts: [
        "deferred-file",
        fileIdentifier,
        lineRangeStart,
        lineRangeEnd,
        excerptText,
      ],
      entryType: "note",
      text: excerptText,
      recordedAtIso,
    });
  }
  return buildSummaryEntries({ sourceKind: "deferred-file", items: collected });
}

/**
 * 本地抽取式叙述（占位生成器，`generatorVersion = local-extractive-1`）：
 * 只做确定性统计与引用，不调用模型；SUM-02 将接入真实模型生成器并保留版本区分。
 */export function buildLocalExtractiveNarrative(facts: SummaryFact[]): string {
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
