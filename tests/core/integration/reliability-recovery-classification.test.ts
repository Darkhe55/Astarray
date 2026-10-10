/**
 * 行为反例（RELIABILITY-01-01 静态疑点 1，2026-10-02）：
 *
 * 卡内原文："其尾部分支返回 bounded-retry，需要核查 **started 非幂等、confirmed-success 非幂等**、
 * 零预算等输入及调用方约束，防止状态误分类。"
 *
 * 语义要求（卡内同段）：
 *  - 已确认成功**不重复副作用**（与是否幂等无关）；
 *  - 非幂等"结果未知"→ 阻塞对账，禁止自动重试；
 *  - 不得承诺通用 exactly-once，但**绝不能**把"已成功"重新执行一遍。
 *
 * 本文件在修复前必须失败。
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
    createdAtIso: "2026-10-02T00:00:00.000Z",
    writingProcessInstanceIdentifier: "process-1",
    ...overrides,
  } as RecoveryCheckpoint;
}

const service = new RecoveryClassificationService();

describe("恢复分类：已确认成功不得重放（含非幂等）", () => {
  it("① confirmed-success + 非幂等 → 必须复用结果，不得 bounded-retry", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-nonidempotent-success",
            toolName: "remote.push",
            state: "confirmed-success",
            isIdempotent: false,
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

  it("② confirmed-success + 非幂等 + 零预算 → 仍必须复用结果", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-nonidempotent-success-zero-budget",
            toolName: "remote.push",
            state: "confirmed-success",
            isIdempotent: false,
            completionAttemptIdentifier: "attempt-1",
          },
        ],
      }),
      remainingRetryBudget: 0,
    });
    expect(result.toolCallClassifications[0]?.classification).toEqual({
      category: "reuse-confirmed-result",
    });
  });

  it("③ confirmed-success + 幂等 → 复用结果（既有语义不得回归）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-idempotent-success",
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

  it("④ 非幂等 result-unknown → 仍必须阻塞对账（不得回归）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-nonidempotent-unknown",
            toolName: "remote.push",
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
  });

  it("⑤ 零预算 + confirmed-failure → 不得给 bounded-retry（预算必须生效）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-failure-zero-budget",
            toolName: "project.read",
            state: "confirmed-failure",
            isIdempotent: true,
            completionAttemptIdentifier: null,
          },
        ],
      }),
      remainingRetryBudget: 0,
    });
    expect(result.toolCallClassifications[0]?.classification.category).not.toBe(
      "bounded-retry",
    );
  });

  it("⑥ planned/started + 非幂等 → 不得判为可盲目重试（卡内点名的 started 非幂等）", () => {
    for (const state of ["planned", "started"] as const) {
      const result = service.classifyRecovery({
        checkpoint: makeCheckpoint({
          toolCalls: [
            {
              toolCallIdentifier: "tc-" + state + "-nonidempotent",
              toolName: "remote.push",
              state,
              isIdempotent: false,
              completionAttemptIdentifier: null,
            },
          ],
        }),
        remainingRetryBudget: 3,
      });
      const classification = result.toolCallClassifications[0]?.classification;
      // 非幂等：不得直接给可重试（要么阻塞对账，要么复用已确认结果）。
      expect(classification?.category).not.toBe("bounded-retry");
    }
  });

  it("⑦ planned/started + 幂等 → 允许有界重试（既有语义不得回归）", () => {
    for (const state of ["planned", "started"] as const) {
      const result = service.classifyRecovery({
        checkpoint: makeCheckpoint({
          toolCalls: [
            {
              toolCallIdentifier: "tc-" + state + "-idempotent",
              toolName: "project.read",
              state,
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
    }
  });

  /**
   * ⑧ 零预算必须**真正生效**（2026-10-10 返修，RELIABILITY-01-02）：
   *
   * 静态疑点原文要求核查"**零预算**等输入"。既有实现只对 `confirmed-failure` 分支检查了
   * `remainingRetryBudget > 0`，而**尾部分支（幂等 planned/started/result-unknown）**
   * 无条件返回 `bounded-retry` —— 即使预算为 0 也告诉调用方"可以重试"。
   * 调用方（`recovery-center-controller`）只读 `category`，不自行判预算，
   * 因此零预算下幂等操作仍会被重试：**预算失效**。
   *
   * 期望：预算为 0 时**绝不**给出可重试分类；预算充足时既有语义不变（见 ⑦）。
   */
  it("⑧ 零预算 + 幂等 planned/started/result-unknown → 绝不判为可重试", () => {
    for (const state of ["planned", "started", "result-unknown"] as const) {
      const result = service.classifyRecovery({
        checkpoint: makeCheckpoint({
          toolCalls: [
            {
              toolCallIdentifier: "tc-" + state + "-idempotent-zero-budget",
              toolName: "project.read",
              state,
              isIdempotent: true,
              completionAttemptIdentifier: null,
            },
          ],
        }),
        remainingRetryBudget: 0,
      });
      const classification = result.toolCallClassifications[0]?.classification;
      expect(classification?.category).not.toBe("bounded-retry");
      // 结果未知/未收敛的幂等调用在零预算下必须阻塞对账，不得静默重试。
      expect(classification?.category).toBe("blocked-uncertain-side-effect");
    }
  });

  it("⑨ 预算充足时幂等 result-unknown 仍可有界重试（不得过度收紧）", () => {
    const result = service.classifyRecovery({
      checkpoint: makeCheckpoint({
        toolCalls: [
          {
            toolCallIdentifier: "tc-result-unknown-idempotent",
            toolName: "project.read",
            state: "result-unknown",
            isIdempotent: true,
            completionAttemptIdentifier: null,
          },
        ],
      }),
      remainingRetryBudget: 3,
    });
    expect(result.toolCallClassifications[0]?.classification).toEqual({
      category: "bounded-retry",
      remainingRetryBudget: 3,
    });
  });
});
