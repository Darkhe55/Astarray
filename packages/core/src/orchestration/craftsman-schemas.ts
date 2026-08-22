/**
 * 工匠阶段触发 profile 与披露/bundle schema（T08D-01 / ADR-0027）。
 *
 * 覆盖：CraftsmanStageTriggerProfile（any/all 规则、信号、阈值、
 * 里程碑集合、冷却、提醒次数、目标次级范围、披露动作、提示词模板）、
 * CRAFTSMAN_PRESET_AVAILABLE_V1 披露事件与 CRAFTSMAN_WORKFLOW_BUNDLE_V1
 * 产物契约。本文件只定义 schema 与冻结常量；阶段判定逻辑由 T08D-02
 * 实现。
 */
import { z } from "zod";

/** 工匠预设稳定标识（冻结）。 */
export const CRAFTSMAN_PRESET_ID = "tertiary-preset:craftsman-v1" as const;
/** 工匠用途标识（冻结）。 */
export const CRAFTSMAN_USAGE_ID = "craftsman-workflow-customization" as const;
/** 中文显示名（冻结）。 */
export const CRAFTSMAN_DISPLAY_NAME = "工匠" as const;

/** 披露事件 schema 版本（T08D-01 冻结）。 */
export const CRAFTSMAN_PRESET_AVAILABLE_SCHEMA_VERSION = 1;
/** 工作流 bundle schema 版本（T08D-01 冻结）。 */
export const CRAFTSMAN_WORKFLOW_BUNDLE_SCHEMA_VERSION = 1;
/** 阶段触发 profile schema 版本（T08D-01 冻结）。 */
export const CRAFTSMAN_STAGE_TRIGGER_PROFILE_SCHEMA_VERSION = 1;
/** 阶段信号 schema 版本（T08D-01 冻结）。 */
export const CRAFTSMAN_STAGE_SIGNAL_SCHEMA_VERSION = 1;

/** 内置阶段策略标识（冻结；用户可编辑默认值）。 */
export const BUILTIN_CRAFTSMAN_STAGE_STRATEGIES = [
  "early",
  "balanced",
  "conservative",
] as const;
export type BuiltinCraftsmanStageStrategy =
  (typeof BUILTIN_CRAFTSMAN_STAGE_STRATEGIES)[number];

/** 阶段信号种类（ADR-0027 §3；冻结）。 */
export const CRAFTSMAN_STAGE_SIGNAL_KINDS = [
  "active-session-duration-minutes",
  "accepted-task-chain-count",
  "accepted-milestone-identifiers",
  "project-memory-index-entry-count",
  "project-memory-indexed-bytes",
  "repeated-workflow-fingerprint-count",
] as const;
export type CraftsmanStageSignalKind =
  (typeof CRAFTSMAN_STAGE_SIGNAL_KINDS)[number];

/** 披露动作三态（ADR-0027 §5；冻结）。 */
export const CRAFTSMAN_DISCLOSURE_ACTIONS = [
  "suggest-only",
  "suggest-with-prompt",
  "auto-enqueue-proposal",
] as const;
export type CraftsmanDisclosureAction =
  (typeof CRAFTSMAN_DISCLOSURE_ACTIONS)[number];

/** 规则组合模式（any = 任一命中；all = 全部命中）。 */
export const CRAFTSMAN_RULE_COMBINATION_MODES = ["any", "all"] as const;
export type CraftsmanRuleCombinationMode =
  (typeof CRAFTSMAN_RULE_COMBINATION_MODES)[number];

/** 阶段信号值（T08D-01 冻结；时间量/字节量名称带单位）。 */
export const craftsmanStageSignalSchema = z.object({
  schemaVersion: z.literal(CRAFTSMAN_STAGE_SIGNAL_SCHEMA_VERSION),
  activeSessionDurationMinutes: z.number().min(0),
  acceptedTaskChainCount: z.number().int().min(0),
  acceptedMilestoneIdentifiers: z.array(z.string().min(1)),
  projectMemoryIndexEntryCount: z.number().int().min(0),
  projectMemoryIndexedBytes: z.number().int().min(0),
  repeatedWorkflowFingerprintCount: z.number().int().min(0),
});
export type CraftsmanStageSignal = z.infer<typeof craftsmanStageSignalSchema>;

/** 单条触发规则：信号 + 阈值（含单位）。 */
export const craftsmanStageTriggerRuleSchema = z.object({
  signalKind: z.enum(CRAFTSMAN_STAGE_SIGNAL_KINDS),
  /** 数值阈值（accepted-milestone-identifiers 为子集匹配，不使用数值）。 */
  thresholdValue: z.number().min(0).nullable(),
  /** 里程碑信号专用：任一命中即满足。 */
  milestoneSubset: z.array(z.string().min(1)),
});
export type CraftsmanStageTriggerRule = z.infer<
  typeof craftsmanStageTriggerRuleSchema
>;

