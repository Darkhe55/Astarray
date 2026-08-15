/**
 * 权限组存储（T06F / ADR-0020 §内置权限组与生命周期）。
 * 三个内置组 + 用户自定义组：单调 revision、目录版本、原子持久化、
 * 并发冲突检测（expected revision）与工具内自动备份（.bak）。
 * - builtin:devolve：出厂默认全部 allow（用户可逐项改 ask/deny 并恢复出厂）；
 * - builtin:assist：ADR-0020 独立默认矩阵；
 * - builtin:ponder：签名冻结只读 profile，所有更新入口拒绝修改。
 * 自定义组：随机不可复用 permissionProfileId、displayName、单调 revision、
 * 目录版本、逐项决定、新权限 fallback（默认 deny）、来源审计。
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../core/errors.js";
import { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";

export const PERMISSION_PROFILE_SCHEMA_VERSION = 1;

export type PermissionProfileReference =
  | { kind: "builtin"; profileId: "ponder" | "assist" | "devolve" }
  | { kind: "custom"; profileId: string };

export const permissionDecisionSchema = z.enum(["deny", "ask", "allow"]);

export const permissionProfileDocumentSchema = z.object({
  schemaVersion: z.literal(PERMISSION_PROFILE_SCHEMA_VERSION),
  permissionProfileId: z.string().min(1),
  /** 内置组固定名；自定义组为可辨识名称。 */
  displayName: z.string().min(1),
  isBuiltin: z.boolean(),
  /** 单调 revision（每次变更 +1）。 */
  revision: z.number().int().min(1),
  catalogVersion: z.number().int().min(1),
  /** 逐项决定（缺省项按 fallbackDecision 处理）。 */
  capabilityDecisions: z.record(z.string(), permissionDecisionSchema),
  /** 未来新权限的 fallback（自定义组默认 deny）。 */
  fallbackDecision: permissionDecisionSchema,
  /** 签名冻结（仅 Ponder）：内容哈希，任何修改拒绝。 */
  frozenSignature: z.string().nullable(),
  createdAtIso: z.iso.datetime(),
  updatedAtIso: z.iso.datetime(),
});

export type PermissionProfileDocument = z.infer<
  typeof permissionProfileDocumentSchema
>;

export interface PermissionProfileStoreOptions {
  baseDirectory: string;
  catalog?: PermissionCapabilityCatalog;
}

/** 内置组保留名（防止冒充；中英文均保留）。 */
export const BUILTIN_PROFILE_DISPLAY_NAMES = [
  "Ponder",
  "Assist",
  "Devolve",
  "思索模式",
  "协同模式",
  "放权模式",
] as const;

export class PermissionProfileStore {
  private readonly profilesRootDirectory: string;
  private readonly catalog: PermissionCapabilityCatalog;

  constructor(options: PermissionProfileStoreOptions) {
    this.profilesRootDirectory = path.join(
      options.baseDirectory,
      "permission-profiles",
    );
    this.catalog = options.catalog ?? new PermissionCapabilityCatalog();
  }

