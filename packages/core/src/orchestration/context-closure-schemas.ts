/**
 * 全局决策提升与局部上下文关闭契约（T09A-01 / ADR-0031）。
 *
 * - GLOBAL_DECISION_RECORD_V1：跨任务全局决策（状态机、来源、哈希、替代）；
 * - GlobalContextBudgetPolicy：模型可见全局上下文 token 硬预算设置（默认 4096）；
 * - GLOBAL_CONTEXT_DEFERRED_FRAGMENT_V1：按 Agent/任务隔离的延后上下文文件；
 * - LOCAL_CONTEXT_GRAPH_V1：具体 Agent 独占的局部上下文偏序图（节点/边/关闭状态）；
 * - CONTEXT_CLOSURE_CAPSULE_V1：关闭节点不可变胶囊；
 * - DEFERRED_HUMAN_VERIFICATION_TASK_V1：延迟人工核验补充任务；
 * - ASTARRAY_CONTEXT_RECALL_REQUEST_V1：模型只读回访请求（身份由 harness 注入，
 *   本 schema 不含 agentInstanceId 字段；.strict() 拒绝多余键）。
 *
 * 本模块只冻结契约与版本；存储、闭包、选择器、缓存与界面接线在后续检查点实现。
 */
import { z } from "zod";

export const GLOBAL_DECISION_RECORD_SCHEMA_VERSION = 1;
export const GLOBAL_CONTEXT_DEFERRED_FRAGMENT_SCHEMA_VERSION = 1;
export const LOCAL_CONTEXT_GRAPH_SCHEMA_VERSION = 1;
export const CONTEXT_CLOSURE_CAPSULE_SCHEMA_VERSION = 1;
export const DEFERRED_HUMAN_VERIFICATION_TASK_SCHEMA_VERSION = 1;
export const CONTEXT_RECALL_REQUEST_SCHEMA_VERSION = 1;
export const GLOBAL_CONTEXT_BUDGET_POLICY_SCHEMA_VERSION = 1;

/** 默认模型可见全局上下文上限（认证用户可调，0 = 保留决策库但关闭自动注入）。 */
export const DEFAULT_MAXIMUM_GLOBAL_CONTEXT_TOKEN_COUNT = 4096;

export const GLOBAL_DECISION_STATUSES = [
  "active",
  "pending-human-review",
  "disputed",
  "stale",
  "superseded",
] as const;
export type GlobalDecisionStatus =
  (typeof GLOBAL_DECISION_STATUSES)[number];

export const CONTEXT_EDGE_TYPES = [
  "required",
  "optional",
  "reference",
  "supersedes",
  "waived",
] as const;
export type ContextEdgeType = (typeof CONTEXT_EDGE_TYPES)[number];

export const CONTEXT_NODE_STATES = [
  "active",
  "completion-claimed",
  "locally-verified",
  "awaiting-user-acceptance",
  "accepted-closed",
  "deferred-review-closed",
  "reopened",
  "superseded",
] as const;
export type ContextNodeState = (typeof CONTEXT_NODE_STATES)[number];

export const HUMAN_VERIFICATION_CONTINUATION_POLICIES = [
  "block-until-verified",
  "continue-with-deferred-review",
] as const;
export type HumanVerificationContinuationPolicy =
  (typeof HUMAN_VERIFICATION_CONTINUATION_POLICIES)[number];

export const CONTEXT_RECALL_REASON_CODES = [
  "user-new-requirement",
  "dependency-real-change",
  "human-rejection",
  "global-decision-missing",
  "capsule-insufficient",
  "model-repeat-request",
] as const;
export type ContextRecallReasonCode =
  (typeof CONTEXT_RECALL_REASON_CODES)[number];

const sha256FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const agentSourceSchema = z
  .object({
    sourceType: z.literal("agent"),
    agentInstanceId: z.string().min(1),
  })
  .strict();
const userSourceSchema = z
  .object({
    sourceType: z.literal("user"),
    userId: z.string().min(1).optional(),
  })
  .strict();
export const contextInformationSourceSchema = z.discriminatedUnion(
  "sourceType",
  [agentSourceSchema, userSourceSchema],
);

