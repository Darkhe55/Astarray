/**
 * SUM-02-03：权威字段本地提取、叙述证据核验与"依据原始分块重建摘要"。
 *
 * 原则（见 docs/adr/0036-summary-fact-verification.md）：
 * - 核验输入必须是**原始条目**（带 sourceRevision 与 contentHash），不接受"摘要的摘要"；
 * - 引用存在 ≠ 语义正确：同时检查数值冲突、无出处的数值断言与关键遗漏；
 * - 重建叙述只能是原始证据的确定性拼接（带来源指针），不经过模型再生成。
 */
import { createHash } from "node:crypto";

export type ClaimKind =
  | "number-with-unit"
  | "identifier"
  | "decision-status"
  | "timestamp"
  | "negation";

/** 原始条目（必须是原文，不得是既有摘要）。 */
export interface AuthoritativeRecord {
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
  text: string;
  /** 非空即表示该文本本身来自另一份摘要 → 拒绝"摘要再摘要"。 */
  derivedFromSummaryIdentifier?: string | null;
}

export interface AuthoritativeClaim {
  claimIdentifier: string;
  claimKind: ClaimKind;
  normalizedValue: string;
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
  excerpt: string;
  /** 关键事实：数值/单位、状态决策、否定约束。 */
  isKeyFact: boolean;
}

export type SummaryFactVerificationErrorCode =
  | "missing-original-source"
  | "summary-of-summary-rejected";

export class SummaryFactVerificationError extends Error {
  constructor(
    readonly errorCode: SummaryFactVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SummaryFactVerificationError";
  }
}

const NUMBER_WITH_UNIT_PATTERN =
  /(\d+(?:\.\d+)?)\s*(字节|字|条|次|tokens?|token|ms|s|%|KB|MB|GB|°|℃|kg|mm)/gi;
const IDENTIFIER_PATTERN =
  /\b(?:[A-Za-z][A-Za-z0-9]*-(?:[A-Za-z0-9]+-)*[0-9]{2,}|[a-f0-9]{12,})\b/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
const DECISION_STATUS_PATTERN =
  /\b(done|blocked|failed|cancelled|accepted|完成|阻塞|失败|取消|已受理)\b/g;
const NEGATION_PATTERN = /不(?:得|承诺)?[\u4e00-\u9fa5]{0,3}(?:裁剪|截断|覆盖|静默|重试)|\bno (?:truncation|silent|retry)\b/gi;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  return text.slice(start, Math.min(text.length, index + length + 12));
}

function collectMatches(
  pattern: RegExp,
  text: string,
): Array<{ value: string; index: number }> {
  const matches: Array<{ value: string; index: number }> = [];
  const matcher = new RegExp(pattern.source, pattern.flags);
  for (const match of text.matchAll(matcher)) {
    matches.push({ value: match[0], index: match.index ?? 0 });
  }
  return matches;
}

function normalizeNumberWithUnit(rawValue: string): string {
  const match = /(\d+(?:\.\d+)?)\s*([A-Za-z%°℃]+|[\u4e00-\u9fa5]+)/.exec(rawValue);
  const numericPart = match?.[1];
  const unitPart = match?.[2];
  if (numericPart === undefined || unitPart === undefined) {
    return rawValue.toLowerCase().replace(/\s+/g, "");
  }
  return numericPart + unitPart.toLowerCase();
}

function normalizeDecisionStatus(rawValue: string): string {
  const mapping: Record<string, string> = {
    done: "done",
    完成: "done",
    blocked: "blocked",
    阻塞: "blocked",
    failed: "failed",
    失败: "failed",
    cancelled: "cancelled",
    取消: "cancelled",
    accepted: "accepted",
    已受理: "accepted",
  };
  return mapping[rawValue.toLowerCase()] ?? rawValue.toLowerCase();
}

