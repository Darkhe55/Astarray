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
import path from "node:path";

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
  /** B6R-06：持久化目录（<base>/session-elevations/<sessionId>.json；缺省纯内存）。 */
  baseDirectory?: string;
}

export class SessionPermissionElevationStore {
  private readonly records: SessionPermissionElevationRecord[] = [];
  private readonly nowUnixMilliseconds: () => number;
  private readonly baseDirectory: string | null;

  constructor(options: SessionPermissionElevationStoreOptions = {}) {
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
    this.baseDirectory = options.baseDirectory ?? null;
  }

  private async loadRecords(sessionId: string): Promise<void> {
    if (this.baseDirectory === null) {
      return;
    }
    const { readFile } = await import("node:fs/promises");
    const filePath = this.sessionFilePath(sessionId);
    try {
      const rawContent = await readFile(filePath, "utf8");
      const parsed = JSON.parse(rawContent) as SessionPermissionElevationRecord[];
      this.records.length = 0;
      this.records.push(...parsed.filter((record) => record.sessionId === sessionId));
    } catch {
      this.records.length = 0;
    }
  }

  private async persistRecords(): Promise<void> {
    if (this.baseDirectory === null) {
      return;
    }
    const { writeFile, readdir, rm, mkdir } = await import("node:fs/promises");
    await mkdir(this.elevationsRootDirectory, { recursive: true });
    const sessionIds = new Set(this.records.map((record) => record.sessionId));
    try {
      const existingFiles = await readdir(this.elevationsRootDirectory);
      for (const fileName of existingFiles.filter((name) => name.endsWith(".json"))) {
        const sessionId = fileName.slice(0, -".json".length);
        if (!sessionIds.has(sessionId)) {
          await rm(path.join(this.elevationsRootDirectory, fileName), { force: true });
        }
      }
    } catch {
      // 目录不存在
    }
    for (const sessionId of sessionIds) {
      const records = this.records.filter(
        (record) => record.sessionId === sessionId,
      );
      if (records.length === 0) {
        continue;
      }
      const filePath = this.sessionFilePath(sessionId);
      await writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    }
  }

  private get elevationsRootDirectory(): string {
    return path.join(this.baseDirectory ?? ".", "session-elevations");
  }

  private sessionFilePath(sessionId: string): string {
    return path.join(
      this.elevationsRootDirectory,
      `${sanitizeElevationSessionId(sessionId)}.json`,
    );
  }

  async listRecords(sessionId: string): Promise<SessionPermissionElevationRecord[]> {
    await this.loadRecords(sessionId);
    return this.records.filter((record) => record.sessionId === sessionId);
  }

  async listAllRecords(): Promise<SessionPermissionElevationRecord[]> {
    if (this.baseDirectory !== null) {
      const { readdir, readFile } = await import("node:fs/promises");
      try {
        const files = await readdir(this.elevationsRootDirectory);
        const allRecords: SessionPermissionElevationRecord[] = [];
        for (const fileName of files.filter((name) => name.endsWith(".json"))) {
          try {
            const rawContent = await readFile(
              path.join(this.elevationsRootDirectory, fileName),
              "utf8",
            );
            allRecords.push(
              ...(JSON.parse(rawContent) as SessionPermissionElevationRecord[]),
            );
          } catch {
            // 忽略损坏文件（防御）
          }
        }
        return allRecords;
      } catch {
        return [...this.records];
      }
    }
    return [...this.records];
  }

  async addRecord(record: SessionPermissionElevationRecord): Promise<void> {
    await this.loadRecords(record.sessionId);
    this.records.push(record);
    await this.persistRecords();
  }

  async revokeRecord(elevationId: string, sessionId: string): Promise<boolean> {
    await this.loadRecords(sessionId);
    const index = this.records.findIndex(
      (record) =>
        record.elevationId === elevationId && record.sessionId === sessionId,
    );
    if (index === -1) {
      return false;
    }
    this.records.splice(index, 1);
    await this.persistRecords();
    return true;
  }

  async revokeAllForSession(sessionId: string): Promise<number> {
    await this.loadRecords(sessionId);
    const before = this.records.filter(
      (record) => record.sessionId === sessionId,
    ).length;
    const remaining = this.records.filter(
      (record) => record.sessionId !== sessionId,
    );
    this.records.length = 0;
    this.records.push(...remaining);
    await this.persistRecords();
    return before;
  }