  /** 生成内置 profile 文档（不落盘；内置组定义随目录版本）。 */
  buildBuiltinProfile(
    profileId: "ponder" | "assist" | "devolve",
  ): PermissionProfileDocument {
    const capabilityDecisions: Record<string, PermissionDecision> = {};
    for (const capability of this.catalog.listCapabilities()) {
      if (profileId === "devolve") {
        capabilityDecisions[capability.capabilityId] = "allow";
      } else if (profileId === "assist") {
        capabilityDecisions[capability.capabilityId] = capability.assistDefault;
      } else {
        // Ponder：只允许本地只读白名单（全部 deny，白名单由执行层覆盖）
        capabilityDecisions[capability.capabilityId] = "deny";
      }
    }
    const displayName =
      profileId === "ponder"
        ? "Ponder"
        : profileId === "assist"
          ? "Assist"
          : "Devolve";
    const document: PermissionProfileDocument = {
      schemaVersion: PERMISSION_PROFILE_SCHEMA_VERSION,
      permissionProfileId: profileId,
      displayName,
      isBuiltin: true,
      revision: 1,
      catalogVersion: this.catalog.getCatalogVersion(),
      capabilityDecisions,
      fallbackDecision: "deny",
      frozenSignature:
        profileId === "ponder"
          ? this.computeFrozenSignature(capabilityDecisions)
          : null,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    return document;
  }

  /** Ponder 签名冻结：内容哈希 + 内置标记，任何更新入口拒绝。 */
  private computeFrozenSignature(
    capabilityDecisions: Record<string, PermissionDecision>,
  ): string {
    return createHash("sha256")
      .update(JSON.stringify(capabilityDecisions))
      .digest("hex");
  }

  private profileFilePath(permissionProfileId: string): string {
    return path.join(
      this.profilesRootDirectory,
      `${sanitizeProfileId(permissionProfileId)}.json`,
    );
  }

  private backupFilePath(permissionProfileId: string): string {
    return `${this.profileFilePath(permissionProfileId)}.bak`;
  }

  async readCustomProfile(
    permissionProfileId: string,
  ): Promise<PermissionProfileDocument | null> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.profileFilePath(permissionProfileId),
      this.backupFilePath(permissionProfileId),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = permissionProfileDocumentSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `权限组文档非法: ${permissionProfileId}（${parsed.error.message}）`,
      );
    }
    return parsed.data;
  }

  /** 读取任意 profile（内置或自定义）。 */
  async readProfile(
    reference: PermissionProfileReference,
  ): Promise<PermissionProfileDocument> {
    if (reference.kind === "builtin") {
      return this.buildBuiltinProfile(reference.profileId);
    }
    const document = await this.readCustomProfile(reference.profileId);
    if (document === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `权限组不存在: ${reference.profileId}`,
      );
    }
    return document;
  }

  /** 保存自定义组（自动备份；expected revision 冲突检测）。 */
  async saveCustomProfile(input: {
    document: PermissionProfileDocument;
    expectedRevision: number;
  }): Promise<PermissionProfileDocument> {
    if (input.document.isBuiltin) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `内置权限组不可写: ${input.document.permissionProfileId}`,
      );
    }
    if (input.document.frozenSignature !== null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "签名冻结的权限组不可修改",
      );
    }
    const current = await this.readCustomProfile(
      input.document.permissionProfileId,
    );
    if (current !== null && current.revision !== input.expectedRevision) {
      throw new DomainError(
        "stale-revision",
        `权限组 revision 不匹配: 现有 ${current.revision}，期望 ${input.expectedRevision}`,
      );
    }
    if (current !== null && input.document.revision <= current.revision) {
      throw new DomainError(
        "stale-revision",
        `旧 revision 覆盖被拒绝: 现有 ${current.revision}，试图写入 ${input.document.revision}`,
      );
    }
    const parsed = permissionProfileDocumentSchema.safeParse(input.document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `权限组文档非法: ${parsed.error.message}`,
      );
    }
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    await writeAtomicJson(this.profileFilePath(input.document.permissionProfileId), parsed.data);
    await backupExistingFile(
      this.profileFilePath(input.document.permissionProfileId),
      this.backupFilePath(input.document.permissionProfileId),
    );
    return parsed.data;
  }

  /** 列出自定义组 ID（目录名即安全编码后的 ID）。 */
  async listCustomProfileIds(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(this.profilesRootDirectory);
      return entries
        .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".bak"))
        .map((entry) => decodeProfileId(entry.slice(0, -".json".length)));
    } catch {
      return [];
    }
  }

  /** 批量读取全部自定义组（名称唯一性检查等 O(n) 场景）。 */
  async listCustomProfiles(): Promise<PermissionProfileDocument[]> {
    const profileIds = await this.listCustomProfileIds();
    const documents = await Promise.all(
      profileIds.map((profileId) => this.readCustomProfile(profileId)),
    );
    return documents.filter(
      (document): document is PermissionProfileDocument => document !== null,
    );
  }

  /** 删除自定义组（删除前自动备份既有内容；内置组拒绝）。 */
  async deleteCustomProfile(permissionProfileId: string): Promise<void> {
    const { copyFile, rm } = await import("node:fs/promises");
    const filePath = this.profileFilePath(permissionProfileId);
    const backupPath = this.backupFilePath(permissionProfileId);
    try {
      await copyFile(filePath, backupPath);
    } catch {
      // 文件不存在：视为已删除
      return;
    }
    await rm(filePath, { force: true });
  }
}

/** 生成新自定义组 ID（不可复用）。 */
export function newCustomProfileId(): string {
  return `profile-${randomUUID()}`;
}

/** 名称唯一性规范化：Unicode 规范化 + 大小写折叠。 */
export function normalizeProfileDisplayName(displayName: string): string {
  return displayName.normalize("NFC").trim().toLowerCase();
}

function sanitizeProfileId(permissionProfileId: string): string {
  let encoded = "";
  for (const character of permissionProfileId) {
    if (/[A-Za-z0-9._-]/.test(character)) {
      encoded += character;
    } else {
      encoded += `~${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
  return encoded;
}

function decodeProfileId(encodedProfileId: string): string {
  let decoded = "";
  let index = 0;
  while (index < encodedProfileId.length) {
    const character = encodedProfileId[index]!;
    if (character === "~") {
      const hex = encodedProfileId.slice(index + 1, index + 5);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
    } else {
      decoded += character;
      index += 1;
    }
  }
  return decoded;
}
