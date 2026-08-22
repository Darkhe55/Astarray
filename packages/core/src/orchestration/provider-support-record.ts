/**
 * Provider 支持记录（T07D-00 / T07D 任务卡 §4）。
 *
 * 每个 Provider/协议必须记录可审计支持等级：
 * - adapter-only：只有转换代码或单元 fixture → 不得宣称支持；
 * - fake-server-conformant：通过本地协议服务器 → 只能称"协议适配完成"；
 * - live-smoke-verified：用户提供凭据完成真实 API 冒烟 → 注明日期/区域/API 版本/模型；
 * - product-path-verified：从 npm tarball 经 CLI/TUI/SDK 完成真实工作流 → 可称"当前版本可用"。
 * 没有动态证据时必须写"未验证"或"条件兼容"。
 */
import { z } from "zod";

/** 支持记录 schema 版本（T07D-00 冻结）。 */
export const PROVIDER_SUPPORT_RECORD_SCHEMA_VERSION = 1;

/** 支持等级（冻结；声明规则见任务卡 §4）。 */
export const PROVIDER_SUPPORT_LEVELS = [
  "adapter-only",
  "fake-server-conformant",
  "live-smoke-verified",
  "product-path-verified",
] as const;
export type ProviderSupportLevel = (typeof PROVIDER_SUPPORT_LEVELS)[number];

/** 认证方式（T07D-01 将细化实现；此处为声明字段）。 */
export const PROVIDER_AUTH_METHODS = [
  "bearer",
  "named-api-key-header",
  "async-token-provider",
  "request-signing",
] as const;
export type ProviderAuthMethod = (typeof PROVIDER_AUTH_METHODS)[number];

/** Provider 支持记录（可审计；支持等级必须有动态证据支撑）。 */
export const providerSupportRecordSchema = z.object({
  schemaVersion: z.literal(PROVIDER_SUPPORT_RECORD_SCHEMA_VERSION),
  /** 稳定 Provider 标识（与 ModelProviderCatalog 的 providerProfileId 一致）。 */
  providerProfileId: z.string().min(1),
  /** 协议名（如 openai-responses / openai-chat-completions / anthropic-messages / gemini-interactions / azure-openai / bedrock-converse / generic-openai-compatible / mock）。 */
  protocolName: z.string().min(1),
  /** API 版本（显式记录；无则 "unversioned"）。 */
  apiVersion: z.string().min(1),
  authMethods: z.array(z.enum(PROVIDER_AUTH_METHODS)),
  capabilities: z.array(z.string().min(1)),
  supportLevel: z.enum(PROVIDER_SUPPORT_LEVELS),
  /** 验证时间（ISO；无动态验证为 null）。 */
  verifiedAtIso: z.iso.datetime().nullable(),
  /** 测试证据引用（fixture/测试文件；无则为空数组）。 */
  testEvidenceReferences: z.array(z.string().min(1)),
  /** 已知限制（未验证/条件兼容必须写明）。 */
  knownLimitations: z.array(z.string().min(1)),
  /** 声明规则：adapter-only 不得宣称"已支持"（本 schema 只记录，宣称由文档/UI 遵守）。 */
  isClaimableAsSupported: z.boolean(),
});

export type ProviderSupportRecord = z.infer<
  typeof providerSupportRecordSchema
>;

/** 支持等级是否允许宣称"支持"（adapter-only 不允许；其余按任务卡措辞）。 */
export function canClaimProviderSupport(
  supportLevel: ProviderSupportLevel,
): boolean {
  return supportLevel !== "adapter-only";
}