/**
 * 已注册 Agent 目录（B6R-09 / ADR-0022 §报告与反馈）。
 * 报告来源认证：三级 Agent 必须先被登记（绑定 mission、所属次级、
 * 任务包），未登记来源拒绝。目录只存身份与隶属关系，不存记忆/上下文。
 */
import { DomainError } from "../core/errors.js";
import type { AgentRole } from "../core/types.js";

export interface RegisteredAgentEntry {
  agentInstanceId: string;
  agentRole: AgentRole;
  missionId: string | null;
  /** 所属次级 Agent（三级必填；二级为 null）。 */
  owningSecondaryAgentInstanceId: string | null;
  boundTaskBundleId: string | null;
  registeredAtIso: string;
}

export class RegisteredAgentDirectory {
  private readonly entriesByAgentId = new Map<string, RegisteredAgentEntry>();

  /** 登记一个具体 Agent（不可复用实例 ID；重复登记拒绝）。 */
  registerAgent(input: RegisteredAgentEntry): void {
    if (this.entriesByAgentId.has(input.agentInstanceId)) {
      throw new DomainError(
        "invalid-task-chain",
        `Agent 已登记（不可复用身份）: ${input.agentInstanceId}`,
      );
    }
    if (input.agentRole === "tertiary" && input.owningSecondaryAgentInstanceId === null) {
      throw new DomainError(
        "invalid-task-chain",
        "三级 Agent 登记必须绑定所属次级 Agent",
      );
    }
    this.entriesByAgentId.set(input.agentInstanceId, {
      ...input,
      boundTaskBundleId: input.boundTaskBundleId,
    });
  }

  /** 登记校验（Agent 与所属/mission/任务包匹配）。 */
  verifyReportSource(input: {
    reportingAgentInstanceId: string;
    missionId: string;
    taskBundleId: string;
  }): { valid: boolean; reason: string | null } {
    const entry = this.entriesByAgentId.get(input.reportingAgentInstanceId);
    if (entry === undefined) {
      return { valid: false, reason: "Agent 未登记（非空字符串不是认证）" };
    }
    if (entry.missionId !== input.missionId) {
      return {
        valid: false,
        reason: `Agent 登记 mission 与报告 mission 不匹配`,
      };
    }
    if (
      entry.boundTaskBundleId !== null &&
      entry.boundTaskBundleId !== input.taskBundleId
    ) {
      return {
        valid: false,
        reason: `Agent 绑定任务包与报告任务包不匹配`,
      };
    }
    return { valid: true, reason: null };
  }

  /** 撤销登记（Agent 回收时）。 */
  unregisterAgent(agentInstanceId: string): void {
    this.entriesByAgentId.delete(agentInstanceId);
  }
}
