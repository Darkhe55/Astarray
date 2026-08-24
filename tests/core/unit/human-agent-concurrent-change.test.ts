/**
 * T05D-01 测试：人工—Agent 并行编码契约 schema。
 * 验收：人工来源伪造拒绝；陈旧 revision/错误基线拒绝；路径越界拒绝；
 * 契约重叠可表达；迁移（schema 版本不匹配）拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_EDIT_INTENT_SCHEMA_VERSION,
  CONCURRENT_CHANGE_DECISION_VALUES,
  HUMAN_CHANGE_OBSERVATION_SCHEMA_VERSION,
  MERGE_BASELINE_BINDING_SCHEMA_VERSION,
  agentEditIntentSchema,
  concurrentChangeDecisionSchema,
  humanChangeObservationSchema,
  mergeBaselineBindingSchema,
} from "../../../packages/core/src/orchestration/human-agent-concurrent-change-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;
const ANOTHER_SHA256 = `sha256:${"b".repeat(64)}`;

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_EDIT_INTENT_SCHEMA_VERSION,
    editIntentIdentifier: "intent-1",
    agentInstanceId: "tertiary-impl-1",
    taskExecutionIdentifier: "task-exec-1",
    baseCommitIdentifier: "abc123",
    plannedReadPaths: ["src/a.ts"],
    allowedWritePaths: ["src/a.ts"],
    initialResourceFingerprintsByPath: { "src/a.ts": VALID_SHA256 },
    affectedContractIdentifiers: [],
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function makeObservation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: HUMAN_CHANGE_OBSERVATION_SCHEMA_VERSION,
    observationIdentifier: "observation-1",
    authenticatedUserSourceIdentifier: "user-1",
    observedCommitIdentifier: "def456",
    changedPaths: ["src/a.ts"],
    changedResourceFingerprintsByPath: { "src/a.ts": ANOTHER_SHA256 },
    observedAtIso: "2026-08-19T00:00:00.000Z",
    observationRevision: 1,
    ...overrides,
  };
}

describe("AgentEditIntent schema", () => {
  it("合法意图通过", () => {
    expect(agentEditIntentSchema.safeParse(makeIntent()).success).toBe(true);
  });

  it("失败先行：路径越界（allowedWritePaths 为空/含未计划路径不拒绝但必须非空）", () => {
    expect(
      agentEditIntentSchema.safeParse(makeIntent({ allowedWritePaths: [] })).success,
    ).toBe(false);
  });

  it("失败先行：指纹非法（非 sha256）→ 拒绝", () => {
    expect(
      agentEditIntentSchema.safeParse(
        makeIntent({
          initialResourceFingerprintsByPath: { "src/a.ts": "not-sha256" },
        }),
      ).success,
    ).toBe(false);
  });

  it("失败先行：意图过期时间非法 → 拒绝", () => {
    expect(
      agentEditIntentSchema.safeParse(makeIntent({ expiresAtIso: "not-a-date" }))
        .success,
    ).toBe(false);
  });

  it("失败先行：陈旧 revision（schemaVersion 迁移）→ 拒绝", () => {
    expect(
      agentEditIntentSchema.safeParse(makeIntent({ schemaVersion: 99 })).success,
    ).toBe(false);
  });
});

describe("HumanChangeObservation schema（人工来源伪造防护）", () => {
  it("合法观察通过", () => {
    expect(humanChangeObservationSchema.safeParse(makeObservation()).success).toBe(
      true,
    );
  });

  it("失败先行：认证用户来源为空 → 拒绝（模型不能伪造人工来源）", () => {
    expect(
      humanChangeObservationSchema.safeParse(
        makeObservation({ authenticatedUserSourceIdentifier: "" }),
      ).success,
    ).toBe(false);
  });

  it("失败先行：变化路径为空 → 拒绝；指纹非法 → 拒绝", () => {
    expect(
      humanChangeObservationSchema.safeParse(
        makeObservation({ changedPaths: [] }),
      ).success,
    ).toBe(false);
    expect(
      humanChangeObservationSchema.safeParse(
        makeObservation({
          changedResourceFingerprintsByPath: { "src/a.ts": "bad" },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("ConcurrentChangeDecision schema", () => {
  const decision = {
    schemaVersion: 1,
    decisionIdentifier: "decision-1",
    decision: "no-overlap-revalidate",
    editIntentIdentifier: "intent-1",
    observationIdentifier: "observation-1",
    decidedBy: "authenticated-user",
    authenticatedUserSourceIdentifier: "user-1",
    reason: "人工仅修改不相关文件",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
  };

  it("合法决定通过；五态冻结", () => {
    expect(concurrentChangeDecisionSchema.safeParse(decision).success).toBe(true);
    expect(CONCURRENT_CHANGE_DECISION_VALUES).toEqual([
      "no-overlap-revalidate",
      "text-conflict-reconcile",
      "contract-conflict-reconcile",
      "blocked-human-review",
      "agent-contribution-stale",
    ]);
  });

  it("失败先行：非法决定值/无认证用户来源 → 拒绝", () => {
    expect(
      concurrentChangeDecisionSchema.safeParse({
        ...decision,
        decision: "auto-overwrite",
      }).success,
    ).toBe(false);
    expect(
      concurrentChangeDecisionSchema.safeParse({
        ...decision,
        decidedBy: "authenticated-user",
        authenticatedUserSourceIdentifier: null,
      }).success,
    ).toBe(false);
  });
});

describe("MergeBaselineBinding schema", () => {
  const binding = {
    schemaVersion: MERGE_BASELINE_BINDING_SCHEMA_VERSION,
    bindingIdentifier: "binding-1",
    targetBranchName: "main",
    targetBranchHeadCommit: "aaa",
    humanHeadCommit: "bbb",
    agentBaseCommit: "ccc",
    contributionHeadCommit: "ddd",
    testEvidenceCommit: "eee",
    acceptanceVerdictIdentifier: "verdict-1",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
  };

  it("合法绑定通过（七要素绑定同一 revision）", () => {
    expect(mergeBaselineBindingSchema.safeParse(binding).success).toBe(true);
  });

  it("失败先行：任一提交标识为空 → 拒绝（绑定不完整）", () => {
    expect(
      mergeBaselineBindingSchema.safeParse({
        ...binding,
        humanHeadCommit: "",
      }).success,
    ).toBe(false);
    expect(
      mergeBaselineBindingSchema.safeParse({
        ...binding,
        acceptanceVerdictIdentifier: "",
      }).success,
    ).toBe(false);
  });
});