/**
 * 上下文分层缓存与精确失效（T09A-06 / ADR-0031 §11.5）。
 *
 * 四层：全局决策块 / 活跃前沿 / 关闭胶囊 / 回访结果。
 * - 键包含各自 revision/哈希；稳定系统规则与全局块可位于提示词前缀；
 * - 只缓存确定且无副作用的装配结果；写操作、授权、时间敏感、失败结果与
 *   任务执行结论一律 bypass；
 * - 失效按层与实体精确进行：单块变化只失效该块；活跃局部变化不失效稳定
 *   全局前缀；不同 Agent 的条目互不影响。
 */
import { createHash } from "node:crypto";

export const CONTEXT_CACHE_TIERS = [
  "global-decision-block",
  "active-frontier",
  "closure-capsule",
  "recall-result",
] as const;
export type ContextCacheTier = (typeof CONTEXT_CACHE_TIERS)[number];

export const GLOBAL_CONTEXT_BLOCK_TYPES = [
  "safety-and-permission",
  "architecture-decision",
  "user-preference",
  "interface-contract",
  "project-state",
] as const;
export type GlobalContextBlockType = (typeof GLOBAL_CONTEXT_BLOCK_TYPES)[number];

export interface GlobalDecisionBlockKeyParts {
  tier: "global-decision-block";
  provider: string;
  model: string;
  policyIdentifier: string;
  blockType: GlobalContextBlockType;
  globalContextRevision: number;
  globalContextBudgetPolicyRevision: number;
  blockContentHash: string;
}

export interface ActiveFrontierKeyParts {
  tier: "active-frontier";
  agentInstanceId: string;
  missionId: string;
  taskIdentifier: string;
  activeNodeIdentifiers: string[];
  openRequiredAncestorIdentifiers: string[];
  contextGraphRevision: number;
}

export interface ClosureCapsuleKeyParts {
  tier: "closure-capsule";
  contextNodeIdentifier: string;
  closureRevision: number;
  capsuleContentHash: string;
  relatedArtifactFingerprint: string;
}

export interface RecallResultKeyParts {
  tier: "recall-result";
  agentInstanceId: string;
  taskIdentifier: string;
  contextNodeIdentifier: string;
  contextNodeRevision: number;
  reasonCode: string;
  selectionStrategyIdentifier: string;
  maximumTokenCount: number;
}

export type ContextCacheKeyParts =
  | GlobalDecisionBlockKeyParts
  | ActiveFrontierKeyParts
  | ClosureCapsuleKeyParts
  | RecallResultKeyParts;

export interface ContextCacheBypassCriteria {
  isWriteOperation: boolean;
  isAuthorizationResult: boolean;
  isTimeSensitive: boolean;
  isFailedResult: boolean;
  isTaskExecutionConclusion: boolean;
}

export type ContextCacheStatus = "hit" | "miss" | "bypass" | "stale-reject";

export function buildContextCacheKey(parts: ContextCacheKeyParts): string {
  return createHash("sha256")
    .update(stableSerialize(parts), "utf8")
    .digest("hex");
}

export function shouldBypassContextCache(criteria: ContextCacheBypassCriteria): boolean {
  return (
    criteria.isWriteOperation ||
    criteria.isAuthorizationResult ||
    criteria.isTimeSensitive ||
    criteria.isFailedResult ||
    criteria.isTaskExecutionConclusion
  );
}

export interface ContextCacheEntry {
  key: string;
  parts: ContextCacheKeyParts;
  valueText: string;
  estimatedTokenCount: number;
  cachedAtIso: string;
}

export interface ContextCacheChangeDescriptor {
  tier?: ContextCacheTier;
  agentInstanceId?: string;
  globalContextBlockType?: GlobalContextBlockType;
  contextNodeIdentifier?: string;
  contextGraphRevision?: number;
  globalContextRevision?: number;
  globalContextBudgetPolicyRevision?: number;
}

export interface ContextCacheOperationResult {
  status: ContextCacheStatus;
  valueText: string | null;
  invalidatedKeys: string[];
}

export class ContextTierCache {
  private readonly entries = new Map<string, ContextCacheEntry>();
  private hitCount = 0;
  private missCount = 0;
  private bypassCount = 0;
  private staleRejectCount = 0;

