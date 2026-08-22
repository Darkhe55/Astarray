/**
 * 工匠阶段控制器（T08D-02 / ADR-0027 §3/§4）。
 *
 * 阶段信号由本地确定性控制器计算：只读公开元数据/计数器/任务终态/
 * 显式里程碑事件，不让模型判断阶段。支持内置较早/均衡/保守模板与
 * 用户自定义 any/all 规则。时钟回拨防护：活跃时长等信号由装配方按
 * 单调规则累计，本控制器只接受非负信号（schema 层已拒绝负值）。
 */
import { DomainError } from "../core/errors.js";
import {
  craftsmanStageSignalSchema,
  craftsmanStageTriggerProfileSchema,
} from "./craftsman-schemas.js";
import type {
  BuiltinCraftsmanStageStrategy,
  CraftsmanStageSignal,
  CraftsmanStageTriggerProfile,
  CraftsmanStageTriggerRule,
} from "./craftsman-schemas.js";
import type { z } from "zod";

/** 标准里程碑标识（本地版本化规则生成；冻结）。 */
export const CRAFTSMAN_MILESTONE_IDENTIFIERS = {
  architectureFreezeAccepted: "architecture-freeze-accepted",
  baselineAccepted: "baseline-accepted",
  firstIntegrationAccepted: "first-integration-accepted",
  stabilizationAccepted: "stabilization-accepted",
} as const;

const KIB = 1024;
const MIB = 1024 * 1024;

export interface StageEvaluationResult {
  isHit: boolean;
  /** 命中的规则描述摘要（审计/披露事件用）。 */
  hitSignalSummary: string;
  profileId: string;
  profileRevision: number;
  rulesVersion: number;
}

/** 本地阶段规则版本（冻结决策；变更需重新评估）。 */
export const CRAFTSMAN_STAGE_RULES_VERSION = 1;

/**
 * 工匠阶段控制器：内置模板构建 + 确定性 any/all 判定。
 */