/** 本地确定性权威字段提取（规则化，不调用模型）。 */
export function extractAuthoritativeClaims(
  records: AuthoritativeRecord[],
): AuthoritativeClaim[] {
  const claims: AuthoritativeClaim[] = [];
  const pushClaim = (
    claimKind: ClaimKind,
    normalizedValue: string,
    record: AuthoritativeRecord,
    rawValue: string,
    index: number,
  ): void => {
    claims.push({
      claimIdentifier:
        "claim-" +
        sha256Hex(
          [record.sourceIdentifier, String(record.sourceRevision), claimKind, normalizedValue].join("|"),
        ).slice(0, 16),
      claimKind,
      normalizedValue,
      sourceIdentifier: record.sourceIdentifier,
      sourceRevision: record.sourceRevision,
      contentHash: record.contentHash,
      excerpt: excerptAround(record.text, index, rawValue.length),
      isKeyFact:
        claimKind === "number-with-unit" ||
        claimKind === "decision-status" ||
        claimKind === "negation",
    });
  };

  for (const record of records) {
    for (const match of collectMatches(NUMBER_WITH_UNIT_PATTERN, record.text)) {
      pushClaim("number-with-unit", normalizeNumberWithUnit(match.value), record, match.value, match.index);
    }
    for (const match of collectMatches(IDENTIFIER_PATTERN, record.text)) {
      pushClaim("identifier", match.value, record, match.value, match.index);
    }
    for (const match of collectMatches(ISO_TIMESTAMP_PATTERN, record.text)) {
      pushClaim("timestamp", match.value, record, match.value, match.index);
    }
    for (const match of collectMatches(DECISION_STATUS_PATTERN, record.text)) {
      pushClaim("decision-status", normalizeDecisionStatus(match.value), record, match.value, match.index);
    }
    for (const match of collectMatches(NEGATION_PATTERN, record.text)) {
      pushClaim("negation", match.value.replace(/\s+/g, "").toLowerCase(), record, match.value, match.index);
    }
  }
  return claims;
}

export interface NarrativeCitation {
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
}

export interface NarrativeVerificationReport {
  verdict: "supported" | "partially-supported" | "unsupported";
  claimCount: number;
  supportedClaimIdentifiers: string[];
  omittedKeyClaimIdentifiers: string[];
  unsupportedNumericAssertions: Array<{ normalizedValue: string; narrativeExcerpt: string }>;
  conflictingValues: Array<{
    claimIdentifier: string;
    authoritativeValue: string;
    narrativeValue: string;
  }>;
  citationErrors: Array<{
    sourceIdentifier: string;
    sourceRevision: number;
    reason: "not-found" | "content-hash-mismatch";
  }>;
  checks: { hasOriginalSources: boolean; isNotSummaryOfSummary: boolean };
  notes: string[];
}

/** 断言输入来自原文（含 revision/哈希）且不是"摘要的摘要"。 */
export function assertVerifiableOriginalSources(records: AuthoritativeRecord[]): void {
  for (const record of records) {
    if (
      record.contentHash.trim() === "" ||
      !Number.isInteger(record.sourceRevision) ||
      record.sourceRevision < 1
    ) {
      throw new SummaryFactVerificationError(
        "missing-original-source",
        "核验输入缺少原始 revision/内容哈希（不接受无出处内容）: " + record.sourceIdentifier,
      );
    }
    if (
      record.derivedFromSummaryIdentifier !== undefined &&
      record.derivedFromSummaryIdentifier !== null &&
      record.derivedFromSummaryIdentifier !== ""
    ) {
      throw new SummaryFactVerificationError(
        "summary-of-summary-rejected",
        "核验输入本身是摘要产物，禁止摘要再摘要: " + record.sourceIdentifier,
      );
    }
  }
}

/**
 * 核验叙述：引用存在 ≠ 语义正确。
 * 同时给出支持项、关键遗漏、无出处数值断言、数值冲突与引用错误。
 */
