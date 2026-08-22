/**
 * 工匠披露控制器（T08D-03 / ADR-0027 §1/§5）。
 *
 * 会话开始时不创建工匠 Agent、不注入工匠说明；阶段规则命中后，
 * 经独立反馈进程向目标具体次级发送 CRAFTSMAN_PRESET_AVAILABLE_V1。
 * 冷却期内不重复披露；每阶段策略提醒次数有上限；幂等披露键防
 * 恢复/并发/重放通知风暴；披露只达目标次级（同级不继承）。
 */
import { DomainError } from "../core/errors.js";
import {
  CRAFTSMAN_PRESET_ID,
  craftsmanPresetAvailableEventSchema,
  craftsmanStageTriggerProfileSchema,
} from "./craftsman-schemas.js";
import type {
  CraftsmanStageSignal,
  CraftsmanStageTriggerProfile,
} from "./craftsman-schemas.js";
import type { CraftsmanStageController } from "./craftsman-stage-controller.js";
import type { CraftsmanDisclosureStore } from "./craftsman-disclosure-store.js";
import type { z } from "zod";

/** 披露事件发送端口（装配方经独立反馈进程发送；转发保留来源）。 */
export interface CraftsmanDisclosureSendPort {
  sendDisclosureEvent(
    event: z.infer<typeof craftsmanPresetAvailableEventSchema>,
  ): Promise<void>;
}

export interface CraftsmanDisclosureControllerOptions {
  stageController: CraftsmanStageController;
  disclosureStore: CraftsmanDisclosureStore;
  sendPort: CraftsmanDisclosureSendPort;
  /** 当前项目/会话标识（事件中记录）。 */
  projectOrSessionIdentifier: string;
  /** 结构化原始来源（转发保留；默认本地阶段控制器）。 */
  source: string;
}

export interface EvaluateAndDiscloseInput {
  profile: z.input<typeof craftsmanStageTriggerProfileSchema>;
  signal: CraftsmanStageSignal;
  /** 评估时刻（毫秒；冷却判定用）。 */
  nowUnixMilliseconds: number;
}

export type DisclosureOutcome =
  | { outcome: "disclosed"; targetSecondaryAgentInstanceId: string; eventId: string }
  | { outcome: "no-stage-hit"; reason: string }
  | { outcome: "in-cooldown"; reason: string }
  | { outcome: "reminder-limit-reached"; reason: string }
  | { outcome: "duplicate-disclosure"; reason: string };

export class CraftsmanDisclosureController {
  private readonly stageController: CraftsmanStageController;
  private readonly disclosureStore: CraftsmanDisclosureStore;
  private readonly sendPort: CraftsmanDisclosureSendPort;
  private readonly projectOrSessionIdentifier: string;
  private readonly source: string;

  constructor(options: CraftsmanDisclosureControllerOptions) {
    this.stageController = options.stageController;
    this.disclosureStore = options.disclosureStore;
    this.sendPort = options.sendPort;
    this.projectOrSessionIdentifier = options.projectOrSessionIdentifier;
    this.source = options.source;
  }

  /**
   * 评估阶段信号并按 profile 规则披露：
   * 1) 阶段判定（无命中 → 不披露）；
   * 2) 冷却检查；
   * 3) 提醒次数上限；
   * 4) 幂等键去重（崩溃恢复/并发重放）；
   * 5) 只向目标次级发送 CRAFTSMAN_PRESET_AVAILABLE_V1。
   */
  async evaluateAndDisclose(
    input: EvaluateAndDiscloseInput,
  ): Promise<DisclosureOutcome> {
    const evaluation = this.stageController.evaluateStage(input);
    if (!evaluation.isHit) {
      return { outcome: "no-stage-hit", reason: evaluation.hitSignalSummary };
    }
    // profile 已由 stageController 校验；读取规范化 profile 用于后续字段
    const parsedProfile = craftsmanStageTriggerProfileSchema.safeParse(input.profile);
    if (!parsedProfile.success) {
      throw new DomainError(
        "invalid-task-chain",
        `阶段触发 profile 非法: ${parsedProfile.error.message}`,
      );
    }
    const profile = parsedProfile.data;
    const targetSecondaryAgentInstanceIds =
      profile.targetSecondaryScope === "all-secondary-agents-in-session"
        ? null // 装配方决定会话内全部次级；本控制器按 profile 范围执行
        : profile.targetSecondaryScope.agentInstanceIds;

    const nowIso = new Date(input.nowUnixMilliseconds).toISOString();
    // 幂等键绑定评估分钟窗：同窗崩溃/并发重放去重；跨窗冷却后允许再次披露
    const evaluationMinuteWindow = Math.floor(input.nowUnixMilliseconds / 60_000);
    const idempotencyKey = [
      profile.profileId,
      profile.revision,
      evaluation.rulesVersion,
      evaluationMinuteWindow,
      evaluation.hitSignalSummary,
    ].join("|");

    const results: DisclosureOutcome[] = [];
    if (targetSecondaryAgentInstanceIds !== null) {
      for (const agentInstanceId of targetSecondaryAgentInstanceIds) {
        results.push(
          await this.discloseToTarget({
            profile,
            evaluationHitSummary: evaluation.hitSignalSummary,
            targetSecondaryAgentInstanceId: agentInstanceId,
            idempotencyKey,
            nowIso,
            nowUnixMilliseconds: input.nowUnixMilliseconds,
          }),
        );
      }
      const firstDisclosed = results.find((result) => result.outcome === "disclosed");
      if (firstDisclosed !== undefined) {
        return firstDisclosed;
      }
      return results[0] ?? { outcome: "no-stage-hit", reason: "无目标次级" };
    }
    return {
      outcome: "in-cooldown",
      reason: "all-secondary-agents-in-session 范围需装配方枚举次级后逐目标披露",
    };
  }