export const globalDecisionRecordSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_DECISION_RECORD_SCHEMA_VERSION),
    globalDecisionIdentifier: z.string().min(1),
    globalContextRevision: z.number().int().positive(),
    decisionSummary: z.string().min(1),
    keyRationale: z.string().min(1),
    rejectedAlternatives: z
      .array(
        z
          .object({
            proposal: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    appliesToScope: z.string().min(1),
    relatedContextNodeIdentifiers: z.array(z.string().min(1)).default([]),
    artifactOrCommitReferences: z.array(z.string().min(1)).default([]),
    informationSource: contextInformationSourceSchema,
    sourceRevision: z.number().int().positive(),
    contentHash: sha256FingerprintSchema,
    createdAtIso: z.iso.datetime(),
    status: z.enum(GLOBAL_DECISION_STATUSES),
    invalidationCondition: z.string().optional(),
    supersedesGlobalDecisionIdentifier: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.supersedesGlobalDecisionIdentifier === undefined ||
      record.supersedesGlobalDecisionIdentifier !==
        record.globalDecisionIdentifier,
    { message: "记录不能替代自身", path: ["supersedesGlobalDecisionIdentifier"] },
  );
export type GlobalDecisionRecord = z.infer<
  typeof globalDecisionRecordSchema
>;

export const globalContextBudgetPolicySchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_CONTEXT_BUDGET_POLICY_SCHEMA_VERSION),
    /** 非负整数；0 表示保留决策库但本轮不自动注入全局记录。 */
    configuredMaximumGlobalContextTokenCount: z.number().int().nonnegative(),
    /** 单调策略 revision（设置变化从下一轮 prompt 装配生效）。 */
    globalContextBudgetPolicyRevision: z.number().int().positive(),
    updatedByUserId: z.string().min(1),
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type GlobalContextBudgetPolicy = z.infer<
  typeof globalContextBudgetPolicySchema
>;

export const deferredGlobalContextFragmentSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_CONTEXT_DEFERRED_FRAGMENT_SCHEMA_VERSION),
    fragmentIdentifier: z.string().min(1),
    ownerAgentInstanceId: z.string().min(1),
    missionId: z.string().min(1),
    sourceContextNodeIdentifier: z.string().min(1),
    sourceNodeRevision: z.number().int().positive(),
    contentHash: sha256FingerprintSchema,
    topics: z.array(z.string().min(1)).default([]),
    explicitRelationKeys: z.array(z.string().min(1)).default([]),
    estimatedTokenCount: z.number().int().nonnegative(),
    invalidationCondition: z.string().optional(),
    createdAtIso: z.iso.datetime(),
  })
  .strict();
export type DeferredGlobalContextFragment = z.infer<
  typeof deferredGlobalContextFragmentSchema
>;

