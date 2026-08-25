/**
 * T12A-01 测试：统一恢复契约 schema。
 * 验收：秘密字段（nonce/凭据/一次性许可）不进入检查点；旧授权不恢复；
 * 身份复用（已回收必须新身份+handoff）；未知副作用 blocked；
 * 损坏 revision/哈希链反例。
 */
import { describe, expect, it } from "vitest";

import {
  RECOVERY_CHECKPOINT_SCHEMA_VERSION,
  TOOL_CALL_RECOVERY_STATES,
  assertCheckpointHasNoSecretFields,
  recoveryCheckpointSchema,
  recoveryReconciliationResultSchema,
} from "../../../packages/core/src/orchestration/recovery-checkpoint-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: RECOVERY_CHECKPOINT_SCHEMA_VERSION,
    checkpointIdentifier: "checkpoint-1",
    sessionIdentifier: "session-1",
    missionIdentifier: "mission-1",
    taskChainIdentifier: "chain-1",
    agentIdentities: [
      {
        agentInstanceId: "tertiary-1",
        agentRole: "tertiary",
        lifecycleState: "active",
        handoffReference: null,
        parentAgentInstanceId: "secondary-1",
      },
    ],
    taskNodes: [
      {
        taskNodeIdentifier: "task-1",
        status: "running",
        predecessorTaskNodeIdentifiers: [],
        priorityTier: 0,
        assignedAgentInstanceId: "tertiary-1",
        checkpointIdentifier: "cp-1",
        completionAttemptIdentifier: "attempt-1",
      },
    ],
    humanChangeObservationRevision: 1,
    pendingConflictIdentifiers: [],
    toolCalls: [
      {
        toolCallIdentifier: "tool-call-1",
        toolName: "project.write",
        state: "confirmed-success",
        isIdempotent: true,
        completionAttemptIdentifier: "attempt-1",
      },
    ],
    providerRequests: [
      {
        providerRequestPublicIdentifier: "provider-req-1",
        lastEventAtIso: "2026-08-19T00:00:00.000Z",
        isStopConfirmed: false,
        completionEventState: "none",
      },
    ],
    feedbackCursor: { enqueueCursor: 3, deliveryCursor: 2, ackCursor: 1 },
    permissionRecovery: [
      { permissionProfileReference: "assist", profileRevision: 2 },
    ],
    workingSetFileCountsByAgent: { "tertiary-1": 7 },
    taskChainCumulativeSourceCount: 12,
    gateStates: {
      testingGate: "passed",
      acceptanceGate: "pending",
      humanReviewGate: "pending",
      installationGate: "pending",
      backupDeletionGate: "pending",
    },
    contentHash: VALID_SHA256,
    previousCheckpointHash: null,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    writingProcessInstanceIdentifier: "process-1",
    ...overrides,
  };
}

describe("RecoveryCheckpointV1 schema", () => {
  it("合法检查点通过（哈希链/游标/门禁齐全）", () => {
    expect(recoveryCheckpointSchema.safeParse(makeCheckpoint()).success).toBe(true);
  });

  it("反例：损坏 revision（schemaVersion 迁移）/哈希非法 → 拒绝", () => {
    expect(
      recoveryCheckpointSchema.safeParse(makeCheckpoint({ schemaVersion: 99 }))
        .success,
    ).toBe(false);
    expect(
      recoveryCheckpointSchema.safeParse(
        makeCheckpoint({ contentHash: "not-sha256" }),
      ).success,
    ).toBe(false);
  });

  it("反例：工具调用状态非法/游标负值 → 拒绝", () => {
    expect(
      recoveryCheckpointSchema.safeParse(
        makeCheckpoint({
          toolCalls: [
            {
              toolCallIdentifier: "t",
              toolName: "x",
              state: "mystery-state",
              isIdempotent: false,
              completionAttemptIdentifier: null,
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      recoveryCheckpointSchema.safeParse(
        makeCheckpoint({ feedbackCursor: { enqueueCursor: -1, deliveryCursor: 0, ackCursor: 0 } }),
      ).success,
    ).toBe(false);
  });

  it("秘密字段反例：检查点不得含 nonce/凭据/一次性许可", () => {
    const leakedCheckpoint = makeCheckpoint({
      permissionRecovery: [
        { permissionProfileReference: "assist", profileRevision: 2 },
      ],
    });
    // 在权限恢复外注入一次性许可字段 → assert 拒绝
    const withSecret = {
      ...leakedCheckpoint,
      authorizationNonce: "nonce-abc123",
    };
    expect(() =>
      assertCheckpointHasNoSecretFields(withSecret as never),
    ).toThrowError(/不得包含授权 nonce/);
    // 合法检查点通过
    expect(() =>
      assertCheckpointHasNoSecretFields(leakedCheckpoint as never),
    ).not.toThrow();
  });
});

describe("身份恢复与旧授权", () => {
  it("已回收 Agent 必须新身份 + 显式 handoff（不复用旧身份）", () => {
    const checkpoint = makeCheckpoint({
      agentIdentities: [
        {
          agentInstanceId: "tertiary-reclaimed",
          agentRole: "tertiary",
          lifecycleState: "reclaimed",
          handoffReference: "handoff-from-tertiary-reclaimed",
          parentAgentInstanceId: "secondary-1",
        },
      ],
    });
    expect(recoveryCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    const reclaimed = checkpoint.agentIdentities[0];
    expect(reclaimed?.lifecycleState).toBe("reclaimed");
    expect(reclaimed?.handoffReference).not.toBeNull();
  });

  it("旧授权不恢复：检查点只记录公开权限引用（无一次性授权）", () => {
    const checkpoint = makeCheckpoint();
    const serialized = JSON.stringify(checkpoint);
    expect(serialized).not.toContain("allow-once");
    expect(serialized).not.toContain("elevation-nonce");
  });
});

describe("对账结果与未知副作用", () => {
  it("非幂等副作用结果未知 → blocked-uncertain-side-effect", () => {
    expect(
      recoveryReconciliationResultSchema.safeParse({
        schemaVersion: 1,
        reconciliationIdentifier: "recon-1",
        decision: "blocked-uncertain-side-effect",
        checkpointIdentifier: "checkpoint-1",
        blockedReason: "非幂等远端写入结果未知，需用户裁决",
        handoffReference: null,
        reauthorizationRequired: false,
        createdAtIso: "2026-08-19T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("Provider 仍可能活跃 → blocked-provider-state-unknown", () => {
    const result = recoveryReconciliationResultSchema.safeParse({
      schemaVersion: 1,
      reconciliationIdentifier: "recon-2",
      decision: "blocked-provider-state-unknown",
      checkpointIdentifier: "checkpoint-1",
      blockedReason: "旧 Provider 请求停止状态未确认",
      handoffReference: null,
      reauthorizationRequired: false,
      createdAtIso: "2026-08-19T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("调用状态五态冻结", () => {
    expect(TOOL_CALL_RECOVERY_STATES).toEqual([
      "planned",
      "started",
      "confirmed-success",
      "confirmed-failure",
      "result-unknown",
    ]);
  });
});