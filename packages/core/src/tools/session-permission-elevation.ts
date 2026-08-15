/**
 * 会话临时提升与次级权限上限（T06G / ADR-0021）。
 *
 * SessionPermissionElevationStore：保存会话级/个体级提升记录，绑定会话、
 * 作用域、可选具体次级 Agent、capability、资源范围、基础 profile
 * ID/revision、目录版本、会话权限 revision、原/新决定、创建/到期时间与
 * 用户裁决引用。提升不修改基础 profile，也不使用普通 Assist 会话授权。
 *
 * EffectiveSecondaryPermissionResolver：基础 profile + 会话级覆盖 +
 * 个体覆盖计算当前有效权限；会话关闭、到期、撤销、profile/revision/目录
 * 变化时覆盖失效；具体 Agent 回收额外撤销个体覆盖。
 *
 * TertiaryPermissionDelegationGuard：次级 Agent 分发三级 Agent 时逐项求交，
 * 三态宽度 deny < ask < allow；三级最终权限不得宽于次级有效权限。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";
import type {
  PermissionProfileDocument,
  PermissionProfileReference,
} from "./permission-profile-store.js";

export type ElevationScope =
  | { scope: "all-secondary-agents-in-session" }
  | { scope: "specific-secondary-agent"; agentInstanceId: string };

export interface SessionPermissionElevationRecord {
  elevationId: string;
  sessionId: string;
  scope: ElevationScope;
  capabilityId: string;
  resourceScope: string;
  baseProfileReference: PermissionProfileReference;
  baseProfileRevision: number;
  catalogVersion: number;
  originalDecision: PermissionDecision;
  elevatedDecision: PermissionDecision;
  createdAtIso: string;
  expiresAtIso: string | null;
  userDecisionReference: string;
  /** 会话权限 revision（创建该提升时的值）。 */
  sessionPermissionRevision: number;
}

export interface SessionPermissionElevationStoreOptions {
  nowUnixMilliseconds?: () => number;
}

export class SessionPermissionElevationStore {
  private readonly records: SessionPermissionElevationRecord[] = [];
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: SessionPermissionElevationStoreOptions = {}) {
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
  }

  listRecords(sessionId: string): SessionPermissionElevationRecord[] {
    return this.records.filter((record) => record.sessionId === sessionId);
  }

  listAllRecords(): SessionPermissionElevationRecord[] {
    return [...this.records];
  }

  addRecord(record: SessionPermissionElevationRecord): void {
    this.records.push(record);
  }

  revokeRecord(elevationId: string, sessionId: string): boolean {
    const index = this.records.findIndex(
      (record) =>
        record.elevationId === elevationId && record.sessionId === sessionId,
    );
    if (index === -1) {
      return false;
    }
    this.records.splice(index, 1);
    return true;
  }

  revokeAllForSession(sessionId: string): number {
    const before = this.records.length;
    const remaining = this.records.filter(
      (record) => record.sessionId !== sessionId,
    );
    this.records.length = 0;
    this.records.push(...remaining);
    return before - remaining.length;
  }

  /** 具体次级 Agent 回收时额外撤销其个体覆盖。 */
  revokeIndividualRecordsForAgent(agentInstanceId: string): number {
    const before = this.records.length;
    const remaining = this.records.filter(
      (record) =>
        !(
          record.scope.scope === "specific-secondary-agent" &&
          record.scope.agentInstanceId === agentInstanceId
        ),
    );
    this.records.length = 0;
    this.records.push(...remaining);
    return before - remaining.length;
  }

  getNowUnixMilliseconds(): number {
    return this.nowUnixMilliseconds();
  }
}

/** 三态宽度排序：deny(0) < ask(1) < allow(2)。 */
const DECISION_WIDTH: Record<PermissionDecision, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

/** 取更严格（更窄）决定。 */
function narrowerDecision(
  left: PermissionDecision,
  right: PermissionDecision,
): PermissionDecision {
  return DECISION_WIDTH[left] <= DECISION_WIDTH[right] ? left : right;
}