  private async discloseToTarget(input: {
    profile: CraftsmanStageTriggerProfile;
    evaluationHitSummary: string;
    targetSecondaryAgentInstanceId: string;
    idempotencyKey: string;
    nowIso: string;
    nowUnixMilliseconds: number;
  }): Promise<DisclosureOutcome> {
    // 幂等去重优先（并发/崩溃重放同键直接去重，不因冷却误报）
    if (
      await this.disclosureStore.hasIdempotencyKey({
        stageProfileId: input.profile.profileId,
        targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
        idempotencyKey: input.idempotencyKey,
      })
    ) {
      return { outcome: "duplicate-disclosure", reason: "幂等键已存在（重放/并发）" };
    }
    const existing = await this.disclosureStore.readState({
      stageProfileId: input.profile.profileId,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
    });
    // 冷却检查（无历史披露不冷却）
    if (existing?.lastDisclosedAtIso !== null && existing?.lastDisclosedAtIso !== undefined) {
      const lastDisclosedMilliseconds = new Date(
        existing.lastDisclosedAtIso,
      ).getTime();
      const elapsedMinutes =
        (input.nowUnixMilliseconds - lastDisclosedMilliseconds) / 60_000;
      if (elapsedMinutes < input.profile.cooldownDurationMinutes) {
        return {
          outcome: "in-cooldown",
          reason: `冷却中（距上次披露 ${Math.floor(elapsedMinutes)} 分钟 < ${input.profile.cooldownDurationMinutes} 分钟）`,
        };
      }
    }
    // 提醒次数上限
    if (
      existing !== null &&
      existing.reminderCount >= input.profile.maxDisclosureRemindersPerStage
    ) {
      return {
        outcome: "reminder-limit-reached",
        reason: `提醒次数已达上限 ${input.profile.maxDisclosureRemindersPerStage}`,
      };
    }
    const eventId = `craftsman-event-${input.idempotencyKey.split("|").join("-").slice(0, 60)}-${Date.now()}`;
    const event = {
      schemaVersion: 1,
      eventId,
      presetId: CRAFTSMAN_PRESET_ID,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
      projectOrSessionIdentifier: this.projectOrSessionIdentifier,
      stageProfileId: input.profile.profileId,
      stageProfileRevision: input.profile.revision,
      hitSignalSummary: input.evaluationHitSummary,
      disclosureAction: input.profile.disclosureAction,
      promptTemplateReference: input.profile.secondaryArrangementPromptTemplate,
      idempotencyKey: input.idempotencyKey,
      source: this.source,
      createdAtIso: input.nowIso,
    };
    const parsedEvent = craftsmanPresetAvailableEventSchema.safeParse(event);
    if (!parsedEvent.success) {
      throw new DomainError(
        "invalid-task-chain",
        `披露事件非法: ${parsedEvent.error.message}`,
      );
    }
    await this.sendPort.sendDisclosureEvent(parsedEvent.data);
    await this.disclosureStore.recordDisclosure({
      stageProfileId: input.profile.profileId,
      stageProfileRevision: input.profile.revision,
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
      idempotencyKey: input.idempotencyKey,
      nowIso: input.nowIso,
    });
    return {
      outcome: "disclosed",
      targetSecondaryAgentInstanceId: input.targetSecondaryAgentInstanceId,
      eventId,
    };
  }
}