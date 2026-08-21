/**
 * T08C-01 测试：四层角色、任务信封、摘要、侦察与裁决 schema。
 * 覆盖：schema 反例（缺失/非法字段拒绝）、冻结决策常量、
 * 四层角色枚举与层级数值、裁决三态不可变。
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_ROLE_LEVEL,
  ACCEPTANCE_VERDICT_VALUES,
  PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION,
  PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION,
  QUATERNARY_DELEGATION_SCHEMA_VERSION,
  SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION,
  SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION,
  acceptanceVerdictValueSchema,
  projectContextDigestSchema,
  projectReconnaissanceTaskSchema,
  quaternaryDelegationSchema,
  secondaryDirectTaskEnvelopeSchema,
  secondaryUserFacingSummarySchema,
} from "../../../packages/core/src/orchestration/agent-routing-schemas.js";
import type { AgentRole } from "../../../packages/core/src/core/types.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION,
    envelopeId: "envelope-1",
    authenticatedUserId: "user-1",
    targetSecondaryAgentInstanceId: "secondary-1",
    scopeDescription: "修复测试输出格式",
    originalUserInstruction: "把调试输出清理干净",
    priorityTier: 0,
    anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    acceptanceCriteria: "无调试输出且测试全绿",
    attachedContextReferenceHashes: [VALID_SHA256],
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

describe("T08C-01 冻结决策", () => {
  it("四层角色层级数值固定：main=0 … quaternary=3", () => {
    expect(AGENT_ROLE_LEVEL).toEqual({
      main: 0,
      secondary: 1,
      tertiary: 2,
      quaternary: 3,
    });
  });

  it("验收裁决三态冻结为 rework/merge-ready/blocked-human-review", () => {
    expect(ACCEPTANCE_VERDICT_VALUES).toEqual([
      "rework",
      "merge-ready",
      "blocked-human-review",
    ]);
    expect(acceptanceVerdictValueSchema.safeParse("merge-ready").success).toBe(true);
    expect(acceptanceVerdictValueSchema.safeParse("approved").success).toBe(false);
  });

  it("各 schema 版本常量固定为 1（首版冻结）", () => {
    expect(SECONDARY_DIRECT_TASK_ENVELOPE_SCHEMA_VERSION).toBe(1);
    expect(SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION).toBe(1);
    expect(PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION).toBe(1);
    expect(PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION).toBe(1);
    expect(QUATERNARY_DELEGATION_SCHEMA_VERSION).toBe(1);
  });
});

describe("secondaryDirectTaskEnvelopeSchema", () => {
  it("合法信封通过", () => {
    expect(secondaryDirectTaskEnvelopeSchema.safeParse(makeEnvelope()).success).toBe(true);
  });

  it("反例：priorityTier 非 0（用户直投必须层级 0）", () => {
    const result = secondaryDirectTaskEnvelopeSchema.safeParse(
      makeEnvelope({ priorityTier: 1 }),
    );
    expect(result.success).toBe(false);
  });

  it("反例：缺少原始用户指令 / 认证用户为空", () => {
    expect(
      secondaryDirectTaskEnvelopeSchema.safeParse(
        makeEnvelope({ originalUserInstruction: "" }),
      ).success,
    ).toBe(false);
    expect(
      secondaryDirectTaskEnvelopeSchema.safeParse(
        makeEnvelope({ authenticatedUserId: "" }),
      ).success,
    ).toBe(false);
  });

  it("反例：附件哈希不符合 sha256 规范", () => {
    const result = secondaryDirectTaskEnvelopeSchema.safeParse(
      makeEnvelope({ attachedContextReferenceHashes: ["not-a-hash"] }),
    );
    expect(result.success).toBe(false);
  });

  it("反例：schemaVersion 不匹配", () => {
    const result = secondaryDirectTaskEnvelopeSchema.safeParse(
      makeEnvelope({ schemaVersion: 99 }),
    );
    expect(result.success).toBe(false);
  });
});

describe("secondaryUserFacingSummarySchema", () => {
  const summary = {
    schemaVersion: SECONDARY_USER_FACING_SUMMARY_SCHEMA_VERSION,
    summaryId: "summary-1",
    secondaryAgentInstanceId: "secondary-1",
    boundTaskIdentifier: "seq-1",
    boundTaskRevision: 3,
    goal: "完成 B6R-11",
    currentProgress: "覆盖率达标",
    keyResults: [
      { resultSummary: "branches 85.05%", evidenceReference: VALID_SHA256 },
    ],
    risksAndFailures: ["平台矩阵未决"],
    pendingUserDecisions: ["是否配置 CI"],
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
  };

  it("合法摘要通过", () => {
    expect(secondaryUserFacingSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("反例：风险/待用户裁决为空数组（不得因压缩消失）", () => {
    expect(
      secondaryUserFacingSummarySchema.safeParse({
        ...summary,
        risksAndFailures: [],
      }).success,
    ).toBe(false);
    expect(
      secondaryUserFacingSummarySchema.safeParse({
        ...summary,
        pendingUserDecisions: [],
      }).success,
    ).toBe(false);
  });
});

describe("projectContextDigestSchema", () => {
  const digest = {
    schemaVersion: PROJECT_CONTEXT_DIGEST_SCHEMA_VERSION,
    digestId: "digest-1",
    reconnaissanceAgentInstanceId: "recon-1",
    scanningScope: "packages/core/src",
    keyEntryPoints: ["src/index.ts"],
    stableContracts: ["runConfigSchema"],
    relevantFileReferences: [
      { filePath: "src/core/types.ts", contentFingerprint: VALID_SHA256 },
    ],
    dependencyRelations: ["core → infra"],
    testEntryPoints: ["tests/core/unit"],
    openQuestions: ["四级工作存档范围"],
    conflicts: ["PLAN_STATUS 标记过时"],
    sources: ["docs/architecture.md"],
    isStale: false,
    tokenBudget: 4000,
    contentHash: VALID_SHA256,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
  };

  it("合法摘要通过；isStale 可标记", () => {
    expect(projectContextDigestSchema.safeParse(digest).success).toBe(true);
    expect(
      projectContextDigestSchema.safeParse({ ...digest, isStale: true }).success,
    ).toBe(true);
  });

  it("反例：内容哈希/指纹非法、token 预算为零、文件引用空指纹", () => {
    expect(
      projectContextDigestSchema.safeParse({ ...digest, contentHash: "x" }).success,
    ).toBe(false);
    expect(
      projectContextDigestSchema.safeParse({ ...digest, tokenBudget: 0 }).success,
    ).toBe(false);
    expect(
      projectContextDigestSchema.safeParse({
        ...digest,
        relevantFileReferences: [
          { filePath: "a.ts", contentFingerprint: "not-sha256" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("projectReconnaissanceTaskSchema", () => {
  const task = {
    schemaVersion: PROJECT_RECONNAISSANCE_TASK_SCHEMA_VERSION,
    reconnaissanceTaskId: "recon-task-1",
    assigningSecondaryAgentInstanceId: "secondary-1",
    scopeQuery: "核心编排模块结构",
    allowedReadToolNames: ["project.read", "project.search"],
    tokenBudget: 4000,
    createdAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法侦察任务通过", () => {
    expect(projectReconnaissanceTaskSchema.safeParse(task).success).toBe(true);
  });

  it("反例：读取工具子集为空（最小读取子集必须非空）", () => {
    expect(
      projectReconnaissanceTaskSchema.safeParse({ ...task, allowedReadToolNames: [] })
        .success,
    ).toBe(false);
  });
});

describe("quaternaryDelegationSchema", () => {
  const delegation = {
    schemaVersion: QUATERNARY_DELEGATION_SCHEMA_VERSION,
    delegationId: "delegation-1",
    delegatingTertiaryAgentInstanceId: "tertiary-1",
    quaternaryAgentInstanceId: "quaternary-1",
    boundSubchainTaskIds: ["t3.1"],
    permissionSubset: "三级权限的严格子集",
    allowedToolNamesSubset: ["project.read"],
    resourceScopeSubset: "任务链内范围",
    expiresAtIso: "2026-08-20T00:00:00.000Z",
    createdAtIso: "2026-08-19T00:00:00.000Z",
  };

  it("合法四级委派通过", () => {
    expect(quaternaryDelegationSchema.safeParse(delegation).success).toBe(true);
  });

  it("反例：子链任务为空（四级必须绑定严格子链）", () => {
    expect(
      quaternaryDelegationSchema.safeParse({ ...delegation, boundSubchainTaskIds: [] })
        .success,
    ).toBe(false);
  });
});

describe("AgentRole 四层扩展", () => {
  it("类型联合包含 quaternary（编译期保证）", () => {
    const roles: AgentRole[] = ["main", "secondary", "tertiary", "quaternary"];
    expect(roles).toContain("quaternary");
    expect(roles).toHaveLength(4);
  });
});
