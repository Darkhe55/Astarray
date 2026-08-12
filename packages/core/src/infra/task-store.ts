/**
 * 任务链持久化存储（T03）。
 * 位置：<baseDirectory>/missions/<missionId>/task-chain.json + .bak（ADR-0004）。
 * 保证：schema 校验、revision 单调递增（旧 revision 拒绝）、进程内 mission 锁、
 *       原子替换、备份恢复、损坏文件进入 recovery 绝不静默覆盖。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { taskChainSchema } from "../core/schemas.js";
import { TASK_CHAIN_SCHEMA_VERSION } from "../core/types.js";
import type { TaskChainDocument, TaskStorePort } from "../core/types.js";
import { AsyncMutex } from "./async-mutex.js";
import {
  backupExistingFile,
  cleanStaleTempFiles,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "./atomic-json.js";

export interface TaskStoreOptions {
  baseDirectory: string;
}

export class TaskStore implements TaskStorePort {
  private readonly missionsDirectoryPath: string;
  private readonly missionLocks = new Map<string, AsyncMutex>();

  constructor(options: TaskStoreOptions) {
    this.missionsDirectoryPath = path.join(options.baseDirectory, "missions");
  }

  private missionDirectoryPath(missionId: string): string {
    return path.join(this.missionsDirectoryPath, missionId);
  }

  private chainFilePath(missionId: string): string {
    return path.join(this.missionDirectoryPath(missionId), "task-chain.json");
  }

  private backupFilePath(missionId: string): string {
    return path.join(
      this.missionDirectoryPath(missionId),
      "task-chain.json.bak",
    );
  }

  private getMissionLock(missionId: string): AsyncMutex {
    let lock = this.missionLocks.get(missionId);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.missionLocks.set(missionId, lock);
    }
    return lock;
  }

  async readTaskChain(missionId: string): Promise<TaskChainDocument | null> {
    return this.getMissionLock(missionId).runExclusive(() =>
      this.readChainInternal(missionId),
    );
  }

  private async readChainInternal(
    missionId: string,
  ): Promise<TaskChainDocument | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.chainFilePath(missionId),
      this.backupFilePath(missionId),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = taskChainSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `任务链内容非法（${readResult.recoveredFromBackup ? "已从备份恢复" : "主文件"}）: ${missionId}（${parsed.error.message}）`,
      );
    }
    return parsed.data;
  }

  async writeTaskChain(document: TaskChainDocument): Promise<void> {
    await this.getMissionLock(document.missionId).runExclusive(async () => {
      await this.writeChainInternal(document);
    });
  }

  /**
   * 锁内"读当前 → 调用方构造新文档 → 校验并写入"的原子更新。
   * 供调度器每次调度后更新任务链使用；并发调用不会丢失 revision。
   */
  async updateTaskChain(
    missionId: string,
    updater: (current: TaskChainDocument | null) => TaskChainDocument,
  ): Promise<TaskChainDocument> {
    return this.getMissionLock(missionId).runExclusive(async () => {
      const current = await this.readChainInternal(missionId);
      const next = updater(current);
      await this.writeChainInternal(next);
      return next;
    });
  }

  private async writeChainInternal(document: TaskChainDocument): Promise<void> {
    const parsed = taskChainSchema.safeParse(document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `任务链文档非法: ${document.missionId}（${parsed.error.message}）`,
      );
    }
    if (parsed.data.schemaVersion !== TASK_CHAIN_SCHEMA_VERSION) {
      throw new DomainError(
        "invalid-task-chain",
        `不支持的 schemaVersion: ${parsed.data.schemaVersion}`,
      );
    }
    const current = await this.readChainInternal(parsed.data.missionId);
    if (current !== null && parsed.data.revision <= current.revision) {
      throw new DomainError(
        "stale-revision",
        `旧 revision 覆盖被拒绝: 现有 ${current.revision}，试图写入 ${parsed.data.revision}`,
      );
    }
    const missionDirectory = this.missionDirectoryPath(parsed.data.missionId);
    await cleanStaleTempFiles(missionDirectory, "task-chain.json");
    const chainFilePath = this.chainFilePath(parsed.data.missionId);
    const backupFilePath = this.backupFilePath(parsed.data.missionId);
    await writeAtomicJson(chainFilePath, parsed.data);
    await backupExistingFile(chainFilePath, backupFilePath);
  }
}