export const localContextGraphNodeSchema = z
  .object({
    contextNodeIdentifier: z.string().min(1),
    agentInstanceId: z.string().min(1),
    missionId: z.string().min(1),
    state: z.enum(CONTEXT_NODE_STATES),
    /** 未关闭的 required 直接子节点计数（增量传播用）。 */
    openRequiredChildCount: z.number().int().nonnegative(),
    contentFingerprint: sha256FingerprintSchema,
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type LocalContextGraphNode = z.infer<typeof localContextGraphNodeSchema>;

export const localContextGraphEdgeSchema = z
  .object({
    edgeIdentifier: z.string().min(1),
    fromContextNodeIdentifier: z.string().min(1),
    toContextNodeIdentifier: z.string().min(1),
    edgeType: z.enum(CONTEXT_EDGE_TYPES),
    /** waived 边必须带认证用户豁免（绑定 revision，陈旧签字不可复用）。 */
    waiver: z
      .object({
        userId: z.string().min(1),
        contextGraphRevision: z.number().int().positive(),
        waivedAtIso: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((edge) => edge.edgeType === "waived" ? edge.waiver !== undefined : true, {
    message: "waived 边必须携带认证用户豁免",
    path: ["waiver"],
  });

export const localContextGraphSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_CONTEXT_GRAPH_SCHEMA_VERSION),
    graphIdentifier: z.string().min(1),
    ownerAgentInstanceId: z.string().min(1),
    missionId: z.string().min(1),
    revision: z.number().int().positive(),
    nodes: z.array(localContextGraphNodeSchema).default([]),
    edges: z.array(localContextGraphEdgeSchema).default([]),
    updatedAtIso: z.iso.datetime(),
  })
  .strict()
  .refine(
    (graph) =>
      graph.nodes.every(
        (node) => node.agentInstanceId === graph.ownerAgentInstanceId,
      ),
    { message: "跨 Agent 直接所有权被拒绝：节点属主必须等于图属主", path: ["nodes"] },
  )
  .refine(
    (graph) => {
      const nodeIdentifiers = new Set(
        graph.nodes.map((node) => node.contextNodeIdentifier),
      );
      return graph.edges.every(
        (edge) =>
          nodeIdentifiers.has(edge.fromContextNodeIdentifier) &&
          nodeIdentifiers.has(edge.toContextNodeIdentifier) &&
          edge.fromContextNodeIdentifier !== edge.toContextNodeIdentifier,
      );
    },
    { message: "边必须引用图中存在的两个不同节点（未知锚点/自环拒绝）", path: ["edges"] },
  );
export type LocalContextGraph = z.infer<typeof localContextGraphSchema>;

export const contextClosureCapsuleSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_CLOSURE_CAPSULE_SCHEMA_VERSION),
    capsuleIdentifier: z.string().min(1),
    contextNodeIdentifier: z.string().min(1),
    agentInstanceId: z.string().min(1),
    missionId: z.string().min(1),
    contextGraphRevision: z.number().int().positive(),
    finalDecisionSummary: z.string().min(1),
    promotedGlobalDecisionIdentifiers: z
      .array(z.string().min(1))
      .default([]),
    inputSummary: z.string().min(1),
    outputSummary: z.string().min(1),
    verificationState: z.enum([
      "awaiting-user-acceptance",
      "accepted-closed",
      "deferred-review-closed",
    ]),
    artifactOrCommitReferences: z.array(z.string().min(1)).default([]),
    testEvidenceReferences: z.array(z.string().min(1)).default([]),
    informationSource: contextInformationSourceSchema,
    contentHash: sha256FingerprintSchema,
    unresolvedItems: z.array(z.string().min(1)).default([]),
    reopenCondition: z.string().min(1),
    createdAtIso: z.iso.datetime(),
  })
  .strict();
export type ContextClosureCapsule = z.infer<
  typeof contextClosureCapsuleSchema
>;

export const deferredHumanVerificationTaskSchema = z
  .object({
    schemaVersion: z.literal(DEFERRED_HUMAN_VERIFICATION_TASK_SCHEMA_VERSION),
    taskIdentifier: z.string().min(1),
    contextNodeIdentifier: z.string().min(1),
    contextGraphRevision: z.number().int().positive(),
    closureCapsuleHash: sha256FingerprintSchema,
    artifactOrCommitReferences: z.array(z.string().min(1)).default([]),
    automaticTestReferences: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    humanSteps: z.string().min(1),
    /** 来源由本地控制面生成（system/tool）；优先级层级 1 或以下。 */
    priorityTier: z.literal(1).or(z.number().int().max(1)),
    createdAtIso: z.iso.datetime(),
  })
  .strict();
export type DeferredHumanVerificationTask = z.infer<
  typeof deferredHumanVerificationTaskSchema
>;

export const contextRecallRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_RECALL_REQUEST_SCHEMA_VERSION),
    requestId: z.string().min(1),
    taskExecutionId: z.string().min(1),
    contextNodeIdentifier: z.string().min(1),
    nodeRevision: z.number().int().positive(),
    reasonCode: z.enum(CONTEXT_RECALL_REASON_CODES),
    requiredInformation: z.string().min(1),
    maximumTokenCount: z.number().int().positive(),
  })
  .strict();
export type ContextRecallRequest = z.infer<typeof contextRecallRequestSchema>;

/** 人工验收推进策略设置（Assist/Devolve 默认值见 ADR-0031）。 */
export const humanVerificationPolicySchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_CONTEXT_BUDGET_POLICY_SCHEMA_VERSION),
    policy: z.enum(HUMAN_VERIFICATION_CONTINUATION_POLICIES),
    humanVerificationPolicyRevision: z.number().int().positive(),
    updatedByUserId: z.string().min(1),
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type HumanVerificationPolicySetting = z.infer<
  typeof humanVerificationPolicySchema
>;
