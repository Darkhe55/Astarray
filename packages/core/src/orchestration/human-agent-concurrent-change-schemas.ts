/**
 * 人工—Agent 并行编码契约（T05D-01 / ADR-0028）。
 *
 * - AgentEditIntent：Agent 计划写入的协作元数据（非文件锁）；
 * - HumanChangeObservation：本地控制面观察的人工变化（认证来源注入）；
 * - ConcurrentChangeDecision：冲突决定五态；
 * - MergeBaselineBinding：合并前目标/人工/基线/贡献/证据/验收的 revision 绑定。
 *
 * 模型不能填写认证用户来源、实际文件指纹、Git 提交身份或最终冲突决定；
 * 这些字段由本地控制器注入或验证。
 */
import { z } from "zod";

/** 编辑意图 schema 版本（T05D-01 冻结）。 */
export const AGENT_EDIT_INTENT_SCHEMA_VERSION = 1;
/** 人工变化观察 schema 版本（T05D-01 冻结）。 */
export const HUMAN_CHANGE_OBSERVATION_SCHEMA_VERSION = 1;
/** 冲突决定 schema 版本（T05D-01 冻结）。 */
export const CONCURRENT_CHANGE_DECISION_SCHEMA_VERSION = 1;
/** 合并基线绑定 schema 版本（T05D-01 冻结）。 */
export const MERGE_BASELINE_BINDING_SCHEMA_VERSION = 1;

/** 冲突决定五态（冻结）。 */
export const CONCURRENT_CHANGE_DECISION_VALUES = [
  "no-overlap-revalidate",
  "text-conflict-reconcile",
  "contract-conflict-reconcile",
  "blocked-human-review",
  "agent-contribution-stale",
] as const;
export type ConcurrentChangeDecision =
  (typeof CONCURRENT_CHANGE_DECISION_VALUES)[number];

/** 规范资源指纹（内容指纹；sha256）。 */
export const resourceFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Agent 编辑意图（本地控制器创建；expiresAt 防止陈旧意图长期有效）。 */
export const agentEditIntentSchema = z.object({
  schemaVersion: z.literal(AGENT_EDIT_INTENT_SCHEMA_VERSION),
  editIntentIdentifier: z.string().min(1),
  /** 具体 Agent（不可复用实例 ID；本地控制面注入）。 */
  agentInstanceId: z.string().min(1),
  taskExecutionIdentifier: z.string().min(1),
  /** 读取基线时的提交标识。 */
  baseCommitIdentifier: z.string().min(1),
  plannedReadPaths: z.array(z.string().min(1)),
  allowedWritePaths: z.array(z.string().min(1)).min(1),
  /** 读取时的规范资源指纹（按路径）。 */
  initialResourceFingerprintsByPath: z.record(z.string(), resourceFingerprintSchema),
  /** 影响的公共契约（类型/schema/API/配置/迁移/锁文件/测试契约）。 */
  affectedContractIdentifiers: z.array(z.string().min(1)),
  /** 意图有效期（ISO；过期后不得写入）。 */
  expiresAtIso: z.iso.datetime(),
  revision: z.number().int().min(1),
});
export type AgentEditIntent = z.infer<typeof agentEditIntentSchema>;

/** 人工变化观察（本地控制面观察；模型不能伪造认证用户来源/指纹/提交身份）。 */
export const humanChangeObservationSchema = z.object({
  schemaVersion: z.literal(HUMAN_CHANGE_OBSERVATION_SCHEMA_VERSION),
  observationIdentifier: z.string().min(1),
  /** 认证用户来源（本地控制面注入；模型不能填写）。 */
  authenticatedUserSourceIdentifier: z.string().min(1),
  /** 观察到的提交（未提交修改为 null）。 */
  observedCommitIdentifier: z.string().min(1).nullable(),
  /** 变化路径（已提交修改/HEAD 前进时可为空；未提交修改时非空）。 */
  changedPaths: z.array(z.string().min(1)),
  /** 变化后规范资源指纹（按路径；文件被删除/重命名时可为空记录）。 */
  changedResourceFingerprintsByPath: z.record(z.string(), resourceFingerprintSchema),
  observedAtIso: z.iso.datetime(),
  observationRevision: z.number().int().min(1),
});
export type HumanChangeObservation = z.infer<
  typeof humanChangeObservationSchema
>;

/** 冲突决定（本地控制器裁决或用户裁决；绑定意图/观察与基线）。 */
export const concurrentChangeDecisionSchema = z
  .object({
    schemaVersion: z.literal(CONCURRENT_CHANGE_DECISION_SCHEMA_VERSION),
    decisionIdentifier: z.string().min(1),
    decision: z.enum(CONCURRENT_CHANGE_DECISION_VALUES),
    editIntentIdentifier: z.string().min(1),
    observationIdentifier: z.string().min(1),
    /** 决定来源：用户裁决或本地控制面（模型不能填写）。 */
    decidedBy: z.enum(["authenticated-user", "local-control-plane"]),
    /** 用户裁决时绑定认证用户来源。 */
    authenticatedUserSourceIdentifier: z.string().min(1).nullable(),
    reason: z.string().min(1),
    createdAtIso: z.iso.datetime(),
    revision: z.number().int().min(1),
  })
  .superRefine((decision, context) => {
    if (
      decision.decidedBy === "authenticated-user" &&
      decision.authenticatedUserSourceIdentifier === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authenticatedUserSourceIdentifier"],
        message: "用户裁决必须绑定认证用户来源（模型不能伪造人工来源）",
      });
    }
  });
export type ConcurrentChangeDecisionRecord = z.infer<
  typeof concurrentChangeDecisionSchema
>;

/** 合并基线绑定（任一变化使旧 merge-ready 失效）。 */
export const mergeBaselineBindingSchema = z.object({
  schemaVersion: z.literal(MERGE_BASELINE_BINDING_SCHEMA_VERSION),
  bindingIdentifier: z.string().min(1),
  targetBranchName: z.string().min(1),
  targetBranchHeadCommit: z.string().min(1),
  humanHeadCommit: z.string().min(1),
  agentBaseCommit: z.string().min(1),
  contributionHeadCommit: z.string().min(1),
  /** 测试证据引用（提交哈希绑定）。 */
  testEvidenceCommit: z.string().min(1),
  /** 验收结果引用（验收裁决标识绑定）。 */
  acceptanceVerdictIdentifier: z.string().min(1),
  createdAtIso: z.iso.datetime(),
  revision: z.number().int().min(1),
});
export type MergeBaselineBinding = z.infer<
  typeof mergeBaselineBindingSchema
>;