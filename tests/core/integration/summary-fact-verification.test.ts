/**
 * SUM-02-03：权威字段提取、叙述核验（引用存在≠语义正确）与依据原始分块重建摘要。
 */
import { describe, expect, it } from "vitest";

import {
  SummaryFactVerificationError,
  assertVerifiableOriginalSources,
  extractAuthoritativeClaims,
  rebuildNarrativeFromClaims,
  verifyNarrativeAgainstClaims,
  type AuthoritativeRecord,
} from "../../../packages/core/src/measurement/summary-fact-verification.js";

const records: AuthoritativeRecord[] = [
  {
    sourceIdentifier: "record-1",
    sourceRevision: 1,
    contentHash: "hash-record-1",
    text: "预算 4096 token，范围 ≤ 512 字节；状态 done；mission-abc-01 于 2026-09-15T00:00:00.000Z 完成，不裁剪正文。",
  },
  {
    sourceIdentifier: "record-2",
    sourceRevision: 3,
    contentHash: "hash-record-2",
    text: "温度上限 90°，重试间隔 500 ms，禁止静默重试。",
  },
];

describe("SUM-02-03 权威字段提取与叙述核验", () => {
  it("本地规则化提取五类权威字段（数值/单位、标识、状态、时间、否定）", () => {
    const claims = extractAuthoritativeClaims(records);
    const kinds = new Set(claims.map((claim) => claim.claimKind));
    expect(kinds).toEqual(
      new Set(["number-with-unit", "identifier", "decision-status", "timestamp", "negation"]),
    );
    const normalizedValues = claims.map((claim) => claim.normalizedValue);
    expect(normalizedValues).toContain("4096token");
    expect(normalizedValues).toContain("512字节");
    expect(normalizedValues).toContain("mission-abc-01");
    expect(normalizedValues).toContain("done");
    expect(normalizedValues).toContain("2026-09-15T00:00:00.000Z");
    for (const claim of claims) {
      expect(claim.contentHash).toMatch(/^hash-record-/);
      expect(claim.sourceRevision).toBeGreaterThanOrEqual(1);
      expect(claim.excerpt.length).toBeGreaterThan(0);
    }
    // 关键事实标记：数值/状态/否定为关键。
    expect(
      claims
        .filter((claim) => claim.claimKind === "number-with-unit")
        .every((claim) => claim.isKeyFact),
    ).toBe(true);
    expect(
      claims
        .filter((claim) => claim.claimKind === "timestamp")
        .every((claim) => !claim.isKeyFact),
    ).toBe(true);
  });

  it("引用存在≠语义正确：引用真实来源但数值不同 → 冲突", () => {
    const report = verifyNarrativeAgainstClaims({
      narrativeText: "预算 8192 token，状态 done。",
      citations: [
        { sourceIdentifier: "record-1", sourceRevision: 1, contentHash: "hash-record-1" },
      ],
      records,
    });
    expect(report.citationErrors).toEqual([]);
    expect(report.conflictingValues.length).toBeGreaterThan(0);
    expect(report.conflictingValues[0]).toMatchObject({
      authoritativeValue: "4096token",
      narrativeValue: "8192token",
    });
    expect(report.verdict).toBe("unsupported");
  });

  it("无出处数值断言被识别（可能的臆造）", () => {
    const report = verifyNarrativeAgainstClaims({
      narrativeText: "预算 4096 token，延迟 30s，状态 done。",
      citations: [],
      records,
    });
    expect(
      report.unsupportedNumericAssertions.map((item) => item.normalizedValue),
    ).toContain("30s");
    expect(report.verdict).toBe("unsupported");
  });

  it("关键遗漏 → partially-supported（引用正确也不等于覆盖完整）", () => {
    const report = verifyNarrativeAgainstClaims({
      narrativeText: "涉及 mission-abc-01 的记录已整理。",
      citations: [],
      records,
    });
    expect(report.omittedKeyClaimIdentifiers.length).toBeGreaterThan(0);
    expect(report.conflictingValues).toEqual([]);
    expect(report.unsupportedNumericAssertions).toEqual([]);
    expect(report.verdict).toBe("partially-supported");
    expect(report.notes.join(" ")).toContain("关键遗漏");
  });

  it("引用校验：不存在的 revision 与哈希不符分别报错", () => {
    const notFound = verifyNarrativeAgainstClaims({
      narrativeText: "预算 4096 token。",
      citations: [
        { sourceIdentifier: "record-1", sourceRevision: 99, contentHash: "hash-record-1" },
      ],
      records,
    });
    expect(notFound.citationErrors[0]?.reason).toBe("not-found");

    const hashMismatch = verifyNarrativeAgainstClaims({
      narrativeText: "预算 4096 token。",
      citations: [
        { sourceIdentifier: "record-1", sourceRevision: 1, contentHash: "tampered" },
      ],
      records,
    });
    expect(hashMismatch.citationErrors[0]?.reason).toBe("content-hash-mismatch");
  });

  it("拒绝摘要再摘要与无出处输入", () => {
    expect(() =>
      assertVerifiableOriginalSources([
        { ...records[0]!, derivedFromSummaryIdentifier: "summary-1" },
      ]),
    ).toThrow(SummaryFactVerificationError);
    expect(() =>
      assertVerifiableOriginalSources([
        { sourceIdentifier: "record-x", sourceRevision: 1, contentHash: "", text: "x" },
      ]),
    ).toThrow(SummaryFactVerificationError);
    expect(() =>
      verifyNarrativeAgainstClaims({
        narrativeText: "任意叙述",
        citations: [],
        records: [{ ...records[0]!, derivedFromSummaryIdentifier: "summary-9" }],
      }),
    ).toThrow(/summary-of-abstract|摘要/);
  });

  it("依据原始分块重建叙述：全部引用有效且核验为 supported", () => {
    const claims = extractAuthoritativeClaims(records);
    const rebuilt = rebuildNarrativeFromClaims({
      claims,
      maximumClaimsPerParagraph: 4,
    });
    expect(rebuilt.usedClaimIdentifiers).toHaveLength(claims.length);
    expect(rebuilt.citations).toHaveLength(claims.length);
    expect(rebuilt.narrativeText).toContain("原始证据 record-1@1");
    // 叙述长度随证据增长（无固定上限）。
    const larger = rebuildNarrativeFromClaims({
      claims: extractAuthoritativeClaims([
        ...records,
        {
          sourceIdentifier: "record-3",
          sourceRevision: 1,
          contentHash: "hash-record-3",
          text: "补充条目：容量 2048 MB，状态 blocked。",
        },
      ]),
    });
    expect(larger.narrativeText.length).toBeGreaterThan(rebuilt.narrativeText.length);

    const report = verifyNarrativeAgainstClaims({
      narrativeText: rebuilt.narrativeText,
      citations: rebuilt.citations,
      records,
    });
    expect(report.unsupportedNumericAssertions).toEqual([]);
    expect(report.conflictingValues).toEqual([]);
    expect(report.citationErrors).toEqual([]);
    expect(report.omittedKeyClaimIdentifiers).toEqual([]);
    expect(report.verdict).toBe("supported");
  });
});
