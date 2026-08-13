/**
 * Agent 待办任务偏序集持久化存储（T05C / ADR-0013）。
 * 位置：<baseDirectory>/agent-memory/<agentInstanceId>/task-sequences/<taskSequenceId>.json
 * + .bak（与任务链相同的原子替换 + 备份恢复模式）。
 *
 * 保证：schema 校验、revision 单调递增（expected revision 校验）、原子替换、
 *       写入前自动备份、损坏文件进入恢复绝不静默覆盖。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { agentTaskSequenceDocumentSchema } from "../core/schemas.js";
import { AGENT_TASK_SEQUENCE_SCHEMA_VERSION } from "../core/types.js";
import type { AgentTaskSequenceDocument } from "../core/types.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  cleanStaleTempFiles,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";

export interface AgentTaskSequenceStoreOptions {
  baseDirectory: string;
}

export class AgentTaskSequenceStore {
  private readonly agentMemoryDirectoryPath: string;
  private readonly sequenceLocks = new Map<string, AsyncMutex>();

  constructor(options: AgentTaskSequenceStoreOptions) {
    this.agentMemoryDirectoryPath = path.join(
      options.baseDirectory,
      "agent-memory",
    );
  }

  private sequenceDirectoryPath(
    ownerAgentInstanceId: string,
    sequenceId: string,
  ): string {
    return path.join(
      this.agentMemoryDirectoryPath,
      sanitizePathSegment(ownerAgentInstanceId),
      "task-sequences",
      sanitizePathSegment(sequenceId),
    );
  }

  private sequenceFilePath(
    ownerAgentInstanceId: string,
    sequenceId: string,
  ): string {
    return path.join(
      this.sequenceDirectoryPath(ownerAgentInstanceId, sequenceId),
      "task-sequence.json",
    );
  }

  private backupFilePath(
    ownerAgentInstanceId: string,
    sequenceId: string,
  ): string {
    return path.join(
      this.sequenceDirectoryPath(ownerAgentInstanceId, sequenceId),
      "task-sequence.json.bak",
    );
  }

  private getSequenceLock(lockKey: string): AsyncMutex {
    let lock = this.sequenceLocks.get(lockKey);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.sequenceLocks.set(lockKey, lock);
    }
    return lock;
  }

  async readSequence(
    ownerAgentInstanceId: string,
    sequenceId: string,
  ): Promise<AgentTaskSequenceDocument | null> {
    const lockKey = `${ownerAgentInstanceId}/${sequenceId}`;
    return this.getSequenceLock(lockKey).runExclusive(() =>
      this.readSequenceInternal(ownerAgentInstanceId, sequenceId),
    );
  }

  private async readSequenceInternal(
    ownerAgentInstanceId: string,
    sequenceId: string,
  ): Promise<AgentTaskSequenceDocument | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.sequenceFilePath(ownerAgentInstanceId, sequenceId),
      this.backupFilePath(ownerAgentInstanceId, sequenceId),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = agentTaskSequenceDocumentSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `任务序列内容非法（${readResult.recoveredFromBackup ? "已从备份恢复" : "主文件"}）: ${sequenceId}（${parsed.error.message}）`,
      );
    }
    return parsed.data;
  }

  /**
   * 锁内"读当前 → expected revision 校验 → 调用方构造新文档 → 校验并写入"的原子更新。
   * 并发调用不会丢失 revision；expectedRevision 不匹配抛 stale-revision。
   */
  async updateSequence(
    ownerAgentInstanceId: string,
    sequenceId: string,
    expectedRevision: number,
    updater: (
      current: AgentTaskSequenceDocument | null,
    ) => AgentTaskSequenceDocument,
  ): Promise<AgentTaskSequenceDocument> {
    const lockKey = `${ownerAgentInstanceId}/${sequenceId}`;
    return this.getSequenceLock(lockKey).runExclusive(async () => {
      const current = await this.readSequenceInternal(
        ownerAgentInstanceId,
        sequenceId,
      );
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new DomainError(
          "stale-revision",
          `任务序列 revision 不匹配: 现有 ${current?.revision ?? 0}，期望 ${expectedRevision}`,
        );
      }
      const next = updater(current);
      await this.writeSequenceInternal(ownerAgentInstanceId, sequenceId, next);
      return next;
    });
  }

  /** 无并发保护的直接写入（供测试与恢复）；revision 单调校验仍生效。 */
  async writeSequenceDirect(
    document: AgentTaskSequenceDocument,
  ): Promise<void> {
    const lockKey = `${document.ownerAgentInstanceId}/${document.sequenceId}`;
    return this.getSequenceLock(lockKey).runExclusive(() =>
      this.writeSequenceInternal(
        document.ownerAgentInstanceId,
        document.sequenceId,
        document,
      ),
    );
  }

  private async writeSequenceInternal(
    ownerAgentInstanceId: string,
    sequenceId: string,
    document: AgentTaskSequenceDocument,
  ): Promise<void> {
    const parsed = agentTaskSequenceDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `任务序列文档非法: ${sequenceId}（${parsed.error.message}）`,
      );
    }
    if (parsed.data.schemaVersion !== AGENT_TASK_SEQUENCE_SCHEMA_VERSION) {
      throw new DomainError(
        "invalid-task-chain",
        `不支持的 schemaVersion: ${parsed.data.schemaVersion}`,
      );
    }
    const current = await this.readSequenceInternal(
      ownerAgentInstanceId,
      sequenceId,
    );
    if (current !== null && parsed.data.revision <= current.revision) {
      throw new DomainError(
        "stale-revision",
        `旧 revision 覆盖被拒绝: 现有 ${current.revision}，试图写入 ${parsed.data.revision}`,
      );
    }
    const sequenceDirectory = this.sequenceDirectoryPath(
      ownerAgentInstanceId,
      sequenceId,
    );
    await cleanStaleTempFiles(sequenceDirectory, "task-sequence.json");
    const sequenceFilePath = this.sequenceFilePath(
      ownerAgentInstanceId,
      sequenceId,
    );
    const backupFilePath = this.backupFilePath(
      ownerAgentInstanceId,
      sequenceId,
    );
    await writeAtomicJson(sequenceFilePath, parsed.data);
    await backupExistingFile(sequenceFilePath, backupFilePath);
  }
}
