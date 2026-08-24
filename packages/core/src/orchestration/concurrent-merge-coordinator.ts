/**
 * 并发变更协调与受控合并协调器（T05D-05 / ADR-0028 §5）。
 *
 * - 文本/契约冲突时任命新的协调 Agent（不可复用身份，与原实现者不同）；
 *   协调失败或上下文超限 → 新身份 + 显式 handoff，不复用旧验收；
 * - 合并前校验 MergeBaselineBinding 七要素（目标分支/人工 HEAD/Agent 基线/
 *   贡献 HEAD/测试证据/验收结果）绑定同一 revision；任一变化使旧
 *   merge-ready 失效；
 * - 无静默选边：合并结果必须显式声明采用人工或协调内容，不得自动
 *   discard 人工变化。
 */
import { DomainError } from "../core/errors.js";
import { mergeBaselineBindingSchema } from "./human-agent-concurrent-change-schemas.js";
import type { z } from "zod";

/** 协调 Agent 身份生成端口（不可复用）。 */
export interface ReconcileAgentIdentityPort {
  generateReconcileAgentInstanceId(conflictIdentifier: string): string;
}

export interface ReconcileAgentAppointment {
  conflictIdentifier: string;
  reconcileAgentInstanceId: string;
  /** 与原实现者不同（原实现者不能单独宣布解决）。 */
  originalImplementerAgentInstanceId: string;
  /** 失败/超限时的显式 handoff 引用（无失败为 null）。 */
  handoffReference: string | null;
  createdAtIso: string;
}

export interface ConcurrentMergeCoordinatorOptions {
  reconcileAgentIdentityPort: ReconcileAgentIdentityPort;
}

export interface EvaluateControlledMergeInput {
  binding: z.input<typeof mergeBaselineBindingSchema>;
  /** 当前实际状态（与 binding 比对）。 */
  currentState: {
    targetBranchHeadCommit: string;
    humanHeadCommit: string;
    agentBaseCommit: string;
    contributionHeadCommit: string;
    testEvidenceCommit: string;
    acceptanceVerdictIdentifier: string;
  };
  /** 显式声明采用内容（无静默选边）：人工内容 / 协调 Agent 内容。 */
  contentResolution: {
    adoptedSource: "human-content" | "reconcile-agent-content";
    reconcileAgentInstanceId: string | null;
  };
}

export type ControlledMergeEvaluation =
  | { isMergeReady: true; adoptedSource: "human-content" | "reconcile-agent-content" }
  | { isMergeReady: false; blockedReasons: string[] };

export class ConcurrentMergeCoordinator {
  private readonly reconcileAgentIdentityPort: ReconcileAgentIdentityPort;
  private readonly reconcileAppointmentsById = new Map<
    string,
    ReconcileAgentAppointment
  >();

  constructor(options: ConcurrentMergeCoordinatorOptions) {
    this.reconcileAgentIdentityPort = options.reconcileAgentIdentityPort;
  }

  /**
   * 任命协调 Agent：新身份不可复用、与原实现者不同；
   * 协调失败/超限时以新身份 + 显式 handoff 重新任命（不复用旧协调身份）。
   */
  appointReconcileAgent(input: {
    conflictIdentifier: string;
    originalImplementerAgentInstanceId: string;
    /** 前一次协调失败（需要新身份 + handoff）。 */
    previousAppointmentFailed: boolean;
  }): ReconcileAgentAppointment {
    const existing = this.reconcileAppointmentsById.get(input.conflictIdentifier);
    if (
      input.previousAppointmentFailed &&
      existing !== undefined &&
      existing.handoffReference === null
    ) {
      // 旧任命无 handoff（未标记失败）：以新身份 + handoff 重新任命
      const retryAppointment: ReconcileAgentAppointment = {
        conflictIdentifier: input.conflictIdentifier,
        reconcileAgentInstanceId:
          this.reconcileAgentIdentityPort.generateReconcileAgentInstanceId(
            input.conflictIdentifier,
          ),
        originalImplementerAgentInstanceId:
          input.originalImplementerAgentInstanceId,
        handoffReference: `handoff-from-${existing.reconcileAgentInstanceId}`,
        createdAtIso: new Date().toISOString(),
      };
      if (
        retryAppointment.reconcileAgentInstanceId ===
        input.originalImplementerAgentInstanceId
      ) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "协调 Agent 不能与原实现者是同一身份（原实现者不能单独宣布解决）",
        );
      }
      this.reconcileAppointmentsById.set(
        input.conflictIdentifier,
        retryAppointment,
      );
      return retryAppointment;
    }
    const reconcileAgentInstanceId =
      this.reconcileAgentIdentityPort.generateReconcileAgentInstanceId(
        input.conflictIdentifier,
      );
    if (
      reconcileAgentInstanceId === input.originalImplementerAgentInstanceId
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "协调 Agent 不能与原实现者是同一身份（原实现者不能单独宣布解决）",
      );
    }
    const appointment: ReconcileAgentAppointment = {
      conflictIdentifier: input.conflictIdentifier,
      reconcileAgentInstanceId,
      originalImplementerAgentInstanceId:
        input.originalImplementerAgentInstanceId,
      handoffReference: null,
      createdAtIso: new Date().toISOString(),
    };
    this.reconcileAppointmentsById.set(input.conflictIdentifier, appointment);
    return appointment;
  }

  getReconcileAppointment(
    conflictIdentifier: string,
  ): ReconcileAgentAppointment | null {
    return this.reconcileAppointmentsById.get(conflictIdentifier) ?? null;
  }

  /**
   * 评估受控合并：绑定七要素与当前状态一致，且内容来源显式声明
   * （无静默选边）。任一变化 → 旧 merge-ready 失效。
   */
  async evaluateControlledMerge(
    input: EvaluateControlledMergeInput,
  ): Promise<ControlledMergeEvaluation> {
    const parsedBinding = mergeBaselineBindingSchema.safeParse(input.binding);
    if (!parsedBinding.success) {
      throw new DomainError(
        "invalid-task-chain",
        `合并基线绑定非法: ${parsedBinding.error.message}`,
      );
    }
    const binding = parsedBinding.data;
    const blockedReasons: string[] = [];
    const current = input.currentState;
    if (binding.targetBranchHeadCommit !== current.targetBranchHeadCommit) {
      blockedReasons.push("目标分支 HEAD 变化");
    }
    if (binding.humanHeadCommit !== current.humanHeadCommit) {
      blockedReasons.push("人工 HEAD 变化");
    }
    if (binding.agentBaseCommit !== current.agentBaseCommit) {
      blockedReasons.push("Agent 基线变化");
    }
    if (binding.contributionHeadCommit !== current.contributionHeadCommit) {
      blockedReasons.push("贡献 HEAD 变化");
    }
    if (binding.testEvidenceCommit !== current.testEvidenceCommit) {
      blockedReasons.push("测试证据提交变化");
    }
    if (
      binding.acceptanceVerdictIdentifier !==
      current.acceptanceVerdictIdentifier
    ) {
      blockedReasons.push("验收结果变化");
    }
    if (
      input.contentResolution.adoptedSource === "reconcile-agent-content" &&
      input.contentResolution.reconcileAgentInstanceId === null
    ) {
      blockedReasons.push("声明采用协调内容但未指定协调 Agent（来源不可追溯）");
    }
    if (blockedReasons.length > 0) {
      return { isMergeReady: false, blockedReasons };
    }
    return {
      isMergeReady: true,
      adoptedSource: input.contentResolution.adoptedSource,
    };
  }
}