/**
 * 自定义权限组控制器（T06F / ADR-0020 §自定义模式与生命周期）。
 * 创建、命名、重命名、复制、导入、导出、重置和删除自定义权限组。
 * - 不可复用 permissionProfileId；名称经 Unicode 规范化 + 大小写折叠后在
 *   活动组中唯一，保留内置中英文名；
 * - 创建源支持空白全 deny、内置模式可配置视图或任一自定义组；复制后
 *   revision/ID 独立；新权限按 fallback（默认 deny）；
 * - 无产品数量上限，仅通用单文档大小、磁盘空间与并发写入保护；
 * - 覆盖/重置/导入/删除前自动备份；三个内置组不可删除，当前使用组不能删除；
 * - 生命周期由认证用户设置控制面直接提供，不作为 Agent 工具权限开关。
 */
import { DomainError } from "../core/errors.js";
import {
  BUILTIN_PROFILE_DISPLAY_NAMES,
  newCustomProfileId,
  normalizeProfileDisplayName,
} from "./permission-profile-store.js";
import type { PermissionProfileStore } from "./permission-profile-store.js";
import type {
  PermissionProfileDocument,
  PermissionProfileReference,
} from "./permission-profile-store.js";
import type { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";

export type ProfileCreationSource =
  | { kind: "blank" }
  | { kind: "builtin"; profileId: "ponder" | "assist" | "devolve" }
  | { kind: "custom"; permissionProfileId: string };

export interface CreateCustomProfileInput {
  displayName: string;
  source: ProfileCreationSource;
}

export interface RenameCustomProfileInput {
  permissionProfileId: string;
  newDisplayName: string;
  expectedRevision: number;
}

export interface UpdateCapabilityDecisionInput {
  permissionProfileId: string;
  capabilityId: string;
  decision: PermissionDecision;
  expectedRevision: number;
}

export interface ExportProfileResult {
  /** 可配置目录字段（不含内部状态/执行策略）。 */
  exportedDocument: Record<string, unknown>;
  exportedAtIso: string;
}

export class CustomPermissionProfileController {
  /** 活动组名称缓存（规范化名；首次读盘填充，后续内存比较）。 */
  private readonly displayNameCache = new Set<string>();
  private isDisplayNameCacheLoaded = false;

  constructor(
    private readonly store: PermissionProfileStore,
    private readonly catalog: PermissionCapabilityCatalog,
  ) {}

  /** 创建自定义组（无数量上限；名称唯一性校验）。 */
  async createProfile(
    input: CreateCustomProfileInput,
  ): Promise<PermissionProfileDocument> {
    await this.assertDisplayNameAvailable(input.displayName);
    const baseDecisions: Record<string, PermissionDecision> = {};
    if (input.source.kind === "builtin") {
      const builtin = this.store.buildBuiltinProfile(input.source.profileId);
      for (const [capabilityId, decision] of Object.entries(
        builtin.capabilityDecisions,
      )) {
        baseDecisions[capabilityId] = decision as PermissionDecision;
      }
    } else if (input.source.kind === "custom") {
      const sourceDocument = await this.store.readCustomProfile(
        input.source.permissionProfileId,
      );
      if (sourceDocument === null) {
        throw new DomainError(
          "task-sequence-not-found",
          `源权限组不存在: ${input.source.permissionProfileId}`,
        );
      }
      for (const [capabilityId, decision] of Object.entries(
        sourceDocument.capabilityDecisions,
      )) {
        baseDecisions[capabilityId] = decision as PermissionDecision;
      }
    }
    const permissionProfileId = newCustomProfileId();
    const document: PermissionProfileDocument = {
      schemaVersion: 1,
      permissionProfileId,
      displayName: input.displayName.trim(),
      isBuiltin: false,
      revision: 1,
      catalogVersion: this.catalog.getCatalogVersion(),
      capabilityDecisions: baseDecisions,
      fallbackDecision: "deny",
      frozenSignature: null,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const saved = await this.store.saveCustomProfile({
      document,
      expectedRevision: 0,
    });
    this.registerDisplayName(saved.displayName);
    return saved;
  }

  /** 重命名（不改变 ID；名称唯一性校验）。 */
  async renameProfile(input: RenameCustomProfileInput): Promise<PermissionProfileDocument> {
    const document = await this.requireCustomProfile(input.permissionProfileId);
    if (input.newDisplayName.trim() === document.displayName) {
      return document;
    }
    await this.assertDisplayNameAvailable(input.newDisplayName);
    const renamed: PermissionProfileDocument = {
      ...document,
      displayName: input.newDisplayName.trim(),
      revision: document.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    const saved = await this.store.saveCustomProfile({
      document: renamed,
      expectedRevision: input.expectedRevision,
    });
    this.unregisterDisplayName(document.displayName);
    this.registerDisplayName(saved.displayName);
    return saved;
  }

  /** 逐项三态更新（schema 暴露与执行时同步生效）。 */
  async updateCapabilityDecision(
    input: UpdateCapabilityDecisionInput,
  ): Promise<PermissionProfileDocument> {
    const document = await this.requireCustomProfile(input.permissionProfileId);
    if (!this.catalog.getCapability(input.capabilityId)) {
      throw new DomainError(
        "dependency-not-found",
        `目录无此权限: ${input.capabilityId}`,
      );
    }
    const updated: PermissionProfileDocument = {
      ...document,
      capabilityDecisions: {
        ...document.capabilityDecisions,
        [input.capabilityId]: input.decision,
      },
      revision: document.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    return this.store.saveCustomProfile({
      document: updated,
      expectedRevision: input.expectedRevision,
    });
  }

  /** 重置为创建源（保留 ID/名称；revision 继续单调）。 */
  async resetProfile(input: {
    permissionProfileId: string;
    source: ProfileCreationSource;
    expectedRevision: number;
  }): Promise<PermissionProfileDocument> {
    const document = await this.requireCustomProfile(input.permissionProfileId);
    const baseDecisions: Record<string, PermissionDecision> = {};
    if (input.source.kind === "builtin") {
      const builtin = this.store.buildBuiltinProfile(input.source.profileId);
      Object.assign(
        baseDecisions,
        builtin.capabilityDecisions as Record<string, PermissionDecision>,
      );
    } else if (input.source.kind === "custom") {
      const sourceDocument = await this.store.readCustomProfile(
        input.source.permissionProfileId,
      );
      if (sourceDocument === null) {
        throw new DomainError(
          "task-sequence-not-found",
          `源权限组不存在: ${input.source.permissionProfileId}`,
        );
      }
      Object.assign(
        baseDecisions,
        sourceDocument.capabilityDecisions as Record<string, PermissionDecision>,
      );
    }
    const reset: PermissionProfileDocument = {
      ...document,
      capabilityDecisions: baseDecisions,
      revision: document.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    return this.store.saveCustomProfile({
      document: reset,
      expectedRevision: input.expectedRevision,
    });
  }

  /** 导出：只含可配置目录字段（不含 revision 内部状态？revision 属身份，保留）。 */
  async exportProfile(
    reference: PermissionProfileReference,
  ): Promise<ExportProfileResult> {
    const document = await this.store.readProfile(reference);
    return {
      exportedDocument: {
        schemaVersion: document.schemaVersion,
        permissionProfileId: document.permissionProfileId,
        displayName: document.displayName,
        catalogVersion: document.catalogVersion,
        capabilityDecisions: document.capabilityDecisions,
        fallbackDecision: document.fallbackDecision,
      },
      exportedAtIso: new Date().toISOString(),
    };
  }

  /** 导入：只接受可配置目录字段，不携带内部状态或执行策略。 */
  async importProfile(input: {
    exportedDocument: Record<string, unknown>;
  }): Promise<PermissionProfileDocument> {
    const capabilityDecisions = input.exportedDocument["capabilityDecisions"];
    const displayName = input.exportedDocument["displayName"];
    if (
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      typeof capabilityDecisions !== "object" ||
      capabilityDecisions === null
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "导入内容非法：缺少 displayName/capabilityDecisions",
      );
    }
    await this.assertDisplayNameAvailable(displayName);
    const filteredDecisions: Record<string, PermissionDecision> = {};
    for (const [capabilityId, decision] of Object.entries(
      capabilityDecisions as Record<string, unknown>,
    )) {
      if (
        this.catalog.getCapability(capabilityId) !== undefined &&
        (decision === "deny" || decision === "ask" || decision === "allow")
      ) {
        filteredDecisions[capabilityId] = decision;
      }
    }
    const permissionProfileId = newCustomProfileId();
    const document: PermissionProfileDocument = {
      schemaVersion: 1,
      permissionProfileId,
      displayName: displayName.trim(),
      isBuiltin: false,
      revision: 1,
      catalogVersion: this.catalog.getCatalogVersion(),
      capabilityDecisions: filteredDecisions,
      fallbackDecision: "deny",
      frozenSignature: null,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const saved = await this.store.saveCustomProfile({
      document,
      expectedRevision: 0,
    });
    this.registerDisplayName(saved.displayName);
    return saved;
  }

  /** 删除自定义组（当前使用组由调用方先切换；删除前自动备份）。 */
  async deleteProfile(input: {
    permissionProfileId: string;
    isCurrentlyActive: boolean;
  }): Promise<void> {
    if (input.isCurrentlyActive) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "当前使用中的权限组不能直接删除，请先切换",
      );
    }
    const document = await this.requireCustomProfile(input.permissionProfileId);
    await this.store.deleteCustomProfile(input.permissionProfileId);
    this.unregisterDisplayName(document.displayName);
  }

  private async requireCustomProfile(
    permissionProfileId: string,
  ): Promise<PermissionProfileDocument> {
    const document = await this.store.readCustomProfile(permissionProfileId);
    if (document === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `权限组不存在: ${permissionProfileId}`,
      );
    }
    return document;
  }

  /** 名称唯一性：规范化后不得与任何活动组（含内置名）冲突。 */
  private async assertDisplayNameAvailable(displayName: string): Promise<void> {
    const normalized = normalizeProfileDisplayName(displayName);
    if (normalized === "") {
      throw new DomainError("invalid-task-chain", "权限组名称不能为空");
    }
    if (
      BUILTIN_PROFILE_DISPLAY_NAMES.some(
        (builtinName) => normalizeProfileDisplayName(builtinName) === normalized,
      )
    ) {
      throw new DomainError(
        "invalid-task-chain",
        `名称与内置模式冲突（保留名）: ${displayName}`,
      );
    }
    await this.ensureDisplayNameCacheLoaded();
    if (this.displayNameCache.has(normalized)) {
      throw new DomainError(
        "invalid-task-chain",
        `权限组名称已存在: ${displayName}`,
      );
    }
  }

  /** 首次调用时从磁盘加载活动组名称（此后内存维护，避免 O(n²) 读盘）。 */
  private async ensureDisplayNameCacheLoaded(): Promise<void> {
    if (this.isDisplayNameCacheLoaded) {
      return;
    }
    const existingProfiles = await this.store.listCustomProfiles();
    for (const profile of existingProfiles) {
      this.displayNameCache.add(
        normalizeProfileDisplayName(profile.displayName),
      );
    }
    this.isDisplayNameCacheLoaded = true;
  }

  /** 创建/导入成功后登记名称。 */
  private registerDisplayName(displayName: string): void {
    this.displayNameCache.add(normalizeProfileDisplayName(displayName));
  }

  /** 重命名后更新名称登记。 */
  private unregisterDisplayName(displayName: string): void {
    this.displayNameCache.delete(normalizeProfileDisplayName(displayName));
  }
}
