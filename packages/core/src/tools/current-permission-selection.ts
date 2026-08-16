/**
 * 当前权限组选择（B6R-04 / ADR-0020）。
 * 认证用户经设置控制面选择当前权限组；选择持久化到
 * <baseDirectory>/settings/permission-profile-current.json，
 * 写入自动备份 + 单调 revision。模式/权限组选择只能来自认证用户控制面。
 */
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../core/errors.js";
import type { PermissionProfileReference } from "./permission-profile-store.js";

export const currentPermissionSelectionSchema = z.object({
  schemaVersion: z.literal(1),
  selectedReference: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("builtin"),
      profileId: z.enum(["ponder", "assist", "devolve"]),
    }),
    z.object({ kind: z.literal("custom"), profileId: z.string().min(1) }),
  ]),
  revision: z.number().int().min(0),
  updatedAtIso: z.iso.datetime(),
});

export type CurrentPermissionSelection = z.infer<
  typeof currentPermissionSelectionSchema
>;

export interface CurrentPermissionSelectionStoreOptions {
  baseDirectory: string;
}

export class CurrentPermissionSelectionStore {
  private readonly settingsDirectory: string;
  private readonly selectionFilePath: string;
  private readonly backupFilePath: string;

  constructor(options: CurrentPermissionSelectionStoreOptions) {
    this.settingsDirectory = path.join(options.baseDirectory, "settings");
    this.selectionFilePath = path.join(
      this.settingsDirectory,
      "permission-profile-current.json",
    );
    this.backupFilePath = path.join(
      this.settingsDirectory,
      "permission-profile-current.json.bak",
    );
  }

  /** 读取当前选择；未设置时按模式默认（调用方提供）。 */
  async readSelection(): Promise<CurrentPermissionSelection | null> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.selectionFilePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return null;
    }
    const parsed = currentPermissionSelectionSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `当前权限组选择非法: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** 认证用户切换当前权限组（expected revision 校验 + 自动备份）。 */
  async switchSelection(input: {
    selectedReference: PermissionProfileReference;
    expectedRevision: number;
  }): Promise<CurrentPermissionSelection> {
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    const current = await this.readSelection();
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new DomainError(
        "stale-revision",
        `权限组选择 revision 不匹配: 现有 ${current?.revision ?? 0}，期望 ${input.expectedRevision}`,
      );
    }
    const next: CurrentPermissionSelection = {
      schemaVersion: 1,
      selectedReference: input.selectedReference,
      revision: (current?.revision ?? 0) + 1,
      updatedAtIso: new Date().toISOString(),
    };
    await writeAtomicJson(this.selectionFilePath, next);
    await backupExistingFile(this.selectionFilePath, this.backupFilePath);
    return next;
  }
}
