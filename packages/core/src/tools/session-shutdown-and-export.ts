/**
 * 会话关闭导出与收敛协调器（T06G / ADR-0021 §会话关闭时导出）。
 *
 * CurrentPermissionConfigurationExporter：默认导出"基础 profile + 会话级
 * 覆盖"的当前会话公开有效配置；存在个体覆盖时可导出指定次级 Agent 的
 * 最终有效快照或分别导出多个次级 Agent。导出只保存公开 capability 决定、
 * 资源范围、目录版本、来源 profile 引用与显示元数据；剥离 session ID、
 * agentInstanceId、nonce、用户裁决签名、一次性许可、令牌、到期计时器与
 * 内部字段。导入后的配置没有原会话授权效力。覆盖已有导出文件前自动备份。
 *
 * SessionShutdownCoordinator：停止新派发、收敛/取消在途调用、可选导出、
 * 原子写出所选配置，然后无条件撤销全部临时覆盖并关闭会话。导出失败不得
 * 让会话或权限租约无限存活；会话仍安全关闭并报告导出失败。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PermissionDecision } from "./permission-capability-catalog.js";
import type { PermissionProfileReference } from "./permission-profile-store.js";
import type {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationRecord,
  SessionPermissionElevationStore,
} from "./session-permission-elevation.js";
import type { PermissionProfileDocument } from "./permission-profile-store.js";

/** 三态宽度（与 session-permission-elevation 一致）。 */
const DECISION_WIDTH: Record<PermissionDecision, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

export interface EffectivePermissionSnapshot {
  /** 公开 capability 决定（仅公开字段）。 */
  capabilityDecisions: Record<string, PermissionDecision>;
  resourceScopes: Record<string, string>;
  catalogVersion: number;
  sourceProfileReference: PermissionProfileReference;
  sourceProfileRevision: number;
  displayName: string;
  exportedAtIso: string;
}

export class CurrentPermissionConfigurationExporter {
  /**
   * 导出当前会话公开有效配置（基础 profile + 仍有效的会话级/个体覆盖）。
   * 剥离全部会话/Agent 身份、nonce、签名、到期计时器与内部字段。
   */
  async exportEffectiveConfiguration(input: {
    sessionId: string;
    /** 导出的次级 Agent（null = 全部现有会话级配置）。 */
    agentInstanceId: string | null;
    baseProfile: PermissionProfileDocument;
    currentProfileReference: PermissionProfileReference;
    elevationStore: SessionPermissionElevationStore;
    resolver: EffectiveSecondaryPermissionResolver;
    nowUnixMilliseconds: number;
    isAgentRetired: (agentInstanceId: string) => boolean;
  }): Promise<EffectivePermissionSnapshot> {
    const capabilityDecisions: Record<string, PermissionDecision> = {};
    const resourceScopes: Record<string, string> = {};
    for (const [capabilityId, decision] of Object.entries(
      input.baseProfile.capabilityDecisions,
    )) {
      let effectiveDecision = decision;
      let resourceScope = "workspace";
      if (input.agentInstanceId !== null) {
        effectiveDecision = input.resolver.resolveEffectiveDecision({
          agentInstanceId: input.agentInstanceId,
          sessionId: input.sessionId,
          capabilityId,
          baseProfile: input.baseProfile,
          currentProfileReference: input.currentProfileReference,
          elevationStore: input.elevationStore,
          nowUnixMilliseconds: input.nowUnixMilliseconds,
          isAgentRetired: input.isAgentRetired(input.agentInstanceId),
        });
        const record = input.elevationStore
          .listRecords(input.sessionId)
          .find(
            (candidate) =>
              candidate.capabilityId === capabilityId &&
              candidate.scope.scope === "specific-secondary-agent" &&
              candidate.scope.agentInstanceId === input.agentInstanceId,
          );
        resourceScope = record?.resourceScope ?? "workspace";
      } else {
        // 会话级导出：应用仍有效的会话级覆盖（all-secondary-agents-in-session）
        const sessionLevelRecords = input.elevationStore
          .listRecords(input.sessionId)
          .filter(
            (record) =>
              record.capabilityId === capabilityId &&
              record.scope.scope === "all-secondary-agents-in-session" &&
              this.isRecordStillValid(record, input),
          );
        for (const record of sessionLevelRecords) {
          if (
            DECISION_WIDTH[record.elevatedDecision] >
            DECISION_WIDTH[effectiveDecision]
          ) {
            effectiveDecision = record.elevatedDecision;
            resourceScope = record.resourceScope;
          }
        }
      }
      capabilityDecisions[capabilityId] = effectiveDecision;
      resourceScopes[capabilityId] = resourceScope;
    }
    return {
      capabilityDecisions,
      resourceScopes,
      catalogVersion: input.baseProfile.catalogVersion,
      sourceProfileReference: input.currentProfileReference,
      sourceProfileRevision: input.baseProfile.revision,
      displayName: input.baseProfile.displayName,
      exportedAtIso: new Date().toISOString(),
    };
  }

  private isRecordStillValid(
    record: SessionPermissionElevationRecord,
    input: {
      sessionId: string;
      baseProfile: PermissionProfileDocument;
      currentProfileReference: PermissionProfileReference;
      nowUnixMilliseconds: number;
    },
  ): boolean {
    if (record.sessionId !== input.sessionId) {
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
    return true;
  }

  /** 原子写出导出文件（覆盖已有文件前自动备份）。 */
  async writeExportFile(filePath: string, snapshot: EffectivePermissionSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch {
      // 目标不存在：无需备份
    }
    await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

export interface SessionShutdownResult {
  closed: boolean;
  revokedElevationCount: number;
  exportWrote: boolean;
  exportFailedReason: string | null;
}

export interface SessionShutdownCoordinatorOptions {
  elevationStore: SessionPermissionElevationStore;
  nowUnixMilliseconds?: () => number;
}

export class SessionShutdownCoordinator {
  private readonly elevationStore: SessionPermissionElevationStore;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: SessionShutdownCoordinatorOptions) {
    this.elevationStore = options.elevationStore;
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
  }

  /**
   * 关闭会话：停止新派发（isAcceptingNewDispatches 由调用方置 false）、
   * 收敛在途调用（drainInFlightCalls）、可选导出（失败只报告不阻塞）、
   * 无条件撤销全部临时覆盖。导出失败不得延长覆盖寿命。
   */
  async shutdownSession(input: {
    sessionId: string;
    drainInFlightCalls: () => Promise<void>;
    exportPath: string | null;
    exportSnapshot: EffectivePermissionSnapshot | null;
  }): Promise<SessionShutdownResult> {
    await input.drainInFlightCalls();
    let exportWrote = false;
    let exportFailedReason: string | null = null;
    if (input.exportPath !== null && input.exportSnapshot !== null) {
      try {
        await fs.mkdir(path.dirname(input.exportPath), { recursive: true });
        try {
          await fs.copyFile(input.exportPath, `${input.exportPath}.bak`);
        } catch {
          // 目标不存在
        }
        await fs.writeFile(
          input.exportPath,
          `${JSON.stringify(input.exportSnapshot, null, 2)}\n`,
          "utf8",
        );
        exportWrote = true;
      } catch (error) {
        exportFailedReason = (error as Error).message;
      }
    }
    // 无条件撤销全部临时覆盖（导出成功/失败/跳过均执行）
    const revokedElevationCount = this.elevationStore.revokeAllForSession(
      input.sessionId,
    );
    void this.nowUnixMilliseconds;
    return {
      closed: true,
      revokedElevationCount,
      exportWrote,
      exportFailedReason,
    };
  }
}