  /** 具体次级 Agent 回收时额外撤销其个体覆盖。 */
  async revokeIndividualRecordsForAgent(agentInstanceId: string): Promise<number> {
    const allRecords =
      this.baseDirectory !== null ? await this.listAllRecords() : this.records;
    const affectedSessionIds = new Set(
      allRecords
        .filter(
          (record) =>
            record.scope.scope === "specific-secondary-agent" &&
            record.scope.agentInstanceId === agentInstanceId,
        )
        .map((record) => record.sessionId),
    );
    let revoked = 0;
    for (const sessionId of affectedSessionIds) {
      await this.loadRecords(sessionId);
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
      revoked += before - remaining.length;
      await this.persistRecords();
    }
    return revoked;
  }

  getNowUnixMilliseconds(): number {
    return this.nowUnixMilliseconds();
  }
}

function sanitizeElevationSessionId(sessionId: string): string {
  let encoded = "";
  for (const character of sessionId) {
    if (/[A-Za-z0-9._-]/.test(character)) {
      encoded += character;
    } else {
      encoded += `~${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
  return encoded;
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
  async resolveEffectiveDecision(input: {
    agentInstanceId: string;
    sessionId: string;
    capabilityId: string;
    baseProfile: PermissionProfileDocument;
    currentProfileReference: PermissionProfileReference;
    elevationStore: SessionPermissionElevationStore;
    nowUnixMilliseconds: number;
    /** 具体次级 Agent 是否已回收（回收后个体覆盖失效）。 */
    isAgentRetired: boolean;
    /** B6R-05：当前会话权限 revision（记录快照不匹配则失效）。 */
    currentSessionPermissionRevision: number;
    /** B6R-05：请求的规范化资源身份（记录资源范围不匹配则失效）。 */
    requestedResourceScope: string;
  }): Promise<PermissionDecision> {
    const baseDecision =
      input.baseProfile.capabilityDecisions[input.capabilityId] ??
      input.baseProfile.fallbackDecision;
    const sessionRecords = await input.elevationStore.listRecords(input.sessionId);
    const applicableRecords = sessionRecords
      .filter((record) => {
        if (record.capabilityId !== input.capabilityId) {
          return false;
        }
        // B6R-05：会话权限 revision 快照不匹配 → 旧提升失效
        if (record.sessionPermissionRevision !== input.currentSessionPermissionRevision) {
          return false;
        }
        // B6R-05：资源范围不匹配 → 提升不应用
        if (record.resourceScope !== input.requestedResourceScope) {
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
  async createElevation(
    input: CreateElevationInput,
  ): Promise<SessionPermissionElevationRecord> {
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
    await this.store.addRecord(record);
    return record;
  }

  /** 认证用户撤销提升（返回是否撤销成功）。 */
  async revokeElevation(input: {
    sessionId: string;
    elevationId: string;
  }): Promise<boolean> {
    return this.store.revokeRecord(input.elevationId, input.sessionId);
  }

  /** 撤销会话全部提升（会话关闭时）。 */
  async revokeAllForSession(sessionId: string): Promise<number> {
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
 * B6R-05：三态/资源范围/期限逐项求交（属性测试证明 tertiary <= secondary）。
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

  /** 资源范围求交：三级请求范围 ⊆ 次级允许范围。 */
  computeDelegatedResourceScope(input: {
    secondaryAllowedResourceScopes: string[];
    requestedResourceScopes: string[];
  }): string[] {
    const secondarySet = new Set(input.secondaryAllowedResourceScopes);
    return input.requestedResourceScopes.filter((scope) => secondarySet.has(scope));
  }

  /** 期限求交：三级请求期限不得晚于次级有效期限（取更早）。 */
  computeDelegatedExpiry(input: {
    secondaryExpiresAtIso: string;
    requestedExpiresAtIso: string;
  }): string {
    const secondaryTime = new Date(input.secondaryExpiresAtIso).getTime();
    const requestedTime = new Date(input.requestedExpiresAtIso).getTime();
    return secondaryTime <= requestedTime
      ? input.secondaryExpiresAtIso
      : input.requestedExpiresAtIso;
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
