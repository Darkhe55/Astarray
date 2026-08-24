/**
 * T05D-05 测试：次级协调返修与受控合并。
 * 验收：无静默选边（内容来源显式声明）；旧验收在提交/基线变化后失效；
 * 来源可追溯；协调失败用新身份 + 显式 handoff，不复用旧验收。
 */
import { describe, expect, it } from "vitest";

import { ConcurrentMergeCoordinator } from "../../../packages/core/src/orchestration/concurrent-merge-coordinator.js";

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    bindingIdentifier: "binding-1",
    targetBranchName: "main",
    targetBranchHeadCommit: "target-1",
    humanHeadCommit: "human-1",
    agentBaseCommit: "base-1",
    contributionHeadCommit: "contrib-1",
    testEvidenceCommit: "test-evidence-1",
    acceptanceVerdictIdentifier: "verdict-1",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function makeCoordinator() {
  let counter = 0;
  const coordinator = new ConcurrentMergeCoordinator({
    reconcileAgentIdentityPort: {
      generateReconcileAgentInstanceId: (conflictIdentifier) =>
        `reconcile-${conflictIdentifier}-${++counter}`,
    },
  });
  return { coordinator };
}

describe("ConcurrentMergeCoordinator 协调 Agent 任命", () => {
  it("任命协调 Agent：新身份不可复用、与原实现者不同", () => {
    const { coordinator } = makeCoordinator();
    const appointment = coordinator.appointReconcileAgent({
      conflictIdentifier: "conflict-1",
      originalImplementerAgentInstanceId: "tertiary-impl-1",
      previousAppointmentFailed: false,
    });
    expect(appointment.reconcileAgentInstanceId).toBe("reconcile-conflict-1-1");
    expect(appointment.originalImplementerAgentInstanceId).toBe("tertiary-impl-1");
    expect(appointment.handoffReference).toBeNull();
  });

  it("协调失败 → 新身份 + 显式 handoff（不复用旧协调 Agent）", () => {
    const { coordinator } = makeCoordinator();
    coordinator.appointReconcileAgent({
      conflictIdentifier: "conflict-1",
      originalImplementerAgentInstanceId: "tertiary-impl-1",
      previousAppointmentFailed: false,
    });
    const retry = coordinator.appointReconcileAgent({
      conflictIdentifier: "conflict-1",
      originalImplementerAgentInstanceId: "tertiary-impl-1",
      previousAppointmentFailed: true,
    });
    expect(retry.reconcileAgentInstanceId).toBe("reconcile-conflict-1-2");
    expect(retry.handoffReference).toContain("handoff-from-");
  });
});

describe("ConcurrentMergeCoordinator 受控合并门禁", () => {
  it("七要素一致 + 显式声明 → 可合并（来源可追溯）", async () => {
    const { coordinator } = makeCoordinator();
    const result = await coordinator.evaluateControlledMerge({
      binding: makeBinding(),
      currentState: {
        targetBranchHeadCommit: "target-1",
        humanHeadCommit: "human-1",
        agentBaseCommit: "base-1",
        contributionHeadCommit: "contrib-1",
        testEvidenceCommit: "test-evidence-1",
        acceptanceVerdictIdentifier: "verdict-1",
      },
      contentResolution: {
        adoptedSource: "human-content",
        reconcileAgentInstanceId: null,
      },
    });
    expect(result).toEqual({
      isMergeReady: true,
      adoptedSource: "human-content",
    });
  });

  it("任一要素变化 → 旧 merge-ready 失效（无静默合并）", async () => {
    const { coordinator } = makeCoordinator();
    const baseCurrentState = {
      targetBranchHeadCommit: "target-1",
      humanHeadCommit: "human-1",
      agentBaseCommit: "base-1",
      contributionHeadCommit: "contrib-1",
      testEvidenceCommit: "test-evidence-1",
      acceptanceVerdictIdentifier: "verdict-1",
    };
    const cases: Array<Partial<typeof baseCurrentState>> = [
      { humanHeadCommit: "human-2" },
      { contributionHeadCommit: "contrib-2" },
      { acceptanceVerdictIdentifier: "verdict-2" },
      { testEvidenceCommit: "test-evidence-2" },
    ];
    for (const change of cases) {
      const result = await coordinator.evaluateControlledMerge({
        binding: makeBinding(),
        currentState: { ...baseCurrentState, ...change },
        contentResolution: {
          adoptedSource: "human-content",
          reconcileAgentInstanceId: null,
        },
      });
      expect(result.isMergeReady).toBe(false);
    }
  });

  it("声明采用协调内容但未指定协调 Agent → 拒绝（来源不可追溯）", async () => {
    const { coordinator } = makeCoordinator();
    const result = await coordinator.evaluateControlledMerge({
      binding: makeBinding(),
      currentState: {
        targetBranchHeadCommit: "target-1",
        humanHeadCommit: "human-1",
        agentBaseCommit: "base-1",
        contributionHeadCommit: "contrib-1",
        testEvidenceCommit: "test-evidence-1",
        acceptanceVerdictIdentifier: "verdict-1",
      },
      contentResolution: {
        adoptedSource: "reconcile-agent-content",
        reconcileAgentInstanceId: null,
      },
    });
    expect(result.isMergeReady).toBe(false);
    if (!result.isMergeReady) {
      expect(result.blockedReasons.join(";")).toContain("来源不可追溯");
    }
  });

  it("声明采用协调内容 + 指定协调 Agent → 可合并", async () => {
    const { coordinator } = makeCoordinator();
    const result = await coordinator.evaluateControlledMerge({
      binding: makeBinding(),
      currentState: {
        targetBranchHeadCommit: "target-1",
        humanHeadCommit: "human-1",
        agentBaseCommit: "base-1",
        contributionHeadCommit: "contrib-1",
        testEvidenceCommit: "test-evidence-1",
        acceptanceVerdictIdentifier: "verdict-1",
      },
      contentResolution: {
        adoptedSource: "reconcile-agent-content",
        reconcileAgentInstanceId: "reconcile-conflict-1-1",
      },
    });
    expect(result).toEqual({
      isMergeReady: true,
      adoptedSource: "reconcile-agent-content",
    });
  });
});