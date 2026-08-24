/**
 * Agent 工作集与读取预算契约（T07E-01 / ADR-0029）。
 *
 * - 默认 10 文件工作集（maximumDistinctProjectContentFilesPerAgentActivation）；
 * - 8 文件提醒阈值（workingSetWarningThresholdFileCount）；
 * - 规范资源身份（别名/链接不能重复占槽）；
 * - 来源 manifest（聚合旁路防护：无 manifest fail-closed）；
 * - ReadBudgetExpansionGrant（范围化扩展：绑定 Agent/任务链/revision/数量/
 *   路径/用途/理由/期限/发布者；扩展不是读取权限）。
 */
import { z } from "zod";

/** 工作集 schema 版本（T07E-01 冻结）。 */
export const WORKING_SET_SCHEMA_VERSION = 1;
/** 来源 manifest schema 版本（T07E-01 冻结）。 */
export const SOURCE_MANIFEST_SCHEMA_VERSION = 1;
/** 预算扩展 grant schema 版本（T07E-01 冻结）。 */
export const READ_BUDGET_EXPANSION_GRANT_SCHEMA_VERSION = 1;

/** 默认每 Agent 任务激活最大不同项目内容文件数（冻结默认）。 */
export const DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION = 10;
/** 默认工作集提醒阈值（冻结默认；达到时本地提醒不增加模型调用）。 */
export const DEFAULT_WORKING_SET_WARNING_THRESHOLD_FILE_COUNT = 8;

/** 预算决定（完成事件字段；冻结）。 */
export const WORKING_SET_BUDGET_DECISIONS = [
  "allowed",
  "warned",
  "denied",
  "split",
  "expanded",
] as const;
export type WorkingSetBudgetDecision =
  (typeof WORKING_SET_BUDGET_DECISIONS)[number];

/** 规范资源指纹（sha256；用于同文件别名识别）。 */
export const resourceIdentityFingerprintSchema = z.string().regex(
  /^sha256:[a-f0-9]{64}$/,
);

/** 工作集条目（规范身份 + 指纹；同一文件别名合并）。 */
export const workingSetEntrySchema = z.object({
  schemaVersion: z.literal(WORKING_SET_SCHEMA_VERSION),
  /** 规范资源身份（resolve 后；别名/链接归一）。 */
  canonicalResourceIdentity: z.string().min(1),
  contentFingerprint: resourceIdentityFingerprintSchema,
  /** 首次进入工作集时间。 */
  firstSeenAtIso: z.iso.datetime(),
  /** 文件真实变化后旧摘要标记 stale。 */
  isStale: z.boolean(),
});
export type WorkingSetEntry = z.infer<typeof workingSetEntrySchema>;

/** 来源 manifest（聚合/归档旁路防护：按原文件分别计数）。 */
export const sourceManifestSchema = z.object({
  schemaVersion: z.literal(SOURCE_MANIFEST_SCHEMA_VERSION),
  manifestIdentifier: z.string().min(1),
  /** 来源原文件（不得省略/隐藏）。 */
  sourceFileCanonicalIdentities: z.array(z.string().min(1)).min(1),
  contentHash: resourceIdentityFingerprintSchema,
  createdAtIso: z.iso.datetime(),
});
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/** 工作集状态（多维预算快照）。 */
export const workingSetStateSchema = z.object({
  schemaVersion: z.literal(WORKING_SET_SCHEMA_VERSION),
  agentInstanceId: z.string().min(1),
  taskChainIdentifier: z.string().min(1),
  /** 不同项目内容文件数（活动工作集）。 */
  distinctProjectContentFileCount: z.number().int().min(0),
  /** 模型可见项目内容字节数。 */
  modelVisibleProjectContentBytes: z.number().int().min(0),
  /** 估算项目内容 token 数。 */
  estimatedProjectContentTokenCount: z.number().int().min(0),
  /** 治理文档独立预算（不挤占项目槽）。 */
  governanceDocumentReadCount: z.number().int().min(0),
  entries: z.array(workingSetEntrySchema),
});
export type WorkingSetState = z.infer<typeof workingSetStateSchema>;

/** 范围化预算扩展 grant（绑定一切要素；变化即失效）。 */
export const readBudgetExpansionGrantSchema = z.object({
  schemaVersion: z.literal(READ_BUDGET_EXPANSION_GRANT_SCHEMA_VERSION),
  grantIdentifier: z.string().min(1),
  /** 具体 Agent（不可复用实例 ID）。 */
  agentInstanceId: z.string().min(1),
  taskChainIdentifier: z.string().min(1),
  /** 当前预算 revision（grant 绑定；变化失效）。 */
  budgetRevision: z.number().int().min(1),
  additionalFileCountAllowed: z.number().int().min(1),
  allowedPathsOrPurposes: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  expiresAtIso: z.iso.datetime(),
  /** 发布者来源（认证用户或本地控制面；模型不能填写）。 */
  issuedBy: z.enum(["authenticated-user", "local-control-plane"]),
  issuedAtIso: z.iso.datetime(),
});
export type ReadBudgetExpansionGrant = z.infer<
  typeof readBudgetExpansionGrantSchema
>;