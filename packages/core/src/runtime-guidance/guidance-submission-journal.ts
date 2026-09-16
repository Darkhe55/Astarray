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
}
