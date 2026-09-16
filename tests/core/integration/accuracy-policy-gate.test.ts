/**
 * ACCURACY-03：档位/预算/开关策略、跨进程幂等与"关闭不发起校验层"反例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AccuracyCompletionGate,
  AccuracyPolicyError,
  AccuracyPolicyStore,
  FileAccuracyAttemptJournal,
  FileAccuracyVerificationAuditLog,
  resolveAccuracyTier,
  type AccuracyCompletionGatePorts,
  type AccuracyPolicy,
} from "../../../packages/core/src/orchestration/accuracy-policy-store.js";
import type {
  AcceptanceEntry,
  CompletionDeclaration,
  EvidenceReference,
} from "../../../packages/core/src/orchestration/task-accuracy-verifier.js";

const NOW = "2026-09-16T00:00:00.000Z";
let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-accuracy-gate-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const ACCEPTANCE_ENTRIES: AcceptanceEntry[] = [
  {
    entryIdentifier: "entry-1",
    description: "公共入口真实调用控制器",
    isRequired: true,
    evidenceRequirement: "test-report",
  },
];

function evidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    evidenceIdentifier: "evidence-1",
    entryIdentifier: "entry-1",
    evidenceKind: "test-report",
    contentHash: "sha256:abc",
    producedAtRevision: 3,
    producedByAgentInstanceId: "tertiary-1",
    observedAtIso: NOW,
    ...overrides,
  };
}

function declaration(
  overrides: Partial<CompletionDeclaration> = {},
): CompletionDeclaration {
  return {
    taskIdentifier: "task-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 3,
    completedEntryIdentifiers: ["entry-1"],
    evidenceReferences: [evidence()],
    understandingConfirmation: {
      restatedGoal: "公共入口必须真实调用控制器并产出可核验证据",
      confirmedAtIso: NOW,
    },
    deliveredToRecipientIdentifier: "user-1",
    ...overrides,
  };
}

function createPorts(overrides: {
  throwOnCall?: boolean;
  currentTaskSequenceRevision?: number;
  expectedRecipientIdentifier?: string;
  currentArtifactRevision?: number | null;
  isClarificationRequired?: boolean;
} = {}): AccuracyCompletionGatePorts {
  const refuse = (): never => {
    throw new Error("关闭状态下验收端口不应被调用");
  };
  const isEnabled = overrides.throwOnCall !== true;
  return {
    getAcceptanceEntries: async () => (isEnabled ? ACCEPTANCE_ENTRIES : refuse()),
    getCurrentTaskSequenceRevision: async () =>
      isEnabled ? overrides.currentTaskSequenceRevision ?? 3 : refuse(),
    getExpectedRecipientIdentifier: async () =>
      isEnabled ? overrides.expectedRecipientIdentifier ?? "user-1" : refuse(),
    getArtifactRevision: async () =>
      isEnabled ? overrides.currentArtifactRevision ?? 3 : refuse(),
    isClarificationRequired: async () =>
      isEnabled ? overrides.isClarificationRequired ?? false : refuse(),
  };
}

function createGate(ports: AccuracyCompletionGatePorts, store: AccuracyPolicyStore) {
  const auditLog = new FileAccuracyVerificationAuditLog({ baseDirectory });
  const journal = new FileAccuracyAttemptJournal({ baseDirectory });
  return {
    gate: new AccuracyCompletionGate({
      policyStore: store,
      journal,
      auditLog,
      ports,
      nowIso: () => NOW,
    }),
    auditLog,
    journal,
  };
}

describe("ACCURACY-03 策略存储与预算", () => {
  it("默认策略为标准档 + 开启 + 明确预算上界；仅认证用户可配置", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    const defaultPolicy = await store.readPolicy();
    expect(defaultPolicy).toMatchObject({
      isEnabled: true,
      tier: "standard",
      revision: 1,
      budget: {
        maximumModelCallCount: expect.any(Number),
        maximumWallClockMilliseconds: expect.any(Number),
      },
    });
    expect(defaultPolicy.budget.maximumModelCallCount).toBeGreaterThan(0);

    const configured = await store.configurePolicy({
      tier: "strict",
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });
    expect(configured.tier).toBe("strict");
    expect(configured.revision).toBe(2);

    // 跨进程：新实例（另一进程）读到持久化后的策略。
    const anotherProcess = new AccuracyPolicyStore({
      baseDirectory,
      nowIso: () => NOW,
    });
    expect(await anotherProcess.readPolicy()).toMatchObject({
      tier: "strict",
      revision: 2,
    });
  }, 60_000);

  it("Agent 请求降级或关闭被拒绝；用户升级通过；过期 revision 拒绝", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    await store.configurePolicy({
      tier: "strict",
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });

    await expect(
      store.configurePolicy({
        tier: "fast",
        expectedRevision: 2,
        updatedByUserId: "agent-1",
        requestingAgentInstanceId: "agent-1",
      }),
    ).rejects.toMatchObject({ errorCode: "accuracy-tier-downgrade-rejected" });

    await expect(
      store.configurePolicy({
        isEnabled: false,
        expectedRevision: 2,
        updatedByUserId: "agent-1",
        requestingAgentInstanceId: "agent-1",
      }),
    ).rejects.toMatchObject({ errorCode: "accuracy-tier-downgrade-rejected" });

    // Agent 升级不构成降级，允许（仍受 revision 约束）。
    const upgraded = await store.configurePolicy({
      tier: "strict",
      budget: { maximumModelCallCount: 2 },
      expectedRevision: 2,
      updatedByUserId: "agent-1",
      requestingAgentInstanceId: "agent-1",
    });
    expect(upgraded.budget.maximumModelCallCount).toBe(2);

    await expect(
      store.configurePolicy({
        tier: "strict",
        expectedRevision: 1,
        updatedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "accuracy-policy-stale-revision" });

    await expect(
      new AccuracyPolicyError("accuracy-tier-downgrade-rejected", "x"),
    ).toBeInstanceOf(Error);
  }, 60_000);

  it("任务级覆盖只影响该任务", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    const policy: AccuracyPolicy = await store.configurePolicy({
      tier: "strict",
      taskTierOverrides: { "task-fast": "fast" },
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });
    expect(resolveAccuracyTier(policy, "task-1")).toBe("strict");
    expect(resolveAccuracyTier(policy, "task-fast")).toBe("fast");
  }, 60_000);
});

describe("ACCURACY-03 完成校验门", () => {
  it("关闭时返回独立跳过状态，且不调用任何验收端口（不发起校验层）", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    await store.configurePolicy({
      isEnabled: false,
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });
    const { gate, auditLog } = createGate(createPorts({ throwOnCall: true }), store);

    const result = await gate.verifyCompletion({ declaration: declaration() });
    expect(result.verdict).toBe("quality-check-skipped");
    expect(result.isSkipped).toBe(true);
    expect(result.skipReason).toBe("accuracy-disabled");
    expect(result.reasons.join(" ")).toContain("accuracy-disabled");
    expect(result.verification).toBeNull();

    const audit = await auditLog.readAll();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      isVerificationLayerInvoked: false,
      verdict: "quality-check-skipped",
      skipReason: "accuracy-disabled",
    });
  }, 60_000);

  it("标准档真实校验一次；预算耗尽后记录检查不足而不是通过", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    await store.configurePolicy({
      tier: "standard",
      budget: { maximumModelCallCount: 1 },
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });
    const { gate, auditLog } = createGate(createPorts(), store);

    const first = await gate.verifyCompletion({
      declaration: declaration({ completionAttemptId: "attempt-1" }),
    });
    expect(first.verdict).toBe("accepted");
    expect(first.budgetStatus).toBe("within-budget");

    const second = await gate.verifyCompletion({
      declaration: declaration({ completionAttemptId: "attempt-2" }),
    });
    expect(second.verdict).toBe("quality-check-skipped");
    expect(second.budgetStatus).toBe("quality-check-budget-exhausted");
    expect(second.reasons.join(" ")).toContain("quality-check-budget-exhausted");

    const audit = await auditLog.readAll();
    expect(audit.map((record) => record.isVerificationLayerInvoked)).toEqual([
      true,
      false,
    ]);

    // 跨进程：预算消耗从审计日志恢复，另一个进程不会重置上界。
    const { gate: secondProcessGate } = createGate(createPorts(), store);
    const afterRestart = await secondProcessGate.verifyCompletion({
      declaration: declaration({ completionAttemptId: "attempt-3" }),
    });
    expect(afterRestart.budgetStatus).toBe("quality-check-budget-exhausted");
  }, 60_000);

  it("快速档返回独立跳过状态，结构性问题仍拒绝", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    await store.configurePolicy({
      tier: "fast",
      expectedRevision: 1,
      updatedByUserId: "user-1",
    });
    const { gate } = createGate(createPorts(), store);
    const skipped = await gate.verifyCompletion({ declaration: declaration() });
    expect(skipped.verdict).toBe("quality-check-skipped");
    expect(skipped.skipReason).toBe("tier-fast");

    const wrongRecipient = await gate.verifyCompletion({
      declaration: declaration({
        completionAttemptId: "attempt-wrong",
        deliveredToRecipientIdentifier: "user-2",
      }),
    });
    expect(wrongRecipient.verdict).toBe("rejected");
    expect(wrongRecipient.reasons.join(" ")).toContain("wrong-recipient");
  }, 60_000);

  it("同一 completionAttemptId 重放返回既有结论且跨进程可识别", async () => {
    const store = new AccuracyPolicyStore({ baseDirectory, nowIso: () => NOW });
    const { gate, journal } = createGate(createPorts(), store);
    const first = await gate.verifyCompletion({ declaration: declaration() });
    expect(first.verdict).toBe("accepted");
    expect(first.verification?.isIdempotentReplay).toBe(false);
    expect(await journal.size()).toBe(1);

    // 重放：不重新执行校验，返回既有结论。
    const replay = await gate.verifyCompletion({ declaration: declaration() });
    expect(replay.verification?.isIdempotentReplay).toBe(true);
    expect(replay.verdict).toBe("accepted");

    const anotherProcessJournal = new FileAccuracyAttemptJournal({ baseDirectory });
    expect(await anotherProcessJournal.findProcessedAttempt("attempt-1")).toMatchObject({
      verdict: "accepted",
    });
  }, 60_000);
});
