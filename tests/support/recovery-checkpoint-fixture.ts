/**
 * 共享测试夹具：合法恢复检查点（T12A 系列）。
 */
import type { RecoveryCheckpoint } from "../../packages/core/src/orchestration/recovery-checkpoint-schemas.js";

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

export function makeRecoveryCheckpoint(
  missionIdentifier: string,
  overrides: Record<string, unknown> = {},
): RecoveryCheckpoint {
  return {
    schemaVersion: 1,
    checkpointIdentifier: "checkpoint-1",
    sessionIdentifier: "session-1",
    missionIdentifier,
    taskChainIdentifier: "chain-1",
    agentIdentities: [],
    taskNodes: [],
    humanChangeObservationRevision: 1,
    pendingConflictIdentifiers: [],
    toolCalls: [],
    providerRequests: [],
    feedbackCursor: { enqueueCursor: 0, deliveryCursor: 0, ackCursor: 0 },
    permissionRecovery: [],
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
  } as RecoveryCheckpoint;
}
