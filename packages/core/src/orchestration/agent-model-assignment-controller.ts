/**
 * Agent 模型分配与安全检查点切换控制器（T07C-03 / ADR-0026 §2/§6）。
 *
 * - 每个具体 Agent 拥有独立 AgentModelAssignment，不按角色共享可变状态；
 * - 切换只发生在安全检查点：无未决工具调用、无未确认副作用、无并行
 *   Provider 请求；
 * - 用户固定模型（fixed 且锁定）时 Agent 不能自行切换；
 * - 切换不改变 agentInstanceId、任务所有权、记忆域、工具子集、权限、
 *   Git 职责或优先级；
 * - 每次切换生成 AGENT_MODEL_SWITCH_V1（具体 Agent/任务/旧新公开模型
 *   ID/原因/策略 revision/上下文指纹/时间；不含凭据或完整 prompt）；
 * - 同一任务失败切换使用有界预算与退避，防止 Provider 间活锁。
 */
import { z } from "zod";

import { DomainError } from "../core/errors.js";

/** 模型切换事件 schema 版本（T07C-03 冻结）。 */
export const AGENT_MODEL_SWITCH_EVENT_SCHEMA_VERSION = 1;

/** AGENT_MODEL_SWITCH_V1 事件（公开字段；不含凭据/完整 prompt）。 */
export const agentModelSwitchEventSchema = z.object({
  schemaVersion: z.literal(AGENT_MODEL_SWITCH_EVENT_SCHEMA_VERSION),
  eventId: z.string().min(1),
  /** 具体 Agent（不可复用实例 ID）。 */
  agentInstanceId: z.string().min(1),
  /** 绑定任务标识（切换发生时的任务）。 */
  boundTaskIdentifier: z.string().min(1),
  /** 旧/新模型公开 ID（仅公开稳定 ID）。 */
  previousModelProfileId: z.string().min(1),
  nextModelProfileId: z.string().min(1),
  /** 切换原因（如限流/能力不匹配/Provider 故障/用户固定）。 */
  switchReason: z.string().min(1),
  /** 策略 revision（切换时有效）。 */
  policyRevision: z.number().int().min(1),
  /** 上下文指纹（公开哈希；不含上下文内容）。 */
  contextFingerprint: z.string().min(1),
  createdAtIso: z.iso.datetime(),
});
export type AgentModelSwitchEvent = z.infer<typeof agentModelSwitchEventSchema>;

export interface AgentModelAssignment {
  agentInstanceId: string;
  currentModelProfileId: string;
  /** 用户固定模型时锁定（Agent 不能自行切换）。 */
  isUserFixedLocked: boolean;
  /** 分配策略 revision。 */
  policyRevision: number;
  /** 当前任务失败切换已用次数（有界预算）。 */
  failedSwitchCountForCurrentTask: number;
  updatedAtIso: string;
}

export interface AgentModelAssignmentControllerOptions {
  /** 同任务失败切换预算（超出后阻塞而非活锁）。 */
  maxFailedSwitchesPerTask?: number;
  /** 切换事件发送端口（装配方经独立反馈进程发送）。 */
  sendSwitchEvent?: (event: AgentModelSwitchEvent) => Promise<void>;
}

export interface SwitchCheckpointState {
  hasPendingToolCall: boolean;
  hasUnconfirmedSideEffect: boolean;
  hasParallelProviderRequest: boolean;
}

export class AgentModelAssignmentController {
  private readonly assignmentsById = new Map<string, AgentModelAssignment>();
  private readonly maxFailedSwitchesPerTask: number;
  private readonly sendSwitchEvent: ((event: AgentModelSwitchEvent) => Promise<void>) | null;
  private eventCounter = 0;

  constructor(options: AgentModelAssignmentControllerOptions = {}) {
    this.maxFailedSwitchesPerTask = options.maxFailedSwitchesPerTask ?? 3;
    this.sendSwitchEvent = options.sendSwitchEvent ?? null;
  }

