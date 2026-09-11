/**
 * 结构化回访账本（T09A-R1-03）：回执冷却与任务级回访预算的持久化实现，
 * 使跨进程/多次 CLI 调用也能拿到 repeat-receipt 与预算拒绝。
 * 位置：<base>/agent-memory/<callerAgentInstanceId>/recall-ledger.json
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type {
  ContextRecallLedgerPort,
  RecallLedgerEntry,
} from "./context-recall-controller.js";
import { sanitizePathSegment } from "./work-archive-store.js";

interface LedgerDocument {
  schemaVersion: 1;
  entriesByLedgerKey: Record<string, RecallLedgerEntry>;
  countByTaskExecution: Record<string, number>;
}

export class FileContextRecallLedgerStore implements ContextRecallLedgerPort {
  private readonly filePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string; callerAgentInstanceId: string }) {
    this.filePath = path.join(
      options.baseDirectory,
      "agent-memory",
      sanitizePathSegment(options.callerAgentInstanceId),
      "recall-ledger.json",
    );
  }

  async readEntry(ledgerKey: string): Promise<RecallLedgerEntry | null> {
    const document = await this.readDocument();
    return document.entriesByLedgerKey[ledgerKey] ?? null;
  }

  async writeEntry(ledgerKey: string, entry: RecallLedgerEntry): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      document.entriesByLedgerKey[ledgerKey] = entry;
      await writeAtomicJson(this.filePath, document);
    });
  }

  async readTaskRecallCount(taskExecutionId: string): Promise<number> {
    const document = await this.readDocument();
    return document.countByTaskExecution[taskExecutionId] ?? 0;
  }

  async writeTaskRecallCount(taskExecutionId: string, count: number): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      document.countByTaskExecution[taskExecutionId] = count;
      await writeAtomicJson(this.filePath, document);
    });
  }

  private async readDocument(): Promise<LedgerDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.filePath + ".bak",
    );
    if (readResult === null) {
      return { schemaVersion: 1, entriesByLedgerKey: {}, countByTaskExecution: {} };
    }
    const content = readResult.content as Partial<LedgerDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      typeof content.entriesByLedgerKey !== "object" ||
      content.entriesByLedgerKey === null
    ) {
      return { schemaVersion: 1, entriesByLedgerKey: {}, countByTaskExecution: {} };
    }
    return {
      schemaVersion: 1,
      entriesByLedgerKey: content.entriesByLedgerKey,
      countByTaskExecution: content.countByTaskExecution ?? {},
    };
  }
}
