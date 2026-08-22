/**
 * 工匠披露状态存储（T08D-03 / ADR-0027 §1/§5）。
 *
 * 持久化每策略 × 每目标次级的披露记录：上次披露时间、提醒计数、
 * 幂等披露键集合。崩溃恢复/并发重放时按幂等键去重，
 * 防止通知风暴；写入前自动备份。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { sanitizePathSegment } from "./work-archive-store.js";

export interface CraftsmanDisclosureStateEntry {
  stageProfileId: string;
  stageProfileRevision: number;
  targetSecondaryAgentInstanceId: string;
  /** 幂等披露键（事件唯一；重放/并发时去重）。 */
  idempotencyKeys: string[];
  lastDisclosedAtIso: string | null;
  reminderCount: number;
  updatedAtIso: string;
}

export interface CraftsmanDisclosureStoreOptions {
  baseDirectory: string;
}

export class CraftsmanDisclosureStore {
  private readonly disclosureRootDirectory: string;

  constructor(options: CraftsmanDisclosureStoreOptions) {
    this.disclosureRootDirectory = path.join(
      options.baseDirectory,
      "craftsman-disclosures",
    );
  }

  private stateFilePath(entryKey: string): string {
    return path.join(
      this.disclosureRootDirectory,
      `${sanitizePathSegment(entryKey)}.json`,
    );
  }

  private backupFilePath(entryKey: string): string {
    return `${this.stateFilePath(entryKey)}.bak`;
  }

  private entryKey(
    stageProfileId: string,
    targetSecondaryAgentInstanceId: string,
  ): string {
    return `${stageProfileId}__${targetSecondaryAgentInstanceId}`;
  }

  async readState(input: {
    stageProfileId: string;
    targetSecondaryAgentInstanceId: string;
  }): Promise<CraftsmanDisclosureStateEntry | null> {
    const filePath = this.stateFilePath(
      this.entryKey(input.stageProfileId, input.targetSecondaryAgentInstanceId),
    );
    try {
      const rawContent = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(rawContent) as CraftsmanDisclosureStateEntry;
      if (
        parsed.stageProfileId !== input.stageProfileId ||
        parsed.targetSecondaryAgentInstanceId !==
          input.targetSecondaryAgentInstanceId
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** 记录一次披露（幂等键去重；写入前自动备份）。 */
  async recordDisclosure(input: {
    stageProfileId: string;
    stageProfileRevision: number;
    targetSecondaryAgentInstanceId: string;
    idempotencyKey: string;
    nowIso: string;
  }): Promise<{ isDuplicate: boolean; reminderCount: number }> {
    const entryKey = this.entryKey(
      input.stageProfileId,
      input.targetSecondaryAgentInstanceId,
    );
    const existing = await this.readState({
      stageProfileId: input.stageProfileId,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
    });
    if (existing !== null && existing.idempotencyKeys.includes(input.idempotencyKey)) {
      return { isDuplicate: true, reminderCount: existing.reminderCount };
    }
    const nextEntry: CraftsmanDisclosureStateEntry = {
      stageProfileId: input.stageProfileId,
      stageProfileRevision: input.stageProfileRevision,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
      idempotencyKeys: [
        ...(existing?.idempotencyKeys ?? []),
        input.idempotencyKey,
      ],
      lastDisclosedAtIso: input.nowIso,
      reminderCount: (existing?.reminderCount ?? 0) + 1,
      updatedAtIso: input.nowIso,
    };
    await fs.mkdir(this.disclosureRootDirectory, { recursive: true });
    const filePath = this.stateFilePath(entryKey);
    try {
      await fs.copyFile(filePath, this.backupFilePath(entryKey));
    } catch {
      // 首次写入
    }
    await fs.writeFile(filePath, `${JSON.stringify(nextEntry, null, 2)}\n`, "utf8");
    return { isDuplicate: false, reminderCount: nextEntry.reminderCount };
  }

  /** 幂等键是否已存在（崩溃恢复/并发重放去重）。 */
  async hasIdempotencyKey(input: {
    stageProfileId: string;
    targetSecondaryAgentInstanceId: string;
    idempotencyKey: string;
  }): Promise<boolean> {
    const existing = await this.readState({
      stageProfileId: input.stageProfileId,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
    });
    return existing?.idempotencyKeys.includes(input.idempotencyKey) ?? false;
  }
}