  /** 登记/更新某 Agent 的分配（不改变其他 Agent 状态）。 */
  async assignModel(input: {
    agentInstanceId: string;
    modelProfileId: string;
    isUserFixedLocked: boolean;
    policyRevision: number;
  }): Promise<AgentModelAssignment> {
    const existing = this.assignmentsById.get(input.agentInstanceId);
    const assignment: AgentModelAssignment = {
      agentInstanceId: input.agentInstanceId,
      currentModelProfileId: input.modelProfileId,
      isUserFixedLocked: input.isUserFixedLocked,
      policyRevision: input.policyRevision,
      failedSwitchCountForCurrentTask: existing?.failedSwitchCountForCurrentTask ?? 0,
      updatedAtIso: new Date().toISOString(),
    };
    this.assignmentsById.set(input.agentInstanceId, assignment);
    return assignment;
  }

  /** 读取某 Agent 分配（不存在返回 null）。 */
  getAssignment(agentInstanceId: string): AgentModelAssignment | null {
    return this.assignmentsById.get(agentInstanceId) ?? null;
  }

  /**
   * 安全检查点切换：
   * 1) 分配必须存在；2) 用户固定锁定时拒绝（Agent 不能自行切换）；
   * 3) 未决工具调用/未确认副作用/并行 Provider 请求时拒绝；
   * 4) 失败切换预算未耗尽；5) 生成 AGENT_MODEL_SWITCH_V1 事件；
   * 6) 更新分配（只影响该 Agent）。
   */
  async switchModelAtCheckpoint(input: {
    agentInstanceId: string;
    boundTaskIdentifier: string;
    nextModelProfileId: string;
    switchReason: string;
    policyRevision: number;
    contextFingerprint: string;
    checkpointState: SwitchCheckpointState;
    /** 上次切换是否失败（失败计入有界预算）。 */
    previousSwitchFailed: boolean;
  }): Promise<AgentModelSwitchEvent> {
    const assignment = this.assignmentsById.get(input.agentInstanceId);
    if (assignment === undefined) {
      throw new DomainError(
        "dependency-not-found",
        `Agent 模型分配不存在: ${input.agentInstanceId}`,
      );
    }
    if (assignment.isUserFixedLocked) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `用户固定模型（锁定），Agent 不能自行切换: ${input.agentInstanceId}`,
      );
    }
    if (
      input.checkpointState.hasPendingToolCall ||
      input.checkpointState.hasUnconfirmedSideEffect ||
      input.checkpointState.hasParallelProviderRequest
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "存在未决工具调用/未确认副作用/并行 Provider 请求，拒绝在安全检查点外切换",
      );
    }
    if (input.previousSwitchFailed) {
      const nextFailedCount = assignment.failedSwitchCountForCurrentTask + 1;
      if (nextFailedCount > this.maxFailedSwitchesPerTask) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `同任务失败切换次数已达预算 ${this.maxFailedSwitchesPerTask}，阻塞（避免 Provider 间活锁）`,
        );
      }
    }
    const event: AgentModelSwitchEvent = {
      schemaVersion: AGENT_MODEL_SWITCH_EVENT_SCHEMA_VERSION,
      eventId: `agent-model-switch-${++this.eventCounter}`,
      agentInstanceId: input.agentInstanceId,
      boundTaskIdentifier: input.boundTaskIdentifier,
      previousModelProfileId: assignment.currentModelProfileId,
      nextModelProfileId: input.nextModelProfileId,
      switchReason: input.switchReason,
      policyRevision: input.policyRevision,
      contextFingerprint: input.contextFingerprint,
      createdAtIso: new Date().toISOString(),
    };
    if (this.sendSwitchEvent !== null) {
      await this.sendSwitchEvent(event);
    }
    this.assignmentsById.set(input.agentInstanceId, {
      ...assignment,
      currentModelProfileId: input.nextModelProfileId,
      policyRevision: input.policyRevision,
      failedSwitchCountForCurrentTask: input.previousSwitchFailed
        ? assignment.failedSwitchCountForCurrentTask + 1
        : 0,
      updatedAtIso: new Date().toISOString(),
    });
    return event;
  }

  /** 任务完成/重启后重置失败切换预算（有界预算按任务计）。 */
  resetFailedSwitchBudget(agentInstanceId: string): void {
    const assignment = this.assignmentsById.get(agentInstanceId);
    if (assignment === undefined) {
      return;
    }
    this.assignmentsById.set(agentInstanceId, {
      ...assignment,
      failedSwitchCountForCurrentTask: 0,
    });
  }
}