  set(
    parts: ContextCacheKeyParts,
    valueText: string,
    estimatedTokenCount: number,
    cachedAtIso: string,
  ): string {
    const key = buildContextCacheKey(parts);
    this.entries.set(key, { key, parts, valueText, estimatedTokenCount, cachedAtIso });
    return key;
  }

  get(parts: ContextCacheKeyParts): ContextCacheOperationResult {
    const key = buildContextCacheKey(parts);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return { status: "miss", valueText: null, invalidatedKeys: [] };
    }
    this.hitCount += 1;
    return { status: "hit", valueText: entry.valueText, invalidatedKeys: [] };
  }

  bypass(): ContextCacheOperationResult {
    this.bypassCount += 1;
    return { status: "bypass", valueText: null, invalidatedKeys: [] };
  }

  /** 命中但输入已变化（例如图 revision 提升）时按 stale-reject 处理。 */
  staleReject(expectedRevision: number, actualRevision: number): ContextCacheOperationResult {
    if (expectedRevision === actualRevision) {
      return { status: "hit", valueText: null, invalidatedKeys: [] };
    }
    this.staleRejectCount += 1;
    return { status: "stale-reject", valueText: null, invalidatedKeys: [] };
  }

  /** 精确失效：只移除与变化描述匹配的键。 */
  invalidate(change: ContextCacheChangeDescriptor): string[] {
    const invalidatedKeys: string[] = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      if (this.isInvalidated(entry.parts, change)) {
        this.entries.delete(key);
        invalidatedKeys.push(key);
      }
    }
    return invalidatedKeys;
  }

  getStats(): {
    hitCount: number;
    missCount: number;
    bypassCount: number;
    staleRejectCount: number;
    entryCount: number;
    hitRate: number;
  } {
    const denominator = this.hitCount + this.missCount;
    return {
      hitCount: this.hitCount,
      missCount: this.missCount,
      bypassCount: this.bypassCount,
      staleRejectCount: this.staleRejectCount,
      entryCount: this.entries.size,
      hitRate: denominator === 0 ? 0 : this.hitCount / denominator,
    };
  }

  private isInvalidated(
    parts: ContextCacheKeyParts,
    change: ContextCacheChangeDescriptor,
  ): boolean {
    if (change.tier !== undefined && parts.tier !== change.tier) {
      return false;
    }
    if (parts.tier === "global-decision-block") {
      if (
        change.globalContextBlockType !== undefined &&
        parts.blockType !== change.globalContextBlockType
      ) {
        return false;
      }
      // 已经处于新 revision 的条目无需失效；Agent 维度变化不触碰全局块。
      if (
        change.globalContextRevision !== undefined &&
        parts.globalContextRevision === change.globalContextRevision
      ) {
        return false;
      }
      if (
        change.globalContextBudgetPolicyRevision !== undefined &&
        parts.globalContextBudgetPolicyRevision ===
          change.globalContextBudgetPolicyRevision
      ) {
        return false;
      }
      if (change.agentInstanceId !== undefined) {
        return false;
      }
      return true;
    }
    if (parts.tier === "active-frontier") {
      if (
        change.agentInstanceId !== undefined &&
        parts.agentInstanceId !== change.agentInstanceId
      ) {
        return false;
      }
      if (
        change.contextGraphRevision !== undefined &&
        parts.contextGraphRevision === change.contextGraphRevision
      ) {
        return false;
      }
      return true;
    }
    if (parts.tier === "closure-capsule") {
      // 胶囊按节点/闭包 revision 精确失效；Agent 维度变化不隐式失效胶囊。
      if (change.agentInstanceId !== undefined) {
        return false;
      }
      if (
        change.contextNodeIdentifier !== undefined &&
        parts.contextNodeIdentifier !== change.contextNodeIdentifier
      ) {
        return false;
      }
      return true;
    }
    if (
      change.agentInstanceId !== undefined &&
      parts.agentInstanceId !== change.agentInstanceId
    ) {
      return false;
    }
    if (
      change.contextNodeIdentifier !== undefined &&
      parts.contextNodeIdentifier !== change.contextNodeIdentifier
    ) {
      return false;
    }
    return true;
  }
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (value !== null && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return Object.fromEntries(
      sortedEntries.map(([entryKey, entryValue]) => [entryKey, sortKeys(entryValue)]),
    );
  }
  return value;
}
