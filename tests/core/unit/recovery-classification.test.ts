/**
 * T12A-04 测试：恢复分类服务。
 * 验收：非幂等副作用结果未知严格 blocked（项目文字/模型声明不能改成
 * 成功）；反馈已 ack 消息不重复注入；一次性授权恢复后失效；
 * Provider 停止状态不确定 → blocked。
 */
import { describe, expect, it } from "vitest";

import { RecoveryClassificationService } from "../../../packages/core/src/orchestration/recovery-classification-service.js";
import type { RecoveryCheckpoint } from "../../../packages/core/src/orchestration/recovery-checkpoint-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeCheckpoint(overrides: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schemaVersion: 1,
    checkpointIdentifier: "checkpoint-1",
    sessionIdentifier: "session-1",
    missionIdentifier: "mission-1",
    taskChainIdentifier: "chain-1",
    agentIdentities: [],
    taskNodes: [],
    humanChangeObservationRevision: 1,
    pendingConflictIdentifiers: [],
    toolCalls: [],
    providerRequests: [],
    feedbackCursor: { enqueueCursor: 5, deliveryCursor: 5, ackCursor: 5 },
    permissionRecovery: [{ permissionProfileReference: "assist", profileRevision: 2 }],
    workingSetFileCountsByAgent: {},
    taskChainCumulativeSourceCount: 0,
    gateStates: {
      testingGate: "pending",
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

const service = new RecoveryClassificationService();

describe("工具副作用分类", () => {
  it("已确认成功且幂等 → 复用结果（不重复调用）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-1",
            toolName: "project.read",
            state: "confirmed-success",
            isIdempotent: true,
            completionAttemptIdentifier: "attempt-1",
          },
        ],
      }),
      remainingRetryBudget: 3,
    });
    expect(result.toolCallClassifications[0]?.classification).toEqual({
      category: "reuse-confirmed-result",
    });
  });

  it("非幂等副作用结果未知 → 严格 blocked（禁止自动重试）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-nonidempotent",
            toolName: "network.post",
            state: "result-unknown",
            isIdempotent: false,
            completionAttemptIdentifier: null,
          },
        ],
      }),
      remainingRetryBudget: 3,
    });
    expect(result.toolCallClassifications[0]?.classification.category).toBe(
      "blocked-uncertain-side-effect",
    );
    expect(result.hasBlockingItems).toBe(true);
    // 项目文字/模型声明不能改成成功：分类由本地规则决定（无输入通道伪造）
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("reuse-confirmed-result");
  });

  it("已确认失败且预算内 → 有界重试", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-fail",
            toolName: "project.read",
            state: "confirmed-failure",
            isIdempotent: true,
            completionAttemptIdentifier: null,
          },
        ],
      }),
      remainingRetryBudget: 2,
    });
    expect(result.toolCallClassifications[0]?.classification).toEqual({
      category: "bounded-retry",
      remainingRetryBudget: 2,
    });
  });
});

describe("Provider 与反馈 ack", () => {
  it("Provider 停止状态不确定 → blocked-provider-state-unknown", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        providerRequests: [
          {
            providerRequestPublicIdentifier: "provider-req-1",
            lastEventAtIso: "2026-08-19T00:00:00.000Z",
            isStopConfirmed: false,
            completionEventState: "none",
          },
        ],
      }),
      remainingRetryBudget: 3,
    });
    expect(result.blockedProviderRequestIdentifiers).toContain("provider-req-1");
    expect(result.hasBlockingItems).toBe(true);
  });

  it("反馈 ack 之后的消息才重放（已 ack 不重复注入）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        feedbackCursor: { enqueueCursor: 5, deliveryCursor: 5, ackCursor: 2 },
      }),
      remainingRetryBudget: 3,
    });
    expect(result.feedbackReplayEnqueueRange).toEqual({
      fromEnqueueCursor: 3,
      toEnqueueCursor: 5,
    });
  });

  it("全部已 ack → 无重放范围", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        feedbackCursor: { enqueueCursor: 5, deliveryCursor: 5, ackCursor: 5 },
      }),
      remainingRetryBudget: 3,
    });
    expect(result.feedbackReplayEnqueueRange).toBeNull();
  });
});

describe("权限失效", () => {
  it("一次性授权恢复后失效（reauthorize-required；基础 profile 不变）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        permissionRecovery: [
          { permissionProfileReference: "assist", profileRevision: 2 },
        ],
      }),
      remainingRetryBudget: 3,
    });
    expect(result.reauthorizationRequiredTypes).toContain("session-elevation");
    expect(result.reauthorizationRequiredTypes).toContain("installation-allow-once");
    expect(result.reauthorizationRequiredTypes).toContain("backup-deletion");
  });
});

describe("分类稳定性", () => {
  it("恢复决定类型集合稳定", () => {
    expect(() =>
      RecoveryClassificationService.assertDecisionTypesStable([
        "safe-recoverable",
        "blocked-uncertain-side-effect",
        "blocked-provider-state-unknown",
        "new-handoff-identity",
        "rejected-stale-contribution",
        "reauthorize-required",
      ]),
    ).not.toThrow();
    expect(() =>
      RecoveryClassificationService.assertDecisionTypesStable(["auto-overwrite"] as never),
    ).toThrowError(/未知恢复决定类型/);
  });
});