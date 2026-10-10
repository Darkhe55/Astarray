/**
 * GUIDE-01-04：指导提交/应用状态日志（跨进程可读，支撑 CLI 查看接收与应用状态）。
 *
 * - 提交记录在本地状态目录中原子保存，进程重启后仍可查看；
 * - 应用/丢弃状态由**实际应用的进程**回写；
 * - 读取方把内存队列状态与日志合并，日志中尚无应用结果时状态保持 `queued`
 *   （并显式标注 `isApplicationStatusKnown = false`，不虚报已应用）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";

export const GUIDANCE_SUBMISSION_JOURNAL_SCHEMA_VERSION = 1;

export interface GuidanceSubmissionJournalEntry {
  guidanceIdentifier: string;
  guidanceRevision: number;
  behaviorTier: "record-only" | "safe-point-guidance" | "gate-and-request-pause";
  missionIdentifier: string;
  taskIdentifier: string | null;
  status: "queued" | "applied" | "dropped" | "superseded";
  submittedAtIso: string;
  appliedAtIso: string | null;
  latencyMilliseconds: number | null;
  dropReason: string | null;
  /** 是否由本进程/已回写进程确认过应用结果。 */
  isApplicationStatusKnown: boolean;
}

interface JournalDocument {
  schemaVersion: number;
  entries: GuidanceSubmissionJournalEntry[];
}

function entryKey(guidanceIdentifier: string, guidanceRevision: number): string {
  return guidanceIdentifier + "@" + String(guidanceRevision);
}

