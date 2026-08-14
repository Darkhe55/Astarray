/**
 * 专用资料搜索代理端口（T06D / ADR-0016）。
 * 只接受结构化查询（结构化 query + 每查询预算），不开放通用浏览或任意 URL
 * 执行能力。来源正文、发布者、直接链接/文档标识、发布时间、取得时间与
 * 内容摘要哈希可追溯。查询在本地做敏感内容检查；查询内容不得包含工作区
 * 正文、.env、凭据、私钥或完整提示词。
 */
import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { EvidenceSourceEntry } from "../core/types.js";

export interface EvidenceSourceSearchResult {
  title: string;
  publisherOrAuthor: string;
  directLinkOrDocumentId: string;
  publishedAtIso: string | null;
  /** 实际取得的相关正文（search-sources 必须取得可定位正文，仅标题/摘要不算）。 */
  retrievedExcerptText: string;
  retrievedAtIso: string;
  sourceType: EvidenceSourceEntry["sourceType"];
}

/** 专用搜索代理：结构化查询，不开放任意网络执行。 */
export interface EvidenceSearchAgentPort {
  searchSources(input: {
    structuredQuery: string;
    claimIdentifier: string;
  }): Promise<EvidenceSourceSearchResult[]>;
}

/** 查询敏感检查（ADR-0018 延伸）：查询不得含凭据/私钥/密钥模式。 */
const QUERY_SENSITIVE_PATTERNS: RegExp[] = [
  /(api[_-]?key|access[_-]?key|secret|token|password|private[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9_\-./]{16,}/i,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY/,
  /(ghp|gho|ghu|ghs)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9]{16,}/,
  /(postgres|mysql|mongodb|redis|amqp)\+?s?:\/\/[^\s:@]+:[^\s:@]+@/,
];

/** 规范化查询指纹（防换词活锁：等价查询指纹一致，用于缓存与预算）。 */
export function buildNormalizedQueryFingerprint(structuredQuery: string): string {
  const normalized = structuredQuery
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * 查询防护：敏感内容拒绝 + 指纹缓存（相同指纹复用结果）+ 每主张调用预算。
 * 换词等价查询共享指纹/预算，不能形成旁路。
 */
export class EvidenceQueryGuard {
  private readonly cache = new Map<string, EvidenceSourceSearchResult[]>();
  private readonly budgetByClaim = new Map<string, number>();

  constructor(
    private readonly maxCallsPerClaim = 20,
    private readonly maxCachedQueries = 200,
  ) {}

  async searchSafely(input: {
    structuredQuery: string;
    claimIdentifier: string;
    agent: EvidenceSearchAgentPort;
  }): Promise<{
    results: EvidenceSourceSearchResult[];
    fromCache: boolean;
  }> {
    const fingerprint = buildNormalizedQueryFingerprint(input.structuredQuery);
    const cached = this.cache.get(fingerprint);
    if (cached !== undefined) {
      return { results: cached, fromCache: true };
    }
    const usedBudget = this.budgetByClaim.get(input.claimIdentifier) ?? 0;
    if (usedBudget >= this.maxCallsPerClaim) {
      throw new DomainError(
        "livelock-guard-triggered",
        `主张 ${input.claimIdentifier} 的搜索调用预算已用尽（${this.maxCallsPerClaim}），换词查询被阻断`,
      );
    }
    this.budgetByClaim.set(input.claimIdentifier, usedBudget + 1);
    // 敏感内容检查：查询不得含凭据/私钥/密钥
    const sensitiveMatch = QUERY_SENSITIVE_PATTERNS.find((pattern) =>
      pattern.test(input.structuredQuery),
    );
    if (sensitiveMatch !== undefined) {
      throw new DomainError(
        "sensitive-content-read-denied",
        "查询含疑似敏感内容，拒绝上传",
      );
    }
    const results = await input.agent.searchSources({
      structuredQuery: input.structuredQuery,
      claimIdentifier: input.claimIdentifier,
    });
    this.cache.set(fingerprint, results);
    if (this.cache.size > this.maxCachedQueries) {
      const oldestFingerprint = this.cache.keys().next().value;
      if (oldestFingerprint !== undefined) {
        this.cache.delete(oldestFingerprint);
      }
    }
    return { results, fromCache: false };
  }

  getBudgetForClaim(claimIdentifier: string): number {
    return this.budgetByClaim.get(claimIdentifier) ?? 0;
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
