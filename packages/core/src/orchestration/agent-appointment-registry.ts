/**
 * 实现/测试/验收任命注册表（T08C-05 / ADR-0025 §4）。
 *
 * 次级 Agent 为代码任务任命具体三级 Agent：实现、测试、验收。
 * 作者不能自验；高风险任务三者必须使用三个不同 agentInstanceId；
 * 低风险任务可由用户策略允许测试与验收由同一个非实现 Agent 承担。
 */
import { DomainError } from "../core/errors.js";

export type AppointmentRiskLevel = "high" | "low";

export interface AgentAppointment {
  appointmentId: string;
  /** 绑定任务标识与 revision（变化即失效）。 */
  boundTaskIdentifier: string;
  boundTaskRevision: number;
  /** 任命方（具体次级 Agent）。 */
  appointingSecondaryAgentInstanceId: string;
  riskLevel: AppointmentRiskLevel;
  implementationAgentInstanceId: string;
  testingAgentInstanceId: string;
  acceptanceAgentInstanceId: string;
  /** 低风险时是否允许测试/验收同人（用户策略；高风险强制 false）。 */
  allowsSharedTestAndAcceptance: boolean;
  createdAtIso: string;
}

export interface AgentAppointmentRegistryOptions {
  /** 用户策略：允许低风险任务测试与验收同人（默认 false=必须三身份独立）。 */
  allowsSharedTestAndAcceptanceByDefault?: boolean;
}

export class AgentAppointmentRegistry {
  private readonly appointmentsById = new Map<string, AgentAppointment>();
  private readonly allowsSharedTestAndAcceptanceByDefault: boolean;

  constructor(options: AgentAppointmentRegistryOptions = {}) {
    this.allowsSharedTestAndAcceptanceByDefault =
      options.allowsSharedTestAndAcceptanceByDefault ?? false;
  }

  /**
   * 创建任命：校验身份隔离。
   * - 实现者不得担任测试或验收（作者自验被拒）；
   * - 高风险任务必须三个身份互异；
   * - 低风险任务仅在用户策略允许时测试/验收可同人（仍不得为实现者）。
   */
  createAppointment(input: {
    appointmentId: string;
    boundTaskIdentifier: string;
    boundTaskRevision: number;
    appointingSecondaryAgentInstanceId: string;
    riskLevel: AppointmentRiskLevel;
    implementationAgentInstanceId: string;
    testingAgentInstanceId: string;
    acceptanceAgentInstanceId: string;
    allowsSharedTestAndAcceptance?: boolean;
  }): AgentAppointment {
    const { implementationAgentInstanceId, testingAgentInstanceId, acceptanceAgentInstanceId } =
      input;
    const isSameAsImplementer =
      implementationAgentInstanceId === testingAgentInstanceId ||
      implementationAgentInstanceId === acceptanceAgentInstanceId;
    if (isSameAsImplementer) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `实现者不能验收自己的产出（作者自验被拒）: ${implementationAgentInstanceId}`,
      );
    }
    const allowsSharedTestAndAcceptance =
      input.allowsSharedTestAndAcceptance ??
      this.allowsSharedTestAndAcceptanceByDefault;
    const isHighRisk = input.riskLevel === "high";
    const testAndAcceptanceShareIdentity =
      testingAgentInstanceId === acceptanceAgentInstanceId;
    if (isHighRisk && testAndAcceptanceShareIdentity) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `高风险任务实现/测试/验收必须使用三个不同 Agent 身份`,
      );
    }
    if (testAndAcceptanceShareIdentity && !allowsSharedTestAndAcceptance) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `测试与验收同人未获用户策略允许（低风险且策略允许时才可合并）`,
      );
    }
    const appointment: AgentAppointment = {
      appointmentId: input.appointmentId,
      boundTaskIdentifier: input.boundTaskIdentifier,
      boundTaskRevision: input.boundTaskRevision,
      appointingSecondaryAgentInstanceId: input.appointingSecondaryAgentInstanceId,
      riskLevel: input.riskLevel,
      implementationAgentInstanceId,
      testingAgentInstanceId,
      acceptanceAgentInstanceId,
      allowsSharedTestAndAcceptance,
      createdAtIso: new Date().toISOString(),
    };
    this.appointmentsById.set(input.appointmentId, appointment);
    return appointment;
  }

  getAppointment(appointmentId: string): AgentAppointment | null {
    return this.appointmentsById.get(appointmentId) ?? null;
  }

  /** 校验某 Agent 是否被任命为该任务的验收者（拒绝实现者/测试者冒充验收）。 */
  assertIsAppointedAcceptor(input: {
    appointmentId: string;
    agentInstanceId: string;
  }): void {
    const appointment = this.appointmentsById.get(input.appointmentId);
    if (appointment === undefined) {
      throw new DomainError(
        "dependency-not-found",
        `任命不存在: ${input.appointmentId}`,
      );
    }
    if (appointment.acceptanceAgentInstanceId !== input.agentInstanceId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `Agent ${input.agentInstanceId} 未被任命为 ${input.appointmentId} 的验收者`,
      );
    }
  }
}