export function verifyNarrativeAgainstClaims(input: {
  narrativeText: string;
  citations: NarrativeCitation[];
  records: AuthoritativeRecord[];
}): NarrativeVerificationReport {
  assertVerifiableOriginalSources(input.records);
  const narrativeText = input.narrativeText;
  const claims = extractAuthoritativeClaims(input.records);

  const supportedClaimIdentifiers: string[] = [];
  const omittedKeyClaimIdentifiers: string[] = [];
  for (const claim of claims) {
    const isReferenced = narrativeText.includes(claim.normalizedValue) ||
      narrativeText.includes(claim.excerpt.slice(0, Math.min(24, claim.excerpt.length)));
    if (isReferenced) {
      supportedClaimIdentifiers.push(claim.claimIdentifier);
    } else if (claim.isKeyFact) {
      omittedKeyClaimIdentifiers.push(claim.claimIdentifier);
    }
  }

  const authoritativeByUnit = new Map<string, string[]>();
  for (const claim of claims) {
    if (claim.claimKind !== "number-with-unit") {
      continue;
    }
    const unitMatch = /([A-Za-z%°℃]+|[\u4e00-\u9fa5]+)$/.exec(claim.normalizedValue);
    const unit = unitMatch?.[1] ?? "";
    const valueMatch = /^(\d+(?:\.\d+)?)/.exec(claim.normalizedValue);
    const value = valueMatch?.[1] ?? "";
    const bucket = authoritativeByUnit.get(unit) ?? [];
    bucket.push(value);
    authoritativeByUnit.set(unit, bucket);
  }

  const unsupportedNumericAssertions: Array<{ normalizedValue: string; narrativeExcerpt: string }> = [];
  const conflictingValues: Array<{ claimIdentifier: string; authoritativeValue: string; narrativeValue: string }> = [];
  for (const match of collectMatches(NUMBER_WITH_UNIT_PATTERN, narrativeText)) {
    const normalizedValue = normalizeNumberWithUnit(match.value);
    const unitMatch = /([A-Za-z%°℃]+|[\u4e00-\u9fa5]+)$/.exec(normalizedValue);
    const unit = unitMatch?.[1] ?? "";
    const value = /^(\d+(?:\.\d+)?)/.exec(normalizedValue)?.[1] ?? "";
    const authoritativeValues = authoritativeByUnit.get(unit);
    if (authoritativeValues === undefined) {
      unsupportedNumericAssertions.push({
        normalizedValue,
        narrativeExcerpt: excerptAround(narrativeText, match.index, match.value.length),
      });
      continue;
    }
    if (!authoritativeValues.includes(value)) {
      const claim = claims.find(
        (candidate) =>
          candidate.claimKind === "number-with-unit" &&
          candidate.normalizedValue.endsWith(unit),
      );
      conflictingValues.push({
        claimIdentifier: claim?.claimIdentifier ?? "unknown",
        authoritativeValue: (authoritativeValues[0] ?? "") + unit,
        narrativeValue: normalizedValue,
      });
    }
  }

  const citationErrors: NarrativeVerificationReport["citationErrors"] = [];
  for (const citation of input.citations) {
    const record = input.records.find(
      (candidate) =>
        candidate.sourceIdentifier === citation.sourceIdentifier &&
        candidate.sourceRevision === citation.sourceRevision,
    );
    if (record === undefined) {
      citationErrors.push({
        sourceIdentifier: citation.sourceIdentifier,
        sourceRevision: citation.sourceRevision,
        reason: "not-found",
      });
      continue;
    }
    if (record.contentHash !== citation.contentHash) {
      citationErrors.push({
        sourceIdentifier: citation.sourceIdentifier,
        sourceRevision: citation.sourceRevision,
        reason: "content-hash-mismatch",
      });
    }
  }

  const verdict: NarrativeVerificationReport["verdict"] =
    conflictingValues.length > 0 ||
    unsupportedNumericAssertions.length > 0 ||
    citationErrors.length > 0
      ? "unsupported"
      : omittedKeyClaimIdentifiers.length > 0
        ? "partially-supported"
        : "supported";

  return {
    verdict,
    claimCount: claims.length,
    supportedClaimIdentifiers,
    omittedKeyClaimIdentifiers,
    unsupportedNumericAssertions,
    conflictingValues,
    citationErrors,
    checks: { hasOriginalSources: true, isNotSummaryOfSummary: true },
    notes: [
      "支持 " + String(supportedClaimIdentifiers.length) + "/" + String(claims.length) + " 条权威字段",
      "关键遗漏 " + String(omittedKeyClaimIdentifiers.length) + " 条",
      "无出处数值断言 " + String(unsupportedNumericAssertions.length) + " 条",
      "数值冲突 " + String(conflictingValues.length) + " 条",
      "引用错误 " + String(citationErrors.length) + " 条",
    ],
  };
}

export interface RebuiltNarrative {
  narrativeText: string;
  usedClaimIdentifiers: string[];
  citations: NarrativeCitation[];
}

/**
 * 依据原始分块重建叙述：只做确定性拼接（引用原始 excerpt + 来源指针），
 * 不经过模型再生成，因此可被同一核验器判定为 supported。
 */
export function rebuildNarrativeFromClaims(input: {
  claims: AuthoritativeClaim[];
  maximumClaimsPerParagraph?: number;
}): RebuiltNarrative {
  const maximumClaimsPerParagraph = Math.max(
    1,
    input.maximumClaimsPerParagraph ?? 6,
  );
  const claims = [...input.claims].sort((left, right) => {
    if (left.sourceIdentifier !== right.sourceIdentifier) {
      return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
    }
    return left.sourceRevision - right.sourceRevision;
  });
  const citations: NarrativeCitation[] = [];
  const usedClaimIdentifiers: string[] = [];
  const sentences: string[] = [];
  for (let index = 0; index < claims.length; index += maximumClaimsPerParagraph) {
    const paragraphClaims = claims.slice(index, index + maximumClaimsPerParagraph);
    const parts = paragraphClaims.map((claim) => {
      citations.push({
        sourceIdentifier: claim.sourceIdentifier,
        sourceRevision: claim.sourceRevision,
        contentHash: claim.contentHash,
      });
      usedClaimIdentifiers.push(claim.claimIdentifier);
      return claim.normalizedValue + "（原始证据 " + claim.sourceIdentifier + "@" + String(claim.sourceRevision) + "）";
    });
    sentences.push(parts.join("；"));
  }
  return {
    narrativeText: sentences.join("\n"),
    usedClaimIdentifiers,
    citations,
  };
}
