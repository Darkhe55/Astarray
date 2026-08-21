/**
 * 次级直投控制器（T08C-02 / ADR-0025 §1）。
 *
 * 认证用户在主会话确认后，本地控制面把原始用户任务信封直投具体次级
 * Agent 的偏序集，不调用主 Agent 模型重复规划。直达消息保持认证用户
 * 来源与 priorityTier 0；只携带该任务与显式附件引用，不复制主会话。
 *
 * 资格策略建议直达；用户显式路由决定具有最高优先级，但不能绕过安装、
 * 权限、备份删除、发布等既有操作授权门禁（本控制器不提供这些门禁的
 * 豁免）。资格不符或存在方案歧义时无损回到主 Agent。
 */
import type { z } from "zod";

import { DomainError } from "../core/errors.js";
import {
  secondaryDirectTaskEnvelopeSchema,
} from "./agent-routing-schemas.js";
import type {
  SmallTaskEligibilityPolicy,
  SmallTaskEligibilityResult,
} from "./small-task-eligibility-policy.js";
import type { TaskSequenceManageController } from "./task-sequence-controllers.js";
import type { TaskSourceKind } from "../core/types.js";

/** 直投结果：已投递 / 无损回到主 Agent。 */
export type DirectDispatchOutcome =
  | { outcome: "dispatched"; targetSequenceId: string; envelopeRevision: number }
  | { outcome: "returned-to-main-agent"; reason: string };

export interface DirectDispatchControllerOptions {
  /** 认证用户标识（harness 注入）。 */
  authenticatedUserId: string;
  /** 本地版本化资格策略。 */
  eligibilityPolicy: SmallTaskEligibilityPolicy;
  /** 目标次级 Agent 偏序集控制面（投递落点）。 */
  sequenceManageController: TaskSequenceManageController;
  /** 目标次级是否存在的校验端口（本地注册表）。 */
  doesSecondaryAgentExist: (agentInstanceId: string) => boolean;
}

/** 用户显式路由决定（最高优先级，但不豁免授权门禁）。 */
export type UserRouteDecision =
  | { kind: "follow-policy-suggestion" }
  | { kind: "force-dispatch"; confirmationText: string };

export interface DispatchDirectTaskInput {
  /** 原始用户任务信封（含认证用户来源、目标次级、层级 0、附件哈希）。 */
  envelope: z.input<typeof secondaryDirectTaskEnvelopeSchema>;
  /** 用户显式路由决定。 */
  userRouteDecision: UserRouteDecision;
  /** 目标次级偏序集 revision（乐观并发）。 */
  expectedSequenceRevision: number;
  /** 资格判定特征（界面/用户确认时填写；本地策略据此判定直达与否）。 */
  eligibilityCharacteristics: {
    requiresDesignDiscussion: boolean;
    modifiesArchitectureOrPublicContract: boolean;
    hasUnresolvedHighRiskRuling: boolean;
    requiresCrossProjectCoordination: boolean;
  };
}

export class DirectDispatchController {
  private readonly authenticatedUserId: string;
  private readonly eligibilityPolicy: SmallTaskEligibilityPolicy;
  private readonly sequenceManageController: TaskSequenceManageController;
  private readonly doesSecondaryAgentExist: (
    agentInstanceId: string,
  ) => boolean;

  constructor(options: DirectDispatchControllerOptions) {
    this.authenticatedUserId = options.authenticatedUserId;
    this.eligibilityPolicy = options.eligibilityPolicy;
    this.sequenceManageController = options.sequenceManageController;
    this.doesSecondaryAgentExist = options.doesSecondaryAgentExist;
  }

  /**
   * 处理认证用户的直投请求：
   * 1) schema 校验；2) 来源必须等于认证用户；3) 目标次级必须存在；
   * 4) 资格策略判定——不直达时仅当用户显式强制才投递，否则无损回退主 Agent；
   * 5) 投递到目标次级偏序集（来源 user、层级 0）。
   * 本控制器不调用任何模型；主 Agent 不被重复规划。
   */
  async dispatchDirectTask(
    input: DispatchDirectTaskInput,
  ): Promise<DirectDispatchOutcome> {
    const parsedEnvelope = secondaryDirectTaskEnvelopeSchema.safeParse(
      input.envelope,
    );
    if (!parsedEnvelope.success) {
      throw new DomainError(
        "invalid-task-chain",
        `直投任务信封非法: ${parsedEnvelope.error.message}`,
      );
    }
    const envelope = parsedEnvelope.data;

    if (envelope.authenticatedUserId !== this.authenticatedUserId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "直投来源与认证用户不一致",
      );
    }
    if (!this.doesSecondaryAgentExist(envelope.targetSecondaryAgentInstanceId)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `目标次级 Agent 不存在: ${envelope.targetSecondaryAgentInstanceId}`,
      );
    }

    const eligibilityResult: SmallTaskEligibilityResult =
      this.eligibilityPolicy.evaluateEligibility({
        scopeDescription: envelope.scopeDescription,
        acceptanceCriteria: envelope.acceptanceCriteria,
        requiresDesignDiscussion:
          input.eligibilityCharacteristics.requiresDesignDiscussion,
        modifiesArchitectureOrPublicContract:
          input.eligibilityCharacteristics.modifiesArchitectureOrPublicContract,
        hasUnresolvedHighRiskRuling:
          input.eligibilityCharacteristics.hasUnresolvedHighRiskRuling,
        requiresCrossProjectCoordination:
          input.eligibilityCharacteristics.requiresCrossProjectCoordination,
      });

    if (!eligibilityResult.isEligible) {
      if (input.userRouteDecision.kind !== "force-dispatch") {
        return {
          outcome: "returned-to-main-agent",
          reason: eligibilityResult.ineligibilityReason ?? "不符合直投资格",
        };
      }
    }

    await this.sequenceManageController.insertTask({
      ownerAgentInstanceId: envelope.targetSecondaryAgentInstanceId,
      actor: {
        sourceKind: "user" as TaskSourceKind,
        actorId: envelope.authenticatedUserId,
      },
      sequenceId: `sequence-${envelope.targetSecondaryAgentInstanceId}`,
      expectedRevision: input.expectedSequenceRevision,
      task: {
        taskId: envelope.envelopeId,
        title: `${envelope.originalUserInstruction.slice(0, 80)}${
          envelope.acceptanceCriteria.length > 0
            ? `（验收: ${envelope.acceptanceCriteria.slice(0, 60)}）`
            : ""
        }`,
        priorityTier: envelope.priorityTier,
        externalReference: null,
      },
      anchor: envelope.anchor,
    });

    return {
      outcome: "dispatched",
      targetSequenceId: `sequence-${envelope.targetSecondaryAgentInstanceId}`,
      envelopeRevision: envelope.revision,
    };
  }
}