export class GuidanceSubmissionJournal {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "guidance", "submissions.json");
  }

  private async readDocument(): Promise<JournalDocument> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(rawContent) as JournalDocument;
      if (
        parsed.schemaVersion === GUIDANCE_SUBMISSION_JOURNAL_SCHEMA_VERSION &&
        Array.isArray(parsed.entries)
      ) {
        return parsed;
      }
    } catch {
      // 缺失或损坏：视为空日志（不静默覆盖他人数据，写入时重建）。
    }
    return { schemaVersion: GUIDANCE_SUBMISSION_JOURNAL_SCHEMA_VERSION, entries: [] };
  }

  private async writeDocument(document: JournalDocument): Promise<void> {
    await writeAtomicJson(this.filePath, document);
  }

  async recordSubmission(entry: GuidanceSubmissionJournalEntry): Promise<void> {
    const document = await this.readDocument();
    const key = entryKey(entry.guidanceIdentifier, entry.guidanceRevision);
    const entries = document.entries.filter(
      (candidate) =>
        entryKey(candidate.guidanceIdentifier, candidate.guidanceRevision) !== key,
    );
    entries.push({ ...entry });
    await this.writeDocument({ ...document, entries });
  }

  /** 应用/丢弃状态回写（upsert：日志中不存在时补记，避免并发下丢条目）。 */
  async upsertEntry(entry: GuidanceSubmissionJournalEntry): Promise<void> {
    const document = await this.readDocument();
    const key = entryKey(entry.guidanceIdentifier, entry.guidanceRevision);
    const entries = document.entries.filter(
      (candidate) =>
        entryKey(candidate.guidanceIdentifier, candidate.guidanceRevision) !== key,
    );
    entries.push({ ...entry });
    await this.writeDocument({ ...document, entries });
  }

  async readAll(): Promise<GuidanceSubmissionJournalEntry[]> {
    const document = await this.readDocument();
    return document.entries.map((entry) => ({ ...entry }));
  }

  /**
   * 带**完整性**的读取（RELIABILITY-01，2026-10-10）。
   *
   * 缺陷背景（由反例实测）：回执写入被崩溃/断电打断时磁盘会留下**不完整 JSON**，
   * 而 `readDocument()` 此前**静默返回空日志** ⇒ `queryGuidanceStatus()` 报告 0 条，
   * 用户指导**静默消失**，调用方也无法区分"从未提交"与"日志损坏"。
   * （与已返修的幂等账目损坏属同一类缺陷。）
   *
   * 本方法把损坏**显式暴露**；合法条目仍保留供诊断。
   */
  async readAllWithIntegrity(): Promise<GuidanceJournalIntegrity> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      /** 文件不存在 ⇒ 正常全新安装，**不得**误判为损坏。 */
      return {
        entries: [],
        isCorrupted: false,
        corruptionReason: null,
        usableEntryCount: 0,
        unusableEntryCount: 0,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return {
        entries: [],
        isCorrupted: true,
        corruptionReason: "指导日志不是合法 JSON（可能写入过程被打断）",
        usableEntryCount: 0,
        unusableEntryCount: 0,
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return {
        entries: [],
        isCorrupted: true,
        corruptionReason: "指导日志根节点不是对象",
        usableEntryCount: 0,
        unusableEntryCount: 0,
      };
    }
    const document = parsed as { schemaVersion?: unknown; entries?: unknown };
    if (document.schemaVersion !== GUIDANCE_SUBMISSION_JOURNAL_SCHEMA_VERSION) {
      return {
        entries: [],
        isCorrupted: true,
        corruptionReason:
          "指导日志 schemaVersion 不符（期望 " +
          String(GUIDANCE_SUBMISSION_JOURNAL_SCHEMA_VERSION) +
          "，实际 " +
          String(document.schemaVersion) +
          "）",
        usableEntryCount: 0,
        unusableEntryCount: 0,
      };
    }
    if (!Array.isArray(document.entries)) {
      return {
        entries: [],
        isCorrupted: true,
        corruptionReason: "指导日志 entries 不是数组",
        usableEntryCount: 0,
        unusableEntryCount: 0,
      };
    }
    const usableEntries: GuidanceSubmissionJournalEntry[] = [];
    let unusableEntryCount = 0;
    for (const candidate of document.entries) {
      if (!isStructurallyValidJournalEntry(candidate)) {
        unusableEntryCount += 1;
        continue;
      }
      usableEntries.push({ ...(candidate as GuidanceSubmissionJournalEntry) });
    }
    return {
      entries: usableEntries,
      /** 单条结构非法同样计入损坏（合法条目仍保留，供诊断与尽量复用）。 */
      isCorrupted: unusableEntryCount > 0,
      corruptionReason:
        unusableEntryCount > 0
          ? "指导日志中有 " + String(unusableEntryCount) + " 条结构非法的条目"
          : null,
      usableEntryCount: usableEntries.length,
      unusableEntryCount,
    };
  }

  /**
   * **严格**读取：日志损坏即抛出（fail-closed）。
   *
   * 供默认产品路径使用：把损坏当成"没有记录"会**静默丢掉用户指导**，
   * 因此宁可显式失败，让上层决定对账或人工处理。
   */
  async readAllStrict(): Promise<GuidanceSubmissionJournalEntry[]> {
    const integrity = await this.readAllWithIntegrity();
    if (integrity.isCorrupted) {
      throw new Error(
        "指导日志损坏（拒绝把损坏当作没有记录）: " + String(integrity.corruptionReason),
      );
    }
    return integrity.entries;
  }
}

export interface GuidanceJournalIntegrity {
  entries: GuidanceSubmissionJournalEntry[];
  isCorrupted: boolean;
  corruptionReason: string | null;
  usableEntryCount: number;
  unusableEntryCount: number;
}

/** 结构性校验：只检查判定"能否安全使用"所必需的字段与类型。 */
function isStructurallyValidJournalEntry(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const entry = candidate as Record<string, unknown>;
  return (
    typeof entry["guidanceIdentifier"] === "string" &&
    entry["guidanceIdentifier"] !== "" &&
    typeof entry["guidanceRevision"] === "number" &&
    Number.isFinite(entry["guidanceRevision"]) &&
    typeof entry["status"] === "string" &&
    typeof entry["submittedAtIso"] === "string"
  );
}