/** 用户可配置的阶段触发 profile（数量不设产品上限）。 */
export const craftsmanStageTriggerProfileSchema = z
  .object({
    schemaVersion: z.literal(CRAFTSMAN_STAGE_TRIGGER_PROFILE_SCHEMA_VERSION),
    /** 不可变 profile ID（与显示名分离；可辨识）。 */
    profileId: z.string().min(1),
    displayName: z.string().min(1),
    /** 内置三模板之一或 custom。 */
    originKind: z.enum(["builtin", "custom"]),
    builtinStrategy: z.enum(BUILTIN_CRAFTSMAN_STAGE_STRATEGIES).nullable(),
    combinationMode: z.enum(CRAFTSMAN_RULE_COMBINATION_MODES),
    rules: z.array(craftsmanStageTriggerRuleSchema).min(1),
    /** 冷却（单位：分钟；命中后冷却期内不重复披露）。 */
    cooldownDurationMinutes: z.number().int().min(0),
    /** 每阶段策略最大披露提醒次数。 */
    maxDisclosureRemindersPerStage: z.number().int().min(1),
    /** 目标次级范围：all 或具体次级列表（披露只达目标次级）。 */
    targetSecondaryScope: z.union([
      z.literal("all-secondary-agents-in-session"),
      z.object({
        kind: z.literal("specific-secondary-agents"),
        agentInstanceIds: z.array(z.string().min(1)).min(1),
      }),
    ]),
    disclosureAction: z.enum(CRAFTSMAN_DISCLOSURE_ACTIONS),
    /** suggest-with-prompt / auto-enqueue-proposal 使用的提示词模板。 */
    secondaryArrangementPromptTemplate: z.string().nullable(),
    revision: z.number().int().min(1),
    createdAtIso: z.iso.datetime(),
    updatedAtIso: z.iso.datetime(),
  })
  .superRefine((profile, context) => {
    if (profile.originKind === "custom" && profile.builtinStrategy !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["builtinStrategy"],
        message: "自定义 profile 不得携带 builtinStrategy",
      });
    }
  });
export type CraftsmanStageTriggerProfile = z.infer<
  typeof craftsmanStageTriggerProfileSchema
>;

/** 披露事件（CRAFTSMAN_PRESET_AVAILABLE_V1；经独立反馈进程发送）。 */
export const craftsmanPresetAvailableEventSchema = z.object({
  schemaVersion: z.literal(CRAFTSMAN_PRESET_AVAILABLE_SCHEMA_VERSION),
  eventId: z.string().min(1),
  presetId: z.literal(CRAFTSMAN_PRESET_ID),
  /** 具体接收次级 Agent（披露只达目标次级）。 */
  targetSecondaryAgentInstanceId: z.string().min(1),
  projectOrSessionIdentifier: z.string().min(1),
  stageProfileId: z.string().min(1),
  stageProfileRevision: z.number().int().min(1),
  /** 命中的信号摘要（只含公开元数据）。 */
  hitSignalSummary: z.string().min(1),
  disclosureAction: z.enum(CRAFTSMAN_DISCLOSURE_ACTIONS),
  /** 提示词模板引用（不内嵌完整提示词）。 */
  promptTemplateReference: z.string().nullable(),
  /** 幂等披露键（防重复/恢复风暴）。 */
  idempotencyKey: z.string().min(1),
  /** 结构化原始来源（转发保留）。 */
  source: z.string().min(1),
  createdAtIso: z.iso.datetime(),
});
export type CraftsmanPresetAvailableEvent = z.infer<
  typeof craftsmanPresetAvailableEventSchema
>;

/** 工匠产物契约（CRAFTSMAN_WORKFLOW_BUNDLE_V1；ADR-0027 §6）。 */
export const craftsmanWorkflowBundleSchema = z.object({
  schemaVersion: z.literal(CRAFTSMAN_WORKFLOW_BUNDLE_SCHEMA_VERSION),
  bundleId: z.string().min(1),
  targetProblem: z.string().min(1),
  applicableScope: z.string().min(1),
  nonApplicableScope: z.string().min(1),
  /** 重复工作指纹（本地规则生成，非云端语义）。 */
  repeatedWorkflowFingerprint: z.string().min(1),
  /** 使用的现有工具公开 ID/revision（不得引入新工具）。 */
  usedToolReferences: z.array(
    z.object({
      toolId: z.string().min(1),
      toolRevision: z.number().int().min(1),
    }),
  ),
  combinationSteps: z.array(z.string().min(1)),
  permissionBoundarySummary: z.string().min(1),
  sensitiveDataBoundarySummary: z.string().min(1),
  backupAndIdempotencySummary: z.string().min(1),
  failureRecoverySummary: z.string().min(1),
  livelockBoundarySummary: z.string().min(1),
  /** 产物文件/提交引用。 */
  artifactReferences: z.array(z.string().min(1)),
  /** 来源 Agent、任务 revision 与内容哈希（不可变）。 */
  sourceAgentInstanceId: z.string().min(1),
  boundTaskRevision: z.number().int().min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** dry-run/最小实验、确定性测试、性能/调用量对比与已知限制。 */
  dryRunOrMinimalExperimentSummary: z.string().min(1),
  deterministicTestSummary: z.string().min(1),
  performanceComparisonSummary: z.string().min(1),
  knownLimitations: z.array(z.string().min(1)),
  /** 兼容性条件、失效条件、版本与推荐复查里程碑。 */
  compatibilityConditions: z.array(z.string().min(1)),
  invalidationConditions: z.array(z.string().min(1)),
  version: z.number().int().min(1),
  recommendedReviewMilestones: z.array(z.string().min(1)),
  createdAtIso: z.iso.datetime(),
});
export type CraftsmanWorkflowBundle = z.infer<
  typeof craftsmanWorkflowBundleSchema
>;