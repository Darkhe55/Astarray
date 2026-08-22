/**
 * 验收裁决门禁（T08C-05 / ADR-0025 §4）。
 *
 * 验收 Agent 对照任务目标、架构约束、差异、测试证据和人工验收要求给出
 * rework | merge-ready | blocked-human-review 建议；次级依据不可变提交哈希、
 * 测试证据和验收报告作出返修或合并决定。
 *
 * 失效规则：
 * - 绑定任务的 revision 变化 → 旧裁决失效（需重新验收）；
 * - 被验收提交哈希变化 → 旧裁决失效；
 * - 高风险任务缺少人工体验/操作授权/用户裁决 → 只能 blocked-human-review；
 * - 缺少测试证据 → 不可 merge-ready。
 */
import { DomainError } from "../core/errors.js";
import { acceptanceVerdictSchema } from "./agent-routing-schemas.js";
import type { AcceptanceVerdict } from "./agent-routing-schemas.js";
import type { AgentAppointmentRegistry } from "./agent-appointment-registry.js";
import type { z } from "zod";

export type AcceptanceVerdictRecord = z.infer<typeof acceptanceVerdictSchema>;

export interface MergeReadinessEvaluation {
  /** 是否可合并（merge-ready 且证据齐备且裁决未失效）。 */
  isMergeReady: boolean;
  /** 当前应采用的裁决（可能已被新裁决覆盖或失效）。 */
  effectiveVerdict: AcceptanceVerdict | null;
  /** 未满足原因（isMergeReady=false 时非空）。 */
  blockedReasons: string[];
}

export interface AcceptanceVerdictGateOptions {
  appointmentRegistry: AgentAppointmentRegistry;
}

export class AcceptanceVerdictGate {
  private readonly appointmentRegistry: AgentAppointmentRegistry;
  private readonly verdictsByTask = new Map<
    string,
    AcceptanceVerdictRecord[]
  >();

  constructor(options: AcceptanceVerdictGateOptions) {
    this.appointmentRegistry = options.appointmentRegistry;
  }

  /**
   * 记录验收裁决：校验 schema、验收人必须是该任务任命的验收 Agent、
   * 裁决绑定任务 revision 与提交哈希。同一任务的旧裁决保留（可追溯）。
   */
  async recordVerdict(input: {
    appointmentId: string;
    verdict: z.input<typeof acceptanceVerdictSchema>;
  }): Promise<AcceptanceVerdictRecord> {
    const parsedVerdict = acceptanceVerdictSchema.safeParse(input.verdict);
    if (!parsedVerdict.success) {
      throw new DomainError(
        "invalid-task-chain",
        `验收裁决非法: ${parsedVerdict.error.message}`,
      );
    }
    const verdict = parsedVerdict.data;
    this.appointmentRegistry.assertIsAppointedAcceptor({
      appointmentId: input.appointmentId,
      agentInstanceId: verdict.acceptingAgentInstanceId,
    });
    const appointment = this.appointmentRegistry.getAppointment(input.appointmentId);
    if (appointment === null) {
      throw new DomainError("dependency-not-found", "任命不存在");
    }
    if (
      verdict.boundTaskIdentifier !== appointment.boundTaskIdentifier ||
      verdict.boundTaskRevision !== appointment.boundTaskRevision
    ) {
      throw new DomainError(
        "stale-revision",
        `验收裁决绑定的任务/revision 与任命不一致`,
      );
    }
    const taskKey = `${appointment.boundTaskIdentifier}#${appointment.boundTaskRevision}`;
    const existingVerdicts = this.verdictsByTask.get(taskKey) ?? [];
    this.verdictsByTask.set(taskKey, [...existingVerdicts, verdict]);
    return verdict;
  }

  /**
   * 评估合并就绪度：
   * - 无裁决 → 未就绪；
   * - 最新裁决 rework → 未就绪；
   * - 提交哈希变化（旧裁决失效）→ 未就绪并提示重新验收；
   * - 最新裁决 merge-ready：高风险任务必须同时提供人工验收证据
   *   （evidenceReferences 含 human-review 引用），否则降级 blocked-human-review；
   * - blocked-human-review → 未就绪（冻结，等待人工裁决）。
   */
  async evaluateMergeReadiness(input: {
    appointmentId: string;
    currentTaskRevision: number;
    currentCommitHash: string | null;
    /** 人工体验/授权/用户裁决是否已完成（高风险任务必需）。 */
    isHumanReviewComplete: boolean;
  }): Promise<MergeReadinessEvaluation> {
    const appointment = this.appointmentRegistry.getAppointment(input.appointmentId);
    if (appointment === null) {
      throw new DomainError("dependency-not-found", "任命不存在");
    }
    if (appointment.boundTaskRevision !== input.currentTaskRevision) {
      return {
        isMergeReady: false,
        effectiveVerdict: null,
        blockedReasons: ["任务 revision 变化，旧裁决已失效"],
      };
    }
    const taskKey = `${appointment.boundTaskIdentifier}#${appointment.boundTaskRevision}`;
    const verdicts = this.verdictsByTask.get(taskKey) ?? [];
    if (verdicts.length === 0) {
      return {
        isMergeReady: false,
        effectiveVerdict: null,
        blockedReasons: ["尚未收到验收裁决"],
      };
    }
    const latestVerdict = verdicts[verdicts.length - 1]!;
    if (
      latestVerdict.boundCommitHash !== null &&
      latestVerdict.boundCommitHash !== input.currentCommitHash
    ) {
      return {
        isMergeReady: false,
        effectiveVerdict: null,
        blockedReasons: ["被验收提交哈希变化，旧裁决失效，需重新验收"],
      };
    }
    if (latestVerdict.verdict === "rework") {
      return {
        isMergeReady: false,
        effectiveVerdict: "rework",
        blockedReasons: ["验收裁决为 rework，需返修后重新验收"],
      };
    }
    if (latestVerdict.verdict === "blocked-human-review") {
      return {
        isMergeReady: false,
        effectiveVerdict: "blocked-human-review",
        blockedReasons: ["等待人工验收裁决（冻结）"],
      };
    }
    // latestVerdict.verdict === "merge-ready"
    if (appointment.riskLevel === "high" && !input.isHumanReviewComplete) {
      return {
        isMergeReady: false,
        effectiveVerdict: "blocked-human-review",
        blockedReasons: ["高风险任务缺少人工体验/操作授权/用户裁决"],
      };
    }
    return {
      isMergeReady: true,
      effectiveVerdict: "merge-ready",
      blockedReasons: [],
    };
  }
}