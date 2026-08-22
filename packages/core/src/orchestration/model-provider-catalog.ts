/**
 * 版本化 Provider/模型目录（T07C-01 / ADR-0026 §1）。
 *
 * 公开条目使用稳定 providerProfileId 与 modelProfileId，记录显示名、
 * 模型标识、能力、上下文上限、工具/视觉支持、成本标签、区域与健康状态。
 * Provider 凭据、API key、endpoint secret 与本地能力令牌只以受保护
 * 凭据引用存在，不进入公开 DTO、Agent prompt、日志、导出或反馈。
 * 目录不设模型数量上限（仅受通用磁盘/文档/分页限制）。
 */
import { z } from "zod";

import { DomainError } from "../core/errors.js";

/** 目录 schema 版本（T07C-01 冻结）。 */
export const MODEL_PROVIDER_CATALOG_SCHEMA_VERSION = 1;

/** 模型能力标签（公开；用于能力过滤）。 */
export const MODEL_CAPABILITY_TAGS = [
  "text",
  "vision",
  "tool-calling",
  "long-context",
] as const;
export type ModelCapabilityTag = (typeof MODEL_CAPABILITY_TAGS)[number];

/** 健康状态（公开；由健康探针更新，不含探针内部细节）。 */
export const MODEL_HEALTH_STATES = ["healthy", "degraded", "disabled"] as const;
export type ModelHealthState = (typeof MODEL_HEALTH_STATES)[number];

/** 目录公开条目（凭据只含受保护引用，不含任何秘密内容）。 */
export const modelProviderCatalogEntrySchema = z.object({
  schemaVersion: z.literal(MODEL_PROVIDER_CATALOG_SCHEMA_VERSION),
  providerProfileId: z.string().min(1),
  modelProfileId: z.string().min(1),
  displayName: z.string().min(1),
  /** 模型标识（运行时使用；公开稳定）。 */
  modelIdentifier: z.string().min(1),
  capabilities: z.array(z.enum(MODEL_CAPABILITY_TAGS)),
  contextWindowTokens: z.number().int().min(1),
  supportsToolCalling: z.boolean(),
  supportsVision: z.boolean(),
  costTier: z.enum(["low", "medium", "high"]),
  regionLabel: z.string().min(1),
  healthState: z.enum(MODEL_HEALTH_STATES),
  /** 受保护凭据引用（不携带 API key/endpoint secret/令牌内容）。 */
  protectedCredentialReferenceId: z.string().min(1),
  revision: z.number().int().min(1),
  createdAtIso: z.iso.datetime(),
  updatedAtIso: z.iso.datetime(),
});
export type ModelProviderCatalogEntry = z.infer<
  typeof modelProviderCatalogEntrySchema
>;

/** 公开 DTO：剥离受保护凭据引用与内部字段，供 Agent prompt/日志/导出/反馈。 */
export type ModelProviderCatalogPublicDto = Omit<
  ModelProviderCatalogEntry,
  "protectedCredentialReferenceId"
>;

/** 受保护凭据存储端口（凭据内容只在授权运行时内流转，不进目录/日志/导出）。 */
export interface ProtectedCredentialStorePort {
  /** 校验受保护引用存在（不返回凭据内容）。 */
  doesReferenceExist(referenceId: string): Promise<boolean>;
  /** 读取凭据（仅装配方授权调用；返回内容不得进入公开 DTO/日志）。 */
  readCredential(referenceId: string): Promise<{
    baseUrl: string;
    apiKey: string;
  } | null>;
}

export interface ModelProviderCatalogOptions {
  protectedCredentialStore: ProtectedCredentialStorePort;
}

export class ModelProviderCatalog {
  private readonly entriesByModelId = new Map<string, ModelProviderCatalogEntry>();
  private readonly protectedCredentialStore: ProtectedCredentialStorePort;

  constructor(options: ModelProviderCatalogOptions) {
    this.protectedCredentialStore = options.protectedCredentialStore;
  }

