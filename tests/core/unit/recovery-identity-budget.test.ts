/**
 * T12A-05 测试：恢复身份、handoff、任务偏序与预算。
 * 验收：回收身份不复用（新身份+handoff）；暂停沿用原身份；
 * 任务顺序按前驱/优先级重算；预算不清零。
 */
import { describe, expect, it } from "vitest";

import { RecoveryIdentityAndBudgetService } from "../../../packages/core/src/orchestration/recovery-identity-budget-service.js";
import type { RecoveryCheckpoint } from "../../../packages/core/src/orchestration/recovery-checkpoint-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeCheckpoint(overrides: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schemaVersion: 1,
    checkpointIdentifier: "checkpoint-1",
    sessionIdentifier: "session-1",
    missionIdentifier: "mission-1",
    taskChainIdentifier: "chain-1",
    agentIdentities: [
      {
        agentInstanceId: "tertiary-paused",
        agentRole: "tertiary",
        lifecycleState: "paused",
        handoffReference: null,
        parentAgentInstanceId: "secondary-1",
      },
      {
        agentInstanceId: "tertiary-reclaimed",
        agentRole: "tertiary",
        lifecycleState: "reclaimed",
        handoffReference: "handoff-from-tertiary-reclaimed",
        parentAgentInstanceId: "secondary-1",
      },
    ],
    taskNodes: [
      {
        taskNodeIdentifier: "t1",
        status: "done",
        predecessorTaskNodeIdentifiers: [],
        priorityTier: 0,
        assignedAgentInstanceId: "tertiary-paused",
        checkpointIdentifier: null,
        completionAttemptIdentifier: null,
      },
      {
        taskNodeIdentifier: "t2",
        status: "pending",
        predecessorTaskNodeIdentifiers: ["t1"],
        priorityTier: 0,
        assignedAgentInstanceId: "tertiary-reclaimed",
        checkpointIdentifier: null,
        completionAttemptIdentifier: null,
      },
      {
        taskNodeIdentifier: "t3",
        status: "pending",
        predecessorTaskNodeIdentifiers: ["t2"],
        priorityTier: 1,
        assignedAgentInstanceId: null,
        checkpointIdentifier: null,
        completionAttemptIdentifier: null,
      },
    ],
    humanChangeObservationRevision: 1,
    pendingConflictIdentifiers: [],
    toolCalls: [],
    providerRequests: [],
    feedbackCursor: { enqueueCursor: 0, deliveryCursor: 0, ackCursor: 0 },
    permissionRecovery: [],
    workingSetFileCountsByAgent: { "tertiary-paused": 7 },
    taskChainCumulativeSourceCount: 12,
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

let newIdentityCounter = 0;
function makeService() {
  const service = new RecoveryIdentityAndBudgetService();
  return {
    service,
    generateNewIdentity: (originalAgentInstanceId: string) =>
      `new-${originalAgentInstanceId}-${++newIdentityCounter}`,
  };
}

describe("身份恢复", () => {
  it("暂停 Agent 沿用原身份；回收 Agent 新身份 + handoff（不复用旧身份）", () => {
    const { service, generateNewIdentity } = makeService();
    const result = service.recoverIdentityAndBudget({
      checkpoint: makeCheckpoint(),
      generateNewIdentity,
    });
    const pausedRecovery = result.identityRecoveries.find(
      (item) => item.agentInstanceId === "tertiary-paused",
    );
    expect(pausedRecovery?.isReusingOriginalIdentity).toBe(true);
    expect(pausedRecovery?.handoffReference).toBeNull();
    const reclaimedRecovery = result.identityRecoveries.find(
      (item) => !item.isReusingOriginalIdentity,
    );
    expect(reclaimedRecovery?.agentInstanceId).toContain("new-tertiary-reclaimed");
    expect(reclaimedRecovery?.handoffReference).toContain("handoff-from-");
    expect(result.requiresHandoffIdentity).toBe(true);
  });

  it("回收身份缺 handoff → assert 拒绝", () => {
    expect(() =>
      RecoveryIdentityAndBudgetService.assertIdentityRecoveryValid({
        agentInstanceId: "tertiary-reclaimed",
        agentRole: "tertiary",
        lifecycleState: "reclaimed",
        handoffReference: null,
        parentAgentInstanceId: "secondary-1",
      }),
    ).toThrowError(/必须携带显式 handoff/);
  });
});

describe("任务偏序恢复", () => {
  it("ready set = pending 且前驱全 done（按优先级排序）", () => {
    const { service, generateNewIdentity } = makeService();
    const result = service.recoverIdentityAndBudget({
      checkpoint: makeCheckpoint(),
      generateNewIdentity,
    });
    // t2 前驱 t1 已 done → ready；t3 前驱 t2 未 done → 不 ready
    expect(result.readySetTaskNodeIdentifiers).toEqual(["t2"]);
  });
});

describe("预算恢复", () => {
  it("工作集/任务链累计/读取回执/循环/失败预算不清零", () => {
    const { service, generateNewIdentity } = makeService();
    const result = service.recoverIdentityAndBudget({
      checkpoint: makeCheckpoint(),
      generateNewIdentity,
    });
    expect(result.budgetRecovery.workingSetFileCountsByAgent).toEqual({
      "tertiary-paused": 7,
    });
    expect(result.budgetRecovery.taskChainCumulativeSourceCount).toBe(12);
    expect(result.budgetRecovery.readReceiptBudgetRestored).toBe(true);
    expect(result.budgetRecovery.cycleGuardBudgetRestored).toBe(true);
    expect(result.budgetRecovery.failureRetryBudgetRestored).toBe(true);
  });
});