export class CraftsmanStageController {
  /** 构建内置阶段模板（early/balanced/conservative）。 */
  buildBuiltinProfile(
    strategy: BuiltinCraftsmanStageStrategy,
  ): CraftsmanStageTriggerProfile {
    const nowIso = new Date().toISOString();
    switch (strategy) {
      case "early":
        return {
          schemaVersion: 1,
          profileId: "craftsman-stage-early",
          displayName: "较早",
          originKind: "builtin",
          builtinStrategy: "early",
          combinationMode: "any",
          rules: [
            {
              signalKind: "active-session-duration-minutes",
              thresholdValue: 30,
              milestoneSubset: [],
            },
            {
              signalKind: "accepted-milestone-identifiers",
              thresholdValue: null,
              milestoneSubset: [CRAFTSMAN_MILESTONE_IDENTIFIERS.firstIntegrationAccepted],
            },
            {
              signalKind: "project-memory-index-entry-count",
              thresholdValue: 64,
              milestoneSubset: [],
            },
            {
              signalKind: "project-memory-indexed-bytes",
              thresholdValue: 512 * KIB,
              milestoneSubset: [],
            },
            {
              signalKind: "repeated-workflow-fingerprint-count",
              thresholdValue: 2,
              milestoneSubset: [],
            },
          ],
          cooldownDurationMinutes: 30,
          maxDisclosureRemindersPerStage: 3,
          targetSecondaryScope: "all-secondary-agents-in-session",
          disclosureAction: "suggest-only",
          secondaryArrangementPromptTemplate: null,
          revision: 1,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
      case "balanced":
        return {
          schemaVersion: 1,
          profileId: "craftsman-stage-balanced",
          displayName: "均衡",
          originKind: "builtin",
          builtinStrategy: "balanced",
          combinationMode: "any",
          rules: [
            {
              signalKind: "active-session-duration-minutes",
              thresholdValue: 90,
              milestoneSubset: [],
            },
            {
              signalKind: "accepted-task-chain-count",
              thresholdValue: 3,
              milestoneSubset: [],
            },
            {
              signalKind: "project-memory-index-entry-count",
              thresholdValue: 256,
              milestoneSubset: [],
            },
            {
              signalKind: "project-memory-indexed-bytes",
              thresholdValue: 2 * MIB,
              milestoneSubset: [],
            },
            {
              signalKind: "repeated-workflow-fingerprint-count",
              thresholdValue: 3,
              milestoneSubset: [],
            },
          ],
          cooldownDurationMinutes: 60,
          maxDisclosureRemindersPerStage: 3,
          targetSecondaryScope: "all-secondary-agents-in-session",
          disclosureAction: "suggest-only",
          secondaryArrangementPromptTemplate: null,
          revision: 1,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
      case "conservative":
        return {
          schemaVersion: 1,
          profileId: "craftsman-stage-conservative",
          displayName: "保守",
          originKind: "builtin",
          builtinStrategy: "conservative",
          combinationMode: "any",
          rules: [
            {
              signalKind: "active-session-duration-minutes",
              thresholdValue: 180,
              milestoneSubset: [],
            },
            {
              signalKind: "accepted-task-chain-count",
              thresholdValue: 8,
              milestoneSubset: [],
            },
            {
              signalKind: "accepted-milestone-identifiers",
              thresholdValue: null,
              milestoneSubset: [CRAFTSMAN_MILESTONE_IDENTIFIERS.stabilizationAccepted],
            },
            {
              signalKind: "project-memory-index-entry-count",
              thresholdValue: 1024,
              milestoneSubset: [],
            },
            {
              signalKind: "project-memory-indexed-bytes",
              thresholdValue: 8 * MIB,
              milestoneSubset: [],
            },
            {
              signalKind: "repeated-workflow-fingerprint-count",
              thresholdValue: 5,
              milestoneSubset: [],
            },
          ],
          cooldownDurationMinutes: 120,
          maxDisclosureRemindersPerStage: 2,
          targetSecondaryScope: "all-secondary-agents-in-session",
          disclosureAction: "suggest-only",
          secondaryArrangementPromptTemplate: null,
          revision: 1,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
    }
  }

  /**
   * 评估阶段信号是否命中 profile 规则。
   * any = 任一规则命中；all = 全部规则命中。纯确定性判定。
   */
  evaluateStage(input: {
    profile: z.input<typeof craftsmanStageTriggerProfileSchema>;
    signal: z.input<typeof craftsmanStageSignalSchema>;
  }): StageEvaluationResult {
    const parsedProfile = craftsmanStageTriggerProfileSchema.safeParse(
      input.profile,
    );
    if (!parsedProfile.success) {
      throw new DomainError(
        "invalid-task-chain",
        `阶段触发 profile 非法: ${parsedProfile.error.message}`,
      );
    }
    const parsedSignal = craftsmanStageSignalSchema.safeParse(input.signal);
    if (!parsedSignal.success) {
      throw new DomainError(
        "invalid-task-chain",
        `阶段信号非法: ${parsedSignal.error.message}`,
      );
    }
    const profile = parsedProfile.data;
    const signal = parsedSignal.data;

    const hitSummaries: string[] = [];
    for (const rule of profile.rules) {
      if (this.isRuleHit(rule, signal)) {
        hitSummaries.push(this.describeRuleHit(rule, signal));
      }
    }
    const isHit =
      profile.combinationMode === "all"
        ? hitSummaries.length === profile.rules.length
        : hitSummaries.length > 0;
    return {
      isHit,
      hitSignalSummary:
        hitSummaries.length > 0 ? hitSummaries.join("；") : "无信号命中",
      profileId: profile.profileId,
      profileRevision: profile.revision,
      rulesVersion: CRAFTSMAN_STAGE_RULES_VERSION,
    };
  }

  /** 单条规则是否命中（本地确定性判定；不依赖模型）。 */
  private isRuleHit(
    rule: CraftsmanStageTriggerRule,
    signal: CraftsmanStageSignal,
  ): boolean {
    switch (rule.signalKind) {
      case "active-session-duration-minutes":
        return signal.activeSessionDurationMinutes >= (rule.thresholdValue ?? 0);
      case "accepted-task-chain-count":
        return signal.acceptedTaskChainCount >= (rule.thresholdValue ?? 0);
      case "accepted-milestone-identifiers":
        return rule.milestoneSubset.some((milestone) =>
          signal.acceptedMilestoneIdentifiers.includes(milestone),
        );
      case "project-memory-index-entry-count":
        return signal.projectMemoryIndexEntryCount >= (rule.thresholdValue ?? 0);
      case "project-memory-indexed-bytes":
        return signal.projectMemoryIndexedBytes >= (rule.thresholdValue ?? 0);
      case "repeated-workflow-fingerprint-count":
        return signal.repeatedWorkflowFingerprintCount >= (rule.thresholdValue ?? 0);
    }
  }

  /** 命中摘要（审计/披露事件用；不含内部细节）。 */
  private describeRuleHit(
    rule: CraftsmanStageTriggerRule,
    signal: CraftsmanStageSignal,
  ): string {
    switch (rule.signalKind) {
      case "active-session-duration-minutes":
        return `活跃 ${signal.activeSessionDurationMinutes} 分钟（阈值 ${rule.thresholdValue}）`;
      case "accepted-task-chain-count":
        return `验收任务链 ${signal.acceptedTaskChainCount} 条（阈值 ${rule.thresholdValue}）`;
      case "accepted-milestone-identifiers":
        return `里程碑命中: ${rule.milestoneSubset.join(",")}`;
      case "project-memory-index-entry-count":
        return `记忆索引 ${signal.projectMemoryIndexEntryCount} 条（阈值 ${rule.thresholdValue}）`;
      case "project-memory-indexed-bytes":
        return `记忆索引 ${signal.projectMemoryIndexedBytes} 字节（阈值 ${rule.thresholdValue}）`;
      case "repeated-workflow-fingerprint-count":
        return `重复工作流指纹 ${signal.repeatedWorkflowFingerprintCount} 次（阈值 ${rule.thresholdValue}）`;
    }
  }
}