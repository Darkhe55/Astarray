/**
 * T12A-07 测试：故障注入恢复验证。
 * 验收：5 个中断点可恢复；已确认调用不重复；旧 Provider 不并行；
 * 预算不清零；孤儿资源收口需所有权确认。
 */
import { describe, expect, it } from "vitest";

import { FaultInjectionRecoveryVerifier } from "../../../packages/core/src/orchestration/fault-injection-recovery-verifier.js";
import { RecoveryClassificationService } from "../../../packages/core/src/orchestration/recovery-classification-service.js";
import { RecoveryIdentityAndBudgetService } from "../../../packages/core/src/orchestration/recovery-identity-budget-service.js";
import type { RecoveryCheckpoint } from "../../../packages/core/src/orchestration/recovery-checkpoint-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeCheckpoint(overrides: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schemaVersion: 1,
    checkpointIdentifier: "checkpoint-fault",
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
    taskNodes: [],
    humanChangeObservationRevision: 1,
    pendingConflictIdentifiers: [],
    toolCalls: [
      {
        toolCallIdentifier: "tc-confirmed",
        toolName: "project.read",
        state: "confirmed-success",
        isIdempotent: true,
        completionAttemptIdentifier: "attempt-1",
      },
      {
        toolCallIdentifier: "tc-unknown",
        toolName: "network.post",
        state: "result-unknown",
        isIdempotent: false,
        completionAttemptIdentifier: null,
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
    feedbackCursor: { enqueueCursor: 3, deliveryCursor: 3, ackCursor: 2 },
    permissionRecovery: [{ permissionProfileReference: "assist", profileRevision: 2 }],
    workingSetFileCountsByAgent: { "tertiary-1": 5 },
    taskChainCumulativeSourceCount: 9,
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

function makeVerifier() {
  const verifier = new FaultInjectionRecoveryVerifier({
    classificationService: new RecoveryClassificationService(),
    identityBudgetService: new RecoveryIdentityAndBudgetService(),
  });
  return { verifier };
}

describe("FaultInjectionRecoveryVerifier 多中断点", () => {
  const injectionPoints = [
    "before-task-write",
    "after-tool-execution-before-persistence",
    "after-feedback-deliver-before-ack",
    "mid-provider-stream",
    "before-git-merge",
  ] as const;

  for (const injectionPoint of injectionPoints) {
    it(`${injectionPoint} 中断点恢复：已确认调用复用/旧 Provider 阻塞/预算不清零`, () => {
      const { verifier } = makeVerifier();
      const result = verifier.verifyRecoveryAtInjectionPoint({
        injectionPoint,
        checkpoint: makeCheckpoint(),
        generateNewIdentity: (id) => `new-${id}`,
      });
      expect(result.confirmedCallsReused).toBe(true);
      expect(result.providerRequestsBlocked).toBe(true);
      expect(result.budgetsPreserved).toBe(true);
      expect(result.orphansReclaimedWithOwnershipCheck).toBe(true);
      expect(result.isRecoverable).toBe(true);
    });
  }
});

describe("FaultInjectionRecoveryVerifier 无重复副作用", () => {
  it("已确认调用被复用（分类为 reuse-confirmed-result，不重复执行）", () => {
    const { verifier } = makeVerifier();
    const result = verifier.verifyRecoveryAtInjectionPoint({
      injectionPoint: "after-tool-execution-before-persistence",
      checkpoint: makeCheckpoint(),
      generateNewIdentity: (id) => `new-${id}`,
    });
    expect(result.confirmedCallsReused).toBe(true);
  });

  it("非幂等结果未知项分类为 blocked（不自动重试）", () => {
    const classification = new RecoveryClassificationService().classifyRecovery({
      checkpoint: makeCheckpoint(),
      remainingRetryBudget: 3,
    });
    const unknownCall = classification.toolCallClassifications.find(
      (item) => item.toolCallIdentifier === "tc-unknown",
    );
    expect(unknownCall?.classification.category).toBe(
      "blocked-uncertain-side-effect",
    );
  });
});

describe("FaultInjectionRecoveryVerifier 孤儿资源收口", () => {
  it("所有权匹配 → 收口允许；不匹配 → 拒绝（先备份）", () => {
    expect(() =>
      FaultInjectionRecoveryVerifier.assertOrphanOwnershipConfirmed({
        ownerIdentifier: "tertiary-1",
        expectedOwner: "tertiary-1",
      }),
    ).not.toThrow();
    expect(() =>
      FaultInjectionRecoveryVerifier.assertOrphanOwnershipConfirmed({
        ownerIdentifier: "tertiary-1",
        expectedOwner: "attacker",
      }),
    ).toThrowError(/所有权不匹配/);
  });
});