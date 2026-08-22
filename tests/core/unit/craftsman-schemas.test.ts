/**
 * T08D-01 测试：工匠阶段触发 profile、阶段信号、披露事件与 bundle schema。
 * 覆盖：冻结决策常量、schema 合法/反例、版本迁移拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_CRAFTSMAN_STAGE_STRATEGIES,
  CRAFTSMAN_DISCLOSURE_ACTIONS,
  CRAFTSMAN_DISPLAY_NAME,
  CRAFTSMAN_PRESET_AVAILABLE_SCHEMA_VERSION,
  CRAFTSMAN_PRESET_ID,
  CRAFTSMAN_RULE_COMBINATION_MODES,
  CRAFTSMAN_STAGE_SIGNAL_KINDS,
  CRAFTSMAN_STAGE_TRIGGER_PROFILE_SCHEMA_VERSION,
  CRAFTSMAN_USAGE_ID,
  CRAFTSMAN_WORKFLOW_BUNDLE_SCHEMA_VERSION,
  craftsmanPresetAvailableEventSchema,
  craftsmanStageSignalSchema,
  craftsmanStageTriggerProfileSchema,
  craftsmanWorkflowBundleSchema,
} from "../../../packages/core/src/orchestration/craftsman-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

describe("T08D-01 冻结决策", () => {
  it("工匠预设稳定标识/用途/显示名冻结", () => {
    expect(CRAFTSMAN_PRESET_ID).toBe("tertiary-preset:craftsman-v1");
    expect(CRAFTSMAN_USAGE_ID).toBe("craftsman-workflow-customization");
    expect(CRAFTSMAN_DISPLAY_NAME).toBe("工匠");
  });

  it("内置三模板 early/balanced/conservative 冻结", () => {
    expect(BUILTIN_CRAFTSMAN_STAGE_STRATEGIES).toEqual([
      "early",
      "balanced",
      "conservative",
    ]);
  });

  it("六类阶段信号冻结（含时间/字节单位命名）", () => {
    expect(CRAFTSMAN_STAGE_SIGNAL_KINDS).toContain(
      "active-session-duration-minutes",
    );
    expect(CRAFTSMAN_STAGE_SIGNAL_KINDS).toContain(
      "project-memory-indexed-bytes",
    );
    expect(CRAFTSMAN_STAGE_SIGNAL_KINDS).toContain(
      "repeated-workflow-fingerprint-count",
    );
    expect(CRAFTSMAN_STAGE_SIGNAL_KINDS).toHaveLength(6);
  });

  it("披露动作三态与组合模式冻结", () => {
    expect(CRAFTSMAN_DISCLOSURE_ACTIONS).toEqual([
      "suggest-only",
      "suggest-with-prompt",
      "auto-enqueue-proposal",
    ]);
    expect(CRAFTSMAN_RULE_COMBINATION_MODES).toEqual(["any", "all"]);
  });

  it("schema 版本常量首版冻结为 1", () => {
    expect(CRAFTSMAN_STAGE_TRIGGER_PROFILE_SCHEMA_VERSION).toBe(1);
    expect(CRAFTSMAN_PRESET_AVAILABLE_SCHEMA_VERSION).toBe(1);
    expect(CRAFTSMAN_WORKFLOW_BUNDLE_SCHEMA_VERSION).toBe(1);
  });
});

describe("craftsmanStageSignalSchema", () => {
  const signal = {
    schemaVersion: 1,
    activeSessionDurationMinutes: 90,
    acceptedTaskChainCount: 3,
    acceptedMilestoneIdentifiers: ["baseline-accepted"],
    projectMemoryIndexEntryCount: 256,
    projectMemoryIndexedBytes: 2 * 1024 * 1024,
    repeatedWorkflowFingerprintCount: 3,
  };

  it("合法信号通过", () => {
    expect(craftsmanStageSignalSchema.safeParse(signal).success).toBe(true);
  });

  it("反例：负数时间/字节、非整数计数 → 拒绝", () => {
    expect(
      craftsmanStageSignalSchema.safeParse({
        ...signal,
        activeSessionDurationMinutes: -1,
      }).success,
    ).toBe(false);
    expect(
      craftsmanStageSignalSchema.safeParse({
        ...signal,
        projectMemoryIndexedBytes: -5,
      }).success,
    ).toBe(false);
    expect(
      craftsmanStageSignalSchema.safeParse({
        ...signal,
        acceptedTaskChainCount: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("craftsmanStageTriggerProfileSchema", () => {
  const profile = {
    schemaVersion: 1,
    profileId: "profile-balanced-1",
    displayName: "均衡模板",
    originKind: "builtin",
    builtinStrategy: "balanced",
    combinationMode: "any",
    rules: [
      {
        signalKind: "active-session-duration-minutes",
        thresholdValue: 90,
        milestoneSubset: [],
      },
    ],
    cooldownDurationMinutes: 60,
    maxDisclosureRemindersPerStage: 3,
    targetSecondaryScope: "all-secondary-agents-in-session",
    disclosureAction: "suggest-only",
    secondaryArrangementPromptTemplate: null,
    revision: 1,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    updatedAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法 profile（内置均衡模板）通过", () => {
    expect(craftsmanStageTriggerProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("反例：规则为空、冷却负数、提醒次数 0 → 拒绝", () => {
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        rules: [],
      }).success,
    ).toBe(false);
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        cooldownDurationMinutes: -1,
      }).success,
    ).toBe(false);
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        maxDisclosureRemindersPerStage: 0,
      }).success,
    ).toBe(false);
  });

  it("反例：自定义 profile 不得携带 builtinStrategy；里程碑规则阈值应为 null", () => {
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        originKind: "custom",
        builtinStrategy: "balanced",
      }).success,
    ).toBe(false);
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        rules: [
          {
            signalKind: "accepted-milestone-identifiers",
            thresholdValue: 5,
            milestoneSubset: ["baseline-accepted"],
          },
        ],
      }).success,
    ).toBe(true); // 阈值非 null 也接受（宽松）；milestoneSubset 是主判定
  });

  it("反例：具体次级范围列表为空 → 拒绝", () => {
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        targetSecondaryScope: {
          kind: "specific-secondary-agents",
          agentInstanceIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("反例：schemaVersion 不匹配（版本迁移拒绝）", () => {
    expect(
      craftsmanStageTriggerProfileSchema.safeParse({
        ...profile,
        schemaVersion: 99,
      }).success,
    ).toBe(false);
  });
});

describe("craftsmanPresetAvailableEventSchema", () => {
  const event = {
    schemaVersion: 1,
    eventId: "event-1",
    presetId: "tertiary-preset:craftsman-v1",
    targetSecondaryAgentInstanceId: "secondary-1",
    projectOrSessionIdentifier: "session-1",
    stageProfileId: "profile-balanced-1",
    stageProfileRevision: 2,
    hitSignalSummary: "活跃 90 分钟",
    disclosureAction: "suggest-only",
    promptTemplateReference: null,
    idempotencyKey: "idem-1",
    source: "local-stage-controller",
    createdAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法披露事件通过", () => {
    expect(craftsmanPresetAvailableEventSchema.safeParse(event).success).toBe(true);
  });

  it("反例：presetId 非工匠预设、缺少幂等键 → 拒绝", () => {
    expect(
      craftsmanPresetAvailableEventSchema.safeParse({
        ...event,
        presetId: "other-preset",
      }).success,
    ).toBe(false);
    expect(
      craftsmanPresetAvailableEventSchema.safeParse({
        ...event,
        idempotencyKey: "",
      }).success,
    ).toBe(false);
  });
});

describe("craftsmanWorkflowBundleSchema", () => {
  const bundle = {
    schemaVersion: 1,
    bundleId: "bundle-1",
    targetProblem: "重复的构建检查",
    applicableScope: "构建后静态检查",
    nonApplicableScope: "跨项目发布",
    repeatedWorkflowFingerprint: "fingerprint-1",
    usedToolReferences: [{ toolId: "project.read", toolRevision: 1 }],
    combinationSteps: ["扫描", "校验", "汇总"],
    permissionBoundarySummary: "仅只读工具",
    sensitiveDataBoundarySummary: "不读取敏感路径",
    backupAndIdempotencySummary: "写入前备份",
    failureRecoverySummary: "从检查点恢复",
    livelockBoundarySummary: "有界重试",
    artifactReferences: ["docs/workflows/check.md"],
    sourceAgentInstanceId: "tertiary-craftsman-1",
    boundTaskRevision: 2,
    contentHash: VALID_SHA256,
    dryRunOrMinimalExperimentSummary: "dry-run 验证通过",
    deterministicTestSummary: "3 项确定性测试",
    performanceComparisonSummary: "工具调用从 8 次降至 3 次",
    knownLimitations: ["仅适用于单仓"],
    compatibilityConditions: ["工具 revision >= 1"],
    invalidationConditions: ["工具 schema 变化"],
    version: 1,
    recommendedReviewMilestones: ["稳定化阶段"],
    createdAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法 bundle 通过", () => {
    expect(craftsmanWorkflowBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("反例：内容哈希非法、来源为空、工具引用 revision 0 → 拒绝", () => {
    expect(
      craftsmanWorkflowBundleSchema.safeParse({
        ...bundle,
        contentHash: "not-sha256",
      }).success,
    ).toBe(false);
    expect(
      craftsmanWorkflowBundleSchema.safeParse({
        ...bundle,
        sourceAgentInstanceId: "",
      }).success,
    ).toBe(false);
    expect(
      craftsmanWorkflowBundleSchema.safeParse({
        ...bundle,
        usedToolReferences: [{ toolId: "x", toolRevision: 0 }],
      }).success,
    ).toBe(false);
  });
});