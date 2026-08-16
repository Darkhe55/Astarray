/**
 * Agent 实例无配额注册表与资源准入适配（T08B / ADR-0024 §Agent 数量无产品配额）。
 * 主、次级、三级 Agent 实例均不设置累计创建数量、存档数量或同级个体数量
 * 的产品硬上限；单个会话仍只有一个当前用户沟通主 Agent。并发执行槽、
 * Provider 限流、内存、磁盘与 OS 资源可使实例排队、暂停或回收，但不得把
 * 资源调度上限解释为 Agent 数量配额，也不得因历史实例数量达到阈值拒绝创建。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { AgentRole } from "../core/types.js";

export type AgentInstanceState =
  | "created"
  | "queued"
  | "running"
  | "paused"
  | "recycled";

export interface AgentInstanceRecord {
  agentInstanceId: string;
  agentRole: AgentRole;
  missionId: string | null;
  state: AgentInstanceState;
  createdAtIso: string;
  recycledAtIso: string | null;
}

export interface ResourceAdmissionResult {
  admitted: boolean;
  state: AgentInstanceState;
  reason: string | null;
}

export interface UnboundedAgentInstanceRegistryOptions {
  /** 并发执行槽上限（资源限制，非数量配额）。 */
  maxConcurrentSlots: number;
  /** 排队上限（资源限制；超出排队上限仍不拒绝创建，只延长排队）。 */
  maxQueueLength: number;
  /** 当前并发槽占用数（测试注入）。 */
  currentOccupiedSlots?: () => number;
  /** 是否允许回收（资源告警触发受控回收；非数量拒绝）。 */
  canRecycle?: () => boolean;
}

export class UnboundedAgentInstanceRegistry {
  private readonly records = new Map<string, AgentInstanceRecord>();
  private readonly maxConcurrentSlots: number;
  private readonly maxQueueLength: number;
  private readonly currentOccupiedSlots: () => number;
  private readonly canRecycle: () => boolean;
  /** 历史实例总数（无上限；仅统计）。 */
  private historicalInstanceCount = 0;

  constructor(options: UnboundedAgentInstanceRegistryOptions) {
    this.maxConcurrentSlots = options.maxConcurrentSlots;
    this.maxQueueLength = options.maxQueueLength;
    this.currentOccupiedSlots = options.currentOccupiedSlots ?? (() => 0);
    this.canRecycle = options.canRecycle ?? (() => false);
  }

  /**
   * 创建实例：永不因历史总数拒绝；资源不足时排队或暂停。
   * 单个会话的当前用户沟通主 Agent 唯一性由调用方（单会话控制器）保证。
   */
  createInstance(input: {
    agentRole: AgentRole;
    missionId: string | null;
  }): AgentInstanceRecord {
    this.historicalInstanceCount += 1;
    const agentInstanceId = `instance-${randomUUID()}`;
    const record: AgentInstanceRecord = {
      agentInstanceId,
      agentRole: input.agentRole,
      missionId: input.missionId,
      state: "created",
      createdAtIso: new Date().toISOString(),
      recycledAtIso: null,
    };
    this.records.set(agentInstanceId, record);
    return record;
  }

  /** 资源准入：并发槽满 → 排队（队列满 → 暂停，仍不拒绝创建）。 */
  requestAdmission(agentInstanceId: string): ResourceAdmissionResult {
    const record = this.records.get(agentInstanceId);
    if (record === undefined) {
      throw new DomainError(
        "task-sequence-not-found",
        `Agent 实例不存在: ${agentInstanceId}`,
      );
    }
    if (record.state === "recycled") {
      return {
        admitted: false,
        state: "recycled",
        reason: "实例已回收，不可复用",
      };
    }
    const occupied = this.currentOccupiedSlots();
    if (occupied >= this.maxConcurrentSlots) {
      // 排队（队列有上限但只是资源等待，不构成数量拒绝）
      const queuedCount = [...this.records.values()].filter(
        (candidate) => candidate.state === "queued",
      ).length;
      if (queuedCount >= this.maxQueueLength) {
        record.state = "paused";
        return {
          admitted: false,
          state: "paused",
          reason: "并发槽与队列均满，实例暂停等待资源释放（非数量配额）",
        };
      }
      record.state = "queued";
      return {
        admitted: false,
        state: "queued",
        reason: "并发槽已满，实例排队等待（非数量配额）",
      };
    }
    record.state = "running";
    return { admitted: true, state: "running", reason: null };
  }

  /** 受控回收（资源告警触发；不因历史数量）。 */
  recycleInstance(agentInstanceId: string): void {
    const record = this.records.get(agentInstanceId);
    if (record === undefined) {
      throw new DomainError(
        "task-sequence-not-found",
        `Agent 实例不存在: ${agentInstanceId}`,
      );
    }
    if (!this.canRecycle()) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "当前不允许受控回收",
      );
    }
    record.state = "recycled";
    record.recycledAtIso = new Date().toISOString();
  }

  getState(agentInstanceId: string): AgentInstanceState | null {
    return this.records.get(agentInstanceId)?.state ?? null;
  }

  /** 历史实例总数（统计用；无上限拒绝逻辑）。 */
  getHistoricalInstanceCount(): number {
    return this.historicalInstanceCount;
  }

  getLiveInstanceCount(): number {
    return [...this.records.values()].filter(
      (record) => record.state !== "recycled",
    ).length;
  }
}