  /**
   * 登记/更新模型条目：受保护凭据引用必须存在（不读取内容）；
   * revision 单调递增。数量不设上限。
   */
  async upsertEntry(input: {
    providerProfileId: string;
    modelProfileId: string;
    displayName: string;
    modelIdentifier: string;
    capabilities: ModelCapabilityTag[];
    contextWindowTokens: number;
    supportsToolCalling: boolean;
    supportsVision: boolean;
    costTier: "low" | "medium" | "high";
    regionLabel: string;
    healthState: ModelHealthState;
    protectedCredentialReferenceId: string;
  }): Promise<ModelProviderCatalogEntry> {
    const doesReferenceExist =
      await this.protectedCredentialStore.doesReferenceExist(
        input.protectedCredentialReferenceId,
      );
    if (!doesReferenceExist) {
      throw new DomainError(
        "invalid-task-chain",
        `受保护凭据引用不存在（凭据不进入目录）: ${input.protectedCredentialReferenceId}`,
      );
    }
    const modelProfileId = `${input.providerProfileId}/${input.modelProfileId}`;
    const existing = this.entriesByModelId.get(modelProfileId);
    const nowIso = new Date().toISOString();
    const entry: ModelProviderCatalogEntry = {
      schemaVersion: MODEL_PROVIDER_CATALOG_SCHEMA_VERSION,
      providerProfileId: input.providerProfileId,
      modelProfileId: modelProfileId,
      displayName: input.displayName,
      modelIdentifier: input.modelIdentifier,
      capabilities: input.capabilities,
      contextWindowTokens: input.contextWindowTokens,
      supportsToolCalling: input.supportsToolCalling,
      supportsVision: input.supportsVision,
      costTier: input.costTier,
      regionLabel: input.regionLabel,
      healthState: input.healthState,
      protectedCredentialReferenceId: input.protectedCredentialReferenceId,
      revision: (existing?.revision ?? 0) + 1,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    };
    this.entriesByModelId.set(modelProfileId, entry);
    return entry;
  }

  /** 读取条目（完整；仅本地控制面内部使用）。 */
  getEntry(modelProfileId: string): ModelProviderCatalogEntry | null {
    return this.entriesByModelId.get(modelProfileId) ?? null;
  }

  /** 公开 DTO 列表：剥离受保护凭据引用（供 Agent prompt/日志/导出/反馈）。 */
  listPublicDtos(): ModelProviderCatalogPublicDto[] {
    return [...this.entriesByModelId.values()].map((entry) => ({
      schemaVersion: entry.schemaVersion,
      providerProfileId: entry.providerProfileId,
      modelProfileId: entry.modelProfileId,
      displayName: entry.displayName,
      modelIdentifier: entry.modelIdentifier,
      capabilities: entry.capabilities,
      contextWindowTokens: entry.contextWindowTokens,
      supportsToolCalling: entry.supportsToolCalling,
      supportsVision: entry.supportsVision,
      costTier: entry.costTier,
      regionLabel: entry.regionLabel,
      healthState: entry.healthState,
      revision: entry.revision,
      createdAtIso: entry.createdAtIso,
      updatedAtIso: entry.updatedAtIso,
    }));
  }

  /** 校验公开 DTO 不含凭据内容（凭据泄漏反例用）。 */
  static assertPublicDtoHasNoCredentialContent(
    publicDto: ModelProviderCatalogPublicDto,
  ): void {
    const serialized = JSON.stringify(publicDto);
    const leakedPatterns = [
      /api[_-]?key/i,
      /secret/i,
      /bearer\s+[A-Za-z0-9]/i,
      /sk-[A-Za-z0-9]{6,}/i,
      /authorization/i,
    ];
    const leaked = leakedPatterns.some((pattern) => pattern.test(serialized));
    if (leaked) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "公开 DTO 不得携带凭据/密钥内容",
      );
    }
  }
}