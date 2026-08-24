/**
 * T07E-01 测试：工作集、来源 manifest、预算与扩展 grant schema。
 * 验收：默认 10 文件冻结；治理文档独立预算；聚合旁路 fail-closed；
 * 扩展 grant 参数变化后失效；revision/配置迁移拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION,
  DEFAULT_WORKING_SET_WARNING_THRESHOLD_FILE_COUNT,
  WORKING_SET_BUDGET_DECISIONS,
  readBudgetExpansionGrantSchema,
  sourceManifestSchema,
  workingSetEntrySchema,
  workingSetStateSchema,
} from "../../../packages/core/src/orchestration/working-set-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

describe("T07E-01 冻结常量", () => {
  it("默认 10 文件预算与 8 文件提醒阈值冻结", () => {
    expect(DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION).toBe(10);
    expect(DEFAULT_WORKING_SET_WARNING_THRESHOLD_FILE_COUNT).toBe(8);
  });

  it("预算决定五态冻结", () => {
    expect(WORKING_SET_BUDGET_DECISIONS).toEqual([
      "allowed",
      "warned",
      "denied",
      "split",
      "expanded",
    ]);
  });
});

describe("workingSetEntrySchema", () => {
  it("合法条目（规范身份 + 指纹）通过", () => {
    expect(
      workingSetEntrySchema.safeParse({
        schemaVersion: 1,
        canonicalResourceIdentity: "src/a.ts",
        contentFingerprint: VALID_SHA256,
        firstSeenAtIso: "2026-08-19T00:00:00.000Z",
        isStale: false,
      }).success,
    ).toBe(true);
  });

  it("反例：指纹非法/规范身份为空 → 拒绝（别名不能绕过）", () => {
    expect(
      workingSetEntrySchema.safeParse({
        schemaVersion: 1,
        canonicalResourceIdentity: "src/a.ts",
        contentFingerprint: "not-sha256",
        firstSeenAtIso: "2026-08-19T00:00:00.000Z",
        isStale: false,
      }).success,
    ).toBe(false);
    expect(
      workingSetEntrySchema.safeParse({
        schemaVersion: 1,
        canonicalResourceIdentity: "",
        contentFingerprint: VALID_SHA256,
        firstSeenAtIso: "2026-08-19T00:00:00.000Z",
        isStale: false,
      }).success,
    ).toBe(false);
  });
});

describe("sourceManifestSchema（聚合旁路防护）", () => {
  it("合法 manifest（来源非空）通过", () => {
    expect(
      sourceManifestSchema.safeParse({
        schemaVersion: 1,
        manifestIdentifier: "manifest-1",
        sourceFileCanonicalIdentities: ["src/a.ts", "src/b.ts"],
        contentHash: VALID_SHA256,
        createdAtIso: "2026-08-19T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("反例：来源清单为空 → 拒绝（聚合结果无 manifest fail-closed）", () => {
    expect(
      sourceManifestSchema.safeParse({
        schemaVersion: 1,
        manifestIdentifier: "manifest-1",
        sourceFileCanonicalIdentities: [],
        contentHash: VALID_SHA256,
        createdAtIso: "2026-08-19T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("workingSetStateSchema（多维预算）", () => {
  it("合法状态通过（计数 + 治理文档独立预算）", () => {
    expect(
      workingSetStateSchema.safeParse({
        schemaVersion: 1,
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        distinctProjectContentFileCount: 10,
        modelVisibleProjectContentBytes: 1_024_000,
        estimatedProjectContentTokenCount: 12_000,
        governanceDocumentReadCount: 3,
        entries: [],
      }).success,
    ).toBe(true);
  });

  it("反例：负计数 → 拒绝", () => {
    expect(
      workingSetStateSchema.safeParse({
        schemaVersion: 1,
        agentInstanceId: "tertiary-1",
        taskChainIdentifier: "chain-1",
        distinctProjectContentFileCount: -1,
        modelVisibleProjectContentBytes: 0,
        estimatedProjectContentTokenCount: 0,
        governanceDocumentReadCount: 0,
        entries: [],
      }).success,
    ).toBe(false);
  });
});

describe("readBudgetExpansionGrantSchema", () => {
  const grant = {
    schemaVersion: 1,
    grantIdentifier: "grant-1",
    agentInstanceId: "tertiary-1",
    taskChainIdentifier: "chain-1",
    budgetRevision: 2,
    additionalFileCountAllowed: 5,
    allowedPathsOrPurposes: ["src/module-a"],
    reason: "合法大任务需读取模块 A 目录",
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    issuedBy: "authenticated-user",
    issuedAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法 grant 通过", () => {
    expect(readBudgetExpansionGrantSchema.safeParse(grant).success).toBe(true);
  });

  it("反例：新增文件数 0/路径为空 → 拒绝", () => {
    expect(
      readBudgetExpansionGrantSchema.safeParse({
        ...grant,
        additionalFileCountAllowed: 0,
      }).success,
    ).toBe(false);
    expect(
      readBudgetExpansionGrantSchema.safeParse({
        ...grant,
        allowedPathsOrPurposes: [],
      }).success,
    ).toBe(false);
  });

  it("反例：revision/期限变化后失效（绑定要素缺失）→ 拒绝", () => {
    expect(
      readBudgetExpansionGrantSchema.safeParse({ ...grant, budgetRevision: 0 })
        .success,
    ).toBe(false);
    expect(
      readBudgetExpansionGrantSchema.safeParse({ ...grant, expiresAtIso: "x" })
        .success,
    ).toBe(false);
    expect(
      readBudgetExpansionGrantSchema.safeParse({ ...grant, schemaVersion: 99 })
        .success,
    ).toBe(false);
  });
});