/**
 * 四层 Agent 路由 schema（T08C-01 / ADR-0025）。
 *
 * 覆盖四层角色关系、次级直投任务信封、次级面向用户摘要
 * （SECONDARY_USER_FACING_SUMMARY_V1）、项目侦察摘要
 * （PROJECT_CONTEXT_DIGEST_V1）、侦察任务声明、验收裁决
 * （AcceptanceVerdict）与四级委派关系。
 *
 * 本文件只定义 schema 与冻结常量；路由/生命周期逻辑由后续检查点
 * （T08C-02~06）实现。任何删除、替换、截断或覆盖必须先由执行工具备份。
 */
import { z } from "zod";

/** 次级直投任务信封 schema 版本（T08C-01 冻结）。 */
export const SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION = 1;
/** 次级面向用户摘要 schema 版本（T08C-01 冻结）。 */
export const SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION = 1;
/** 项目侦察摘要 schema 版本（T08C-01 冻结）。 */
export const PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION = 1;
/** 侦察任务声明 schema 版本（T08C-01 冻结）。 */
export const PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION = 1;
/** 四级委派关系 schema 版本（T08C-01 冻结）。 */
export const QUATERNARY_DELEGATION_SCHEMA_VERSION = 1;

/** 验收裁决三态（ADR-0025 §4；冻结值）。 */
export const ACCEPTANCE_VERDICT_VALUES = [
  "rework",
  "merge-ready",
  "blocked-human-review",
] as const;
export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICT_VALUES)[number];

export const acceptanceVerdictValueSchema = z.enum(ACCEPTANCE_VERDICT_VALUES);

/** 角色层级数值（main=0 … quaternary=3）；越靠后权限/范围越窄。 */
export const AGENT_ROLE_LEVEL: Record<
  "main" | "secondary" | "tertiary" | "quaternary",
  number
> = {
  main: 0,
  secondary: 1,
  tertiary: 2,
  quaternary: 3,
};

/**
 * 次级直投任务信封（ADR-0025 §1）。
 * 认证用户确认后由本地控制面投递；不调用主 Agent 模型规划，
 * 不复制主会话，只携带该任务与显式附件引用。
 */
export const secondaryDirectTaskEnvelopeSchema = z.object({
  schemaVersion: z.literal(SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION),
  envelopeId: z.string().min(1),
  /** 原始用户来源（认证用户标识；harness 注入，模型不能填写）。 */
  authenticatedUserId: z.string().min(1),
  /** 具体目标次级 Agent（不可复用实例 ID）。 */
  targetSecondaryAgentInstanceId: z.string().min(1),
  /** 任务范围描述（有界，不修改总体架构/公共契约）。 */
  scopeDescription: z.string().min(1),
  /** 用户原始任务指令（原文保留；不得被 Agent 改写）。 */
  originalUserInstruction: z.string().min(1),
  /** 用户任务保持优先级层级 0。 */
  priorityTier: z.literal(0),
  anchor: z.object({
    predecessorTaskIds: z.array(z.string().min(1)),
    successorTaskIds: z.array(z.string().min(1)),
  }),
  /** 验收标准（可核对，供裁决参考）。 */
  acceptanceCriteria: z.string().min(1),
  /** 显式附件引用（哈希绑定；不复制主 Agent 完整会话）。 */
  attachedContextReferenceHashes: z
    .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    .min(1),
  createdAtIso: z.iso.datetime(),
  /** 信封 revision（本地控制面单调递增）。 */
  revision: z.number().int().min(1),
});

/**
 * 次级面向用户摘要（SECONDARY_USER_FACING_SUMMARY_V1，ADR-0025 §6）。
 * 次级压缩大量下级汇报后交给主 Agent 的有界摘要；来源、风险、
 * 失败与待用户裁决事项不得因压缩消失。
 */
export const secondaryUserFacingSummarySchema = z.object({
  schemaVersion: z.literal(SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION),
  summaryId: z.string().min(1),
  /** 生成摘要的具体次级 Agent（不可复用实例 ID）。 */
  secondaryAgentInstanceId: z.string().min(1),
  /** 绑定任务/序列标识（revision 供主 Agent 追问时定向查询）。 */
  boundTaskIdentifier: z.string().min(1),
  boundTaskRevision: z.number().int().min(1),
  goal: z.string().min(1),
  currentProgress: z.string().min(1),
  /** 主要结果（含证据引用；不带来源不得冒充主 Agent 发现）。 */
  keyResults: z.array(
    z.object({
      resultSummary: z.string().min(1),
      evidenceReference: z.string().min(1),
    }),
  ),
  /** 风险与失败（不得因压缩删除）。 */
  risksAndFailures: z.array(z.string().min(1)).min(1),
  /** 需要用户决定的事项（高优先级；未裁决则目标产出冻结）。 */
  pendingUserDecisions: z.array(z.string().min(1)).min(1),
  createdAtIso: z.iso.datetime(),
  revision: z.number().int().min(1),
});