export class EffectiveSecondaryPermissionResolver {
  /**
   * 计算次级 Agent 当前有效决定：基础 profile 决定 + 仍有效的会话/个体覆盖。
   * 覆盖失效条件：到期、profile/revision/目录版本变化。
   */
  resolveEffectiveDecision(input: {
    agentInstanceId: string;
    sessionId: string;
    capabilityId: string;
    baseProfile: PermissionProfileDocument;
    currentProfileReference: PermissionProfileReference;
    elevationStore: SessionPermissionElevationStore;
    nowUnixMilliseconds: number;
    /** 具体次级 Agent 是否已回收（回收后个体覆盖失效）。 */
    isAgentRetired: boolean;
  }): PermissionDecision {
    const baseDecision =
      input.baseProfile.capabilityDecisions[input.capabilityId] ??
      input.baseProfile.fallbackDecision;
    const applicableRecords = input.elevationStore
      .listRecords(input.sessionId)
      .filter((record) => {
        if (record.capabilityId !== input.capabilityId) {
          return false;
        }
        if (record.baseProfileReference.kind !== input.currentProfileReference.kind) {
          return false;
        }
        if (record.baseProfileReference.kind === "custom") {
          if (
            input.currentProfileReference.kind !== "custom" ||
            record.baseProfileReference.profileId !==
              input.currentProfileReference.profileId
          ) {
            return false;
          }
        }
        if (
          record.baseProfileRevision !== input.baseProfile.revision ||
          record.catalogVersion !== input.baseProfile.catalogVersion
        ) {
          return false;
        }
        if (
          record.expiresAtIso !== null &&
          new Date(record.expiresAtIso).getTime() <= input.nowUnixMilliseconds
        ) {
          return false;
        }
        if (record.scope.scope === "specific-secondary-agent") {
          if (input.isAgentRetired) {
            return false;
          }
          return record.scope.agentInstanceId === input.agentInstanceId;
        }
        return true; // 会话级覆盖应用于全部现有及后续次级 Agent
      });
    if (applicableRecords.length === 0) {
      return baseDecision;
    }
    let effectiveDecision = baseDecision;
    for (const record of applicableRecords) {
      if (DECISION_WIDTH[record.elevatedDecision] > DECISION_WIDTH[effectiveDecision]) {
        effectiveDecision = record.elevatedDecision;
      }
    }
    return effectiveDecision;
  }
}

export interface CreateElevationInput {
  sessionId: string;
  scope: ElevationScope;
  capabilityId: string;
  resourceScope: string;
  baseProfileReference: PermissionProfileReference;
  baseProfileRevision: number;
  catalogVersion: number;
  originalDecision: PermissionDecision;
  elevatedDecision: PermissionDecision;
  expiresAtIso: string | null;
  userDecisionReference: string;
  sessionPermissionRevision: number;
}

export class SessionPermissionElevationController {
  constructor(private readonly store: SessionPermissionElevationStore) {}

  /**
   * 认证用户创建临时提升（默认会话级覆盖全部次级 Agent）。
   * 校验：提升方向必须更宽（deny→ask/allow、ask→allow）；
   * 创建后递增会话权限 revision（使未执行调用重新鉴权）。
   */
  createElevation(
    input: CreateElevationInput,
  ): SessionPermissionElevationRecord {
    if (
      DECISION_WIDTH[input.elevatedDecision] <=
      DECISION_WIDTH[input.originalDecision]
    ) {
      throw new DomainError(
        "invalid-task-chain",
        `提升方向必须更宽: ${input.originalDecision} → ${input.elevatedDecision}`,
      );
    }
    const record: SessionPermissionElevationRecord = {
      elevationId: `elevation-${randomUUID()}`,
      sessionId: input.sessionId,
      scope: input.scope,
      capabilityId: input.capabilityId,
      resourceScope: input.resourceScope,
      baseProfileReference: input.baseProfileReference,
      baseProfileRevision: input.baseProfileRevision,
      catalogVersion: input.catalogVersion,
      originalDecision: input.originalDecision,
      elevatedDecision: input.elevatedDecision,
      createdAtIso: new Date().toISOString(),
      expiresAtIso: input.expiresAtIso,
      userDecisionReference: input.userDecisionReference,
      sessionPermissionRevision: input.sessionPermissionRevision,
    };
    this.store.addRecord(record);
    return record;
  }

  /** 认证用户撤销提升（返回是否撤销成功）。 */
  revokeElevation(input: {
    sessionId: string;
    elevationId: string;
  }): boolean {
    return this.store.revokeRecord(input.elevationId, input.sessionId);
  }

  /** 撤销会话全部提升（会话关闭时）。 */
  revokeAllForSession(sessionId: string): number {
    return this.store.revokeAllForSession(sessionId);
  }
}

export interface TertiaryDelegationInput {
  secondaryEffectiveDecision: PermissionDecision;
  requestedDelegatedDecision: PermissionDecision;
}

/**
 * 三级权限分发守卫：三级最终权限不得宽于次级有效权限。
 * 求交规则：narrower(secondary, requested)。
 */
export class TertiaryPermissionDelegationGuard {
  /** 返回三级实际允许的决定（求交后）。 */
  computeDelegatedDecision(
    input: TertiaryDelegationInput,
  ): PermissionDecision {
    return narrowerDecision(
      input.secondaryEffectiveDecision,
      input.requestedDelegatedDecision,
    );
  }

  /** 校验请求的分发决定是否在次级上限内（超出即拒绝分发）。 */
  assertDelegationAllowed(input: TertiaryDelegationInput): void {
    if (
      DECISION_WIDTH[input.requestedDelegatedDecision] >
      DECISION_WIDTH[input.secondaryEffectiveDecision]
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `三级分发决定 ${input.requestedDelegatedDecision} 宽于次级有效决定 ${input.secondaryEffectiveDecision}，拒绝`,
      );
    }
  }
}