/**
 * 项目侦察摘要（PROJECT_CONTEXT_DIGEST_V1，ADR-0025 §3）。
 * 侦察型三级 Agent 返回给次级的有界摘要；大量原文与工具输出保留在
 * 侦察个体存档，不灌入次级上下文。
 */
export const projectContextDigestSchema = z.object({
  schemaVersion: z.literal(PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION),
  digestId: z.string().min(1),
  /** 具体侦察 Agent（不可复用实例 ID）。 */
  reconnaissanceAgentInstanceId: z.string().min(1),
  scanningScope: z.string().min(1),
  keyEntryPoints: z.array(z.string().min(1)),
  stableContracts: z.array(z.string().min(1)),
  /** 相关文件引用（路径 + 内容指纹，不携带全文）。 */
  relevantFileReferences: z.array(
    z.object({
      filePath: z.string().min(1),
      contentFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
  ),
  dependencyRelations: z.array(z.string().min(1)),
  testEntryPoints: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  conflicts: z.array(z.string().min(1)),
  sources: z.array(z.string().min(1)),
  /** 项目指纹变化后旧摘要标记为 stale（ADR-0025 §3）。 */
  isStale: z.boolean(),
  /** 受 token 预算约束的摘要（不得超预算）。 */
  tokenBudget: z.number().int().min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAtIso: z.iso.datetime(),
  revision: z.number().int().min(1),
});

/**
 * 侦察任务声明（ADR-0025 §3）。
 * 次级为侦察型三级 Agent 分配只读任务链与最小读取工具子集。
 */
export const projectReconnaissanceTaskSchema = z.object({
  schemaVersion: z.literal(PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION),
  reconnaissanceTaskId: z.string().min(1),
  assigningSecondaryAgentInstanceId: z.string().min(1),
  scopeQuery: z.string().min(1),
  /** 只读；最小读取工具子集（不含写入/执行/网络/备份）。 */
  allowedReadToolNames: z.array(z.string().min(1)).min(1),
  tokenBudget: z.number().int().min(1),
  createdAtIso: z.iso.datetime(),
});

/**
 * 四级委派关系（ADR-0025 §5）。
 * 三级经本地控制面创建四级；四级权限/工具/资源/期限是三级严格子集，
 * 绑定具体上级三级 agentInstanceId，不可复用身份，不得创建第五级。
 */
export const quaternaryDelegationSchema = z.object({
  schemaVersion: z.literal(QUATERNARY_DELEGATION_SCHEMA_VERSION),
  delegationId: z.string().min(1),
  /** 上级三级 Agent（不可复用实例 ID）。 */
  delegatingTertiaryAgentInstanceId: z.string().min(1),
  /** 新创建的四级 Agent（不可复用实例 ID）。 */
  quaternaryAgentInstanceId: z.string().min(1),
  /** 四级只执行上级任务链中的一个严格子链。 */
  boundSubchainTaskIds: z.array(z.string().min(1)).min(1),
  /** 权限/工具/资源范围/期限不得宽于三级。 */
  permissionSubset: z.string().min(1),
  allowedToolNamesSubset: z.array(z.string().min(1)),
  resourceScopeSubset: z.string().min(1),
  expiresAtIso: z.iso.datetime(),
  createdAtIso: z.iso.datetime(),
});

/**
 * 验收裁决（ADR-0025 §4）。
 * 验收 Agent 对照目标/架构/差异/测试/人工验收要求给出建议；
 * 绑定任务 revision、提交哈希、验收人来源与界面版本；任一变化使旧裁决失效。
 */
export const acceptanceVerdictSchema = z.object({
  verdict: acceptanceVerdictValueSchema,
  boundTaskIdentifier: z.string().min(1),
  boundTaskRevision: z.number().int().min(1),
  /** 被验收产出的不可变提交哈希（未提交产出为 null）。 */
  boundCommitHash: z.string().min(1).nullable(),
  /** 具体验收 Agent（不可复用实例 ID）。 */
  acceptingAgentInstanceId: z.string().min(1),
  reason: z.string().min(1),
  evidenceReferences: z.array(z.string().min(1)),
  createdAtIso: z.iso.datetime(),
});
