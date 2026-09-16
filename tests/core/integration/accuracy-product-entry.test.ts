/**
 * ACCURACY-03：公共入口（策略配置 + 完成校验 + 审计）——关闭不新增模型审查/人工阻塞、
 * 权限路由不受影响、严格档受预算约束、跨进程幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import {
  AstarrayApplicationFacade,
  PublicApplicationError,
  type PublicAcceptanceEntry,
  type PublicEvidenceReference,
} from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-accuracy-entry-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory: baseDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  const facade = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory: baseDirectory,
  });
  facade.createSession({ sessionId: "session-1", mode: "assist" });
  return facade;
}

const ACCEPTANCE_ENTRIES: PublicAcceptanceEntry[] = [
  {
    entryIdentifier: "entry-1",
    description: "公共入口真实调用控制器",
    isRequired: true,
    evidenceRequirement: "test-report",
  },
];

function evidence(
  overrides: Partial<PublicEvidenceReference> = {},
): PublicEvidenceReference {
  return {
    evidenceIdentifier: "evidence-1",
    entryIdentifier: "entry-1",
    evidenceKind: "test-report",
    contentHash: "sha256:abc",
    producedAtRevision: 3,
    producedByAgentInstanceId: "tertiary-1",
    observedAtIso: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function completionInput(overrides: Record<string, unknown> = {}) {
  return {
    taskIdentifier: "task-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 3,
    completedEntryIdentifiers: ["entry-1"],
    evidenceReferences: [evidence()],
    deliveredToRecipientIdentifier: "user-1",
    understandingConfirmation: {
      restatedGoal: "公共入口必须真实调用控制器并产出可核验证据",
      confirmedAtIso: "2026-09-16T00:00:00.000Z",
    },
    acceptanceEntries: ACCEPTANCE_ENTRIES,
    currentArtifactRevisions: { "evidence-1": 3 },
    ...overrides,
  };
}

describe("ACCURACY-03 公共入口", () => {
  it("默认标准档；认证用户配置跨进程可见；Agent 降级被拒绝", async () => {
    const first = await createFacade();
    try {
      const defaultPolicy = await first.queryAccuracyPolicy();
      expect(defaultPolicy).toMatchObject({ isEnabled: true, tier: "standard", revision: 1 });

      const configured = await first.configureAccuracyPolicy({
        tier: "strict",
        maximumModelCallCount: 2,
        expectedRevision: defaultPolicy.revision,
        updatedByUserId: "user-1",
      });
      expect(configured).toMatchObject({
        tier: "strict",
        revision: 2,
        budget: { maximumModelCallCount: 2 },
      });

      await expect(
        first.configureAccuracyPolicy({
          tier: "fast",
          expectedRevision: configured.revision,
          requestingAgentInstanceId: "secondary-agent-1",
        }),
      ).rejects.toMatchObject({ errorCode: "accuracy-tier-downgrade-rejected" });

      await expect(
        first.configureAccuracyPolicy({
          tier: "strict",
          expectedRevision: 1,
          updatedByUserId: "user-1",
        }),
      ).rejects.toMatchObject({ errorCode: "accuracy-policy-stale-revision" });
    } finally {
      await first.shutdown();
    }

    // 新进程：配置已持久化。
    const second = await createFacade();
    try {
      expect(await second.queryAccuracyPolicy()).toMatchObject({
        tier: "strict",
        revision: 2,
      });
    } finally {
      await second.shutdown();
    }
  }, 90_000);

  it("关闭后不发起校验层、不新增人工阻塞，且权限路由不变", async () => {
    const facade = await createFacade();
    try {
      const current = await facade.queryAccuracyPolicy();
      const permissionBefore = await facade.getCurrentPermissionProfileReference();
      await facade.configureAccuracyPolicy({
        isEnabled: false,
        expectedRevision: current.revision,
        updatedByUserId: "user-1",
      });

      expect(await facade.getCurrentPermissionProfileReference()).toEqual(permissionBefore);
      expect(await facade.listPendingVerifications()).toEqual([]);

      const result = await facade.verifyTaskCompletion(completionInput());
      expect(result).toMatchObject({
        verdict: "quality-check-skipped",
        isSkipped: true,
        skipReason: "accuracy-disabled",
      });
      expect(result.reasons.join(" ")).toContain("accuracy-disabled");

      const audit = await facade.queryAccuracyVerificationAudit({
        taskIdentifier: "task-1",
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ isVerificationLayerInvoked: false });
      // 关闭时没有新增人工阻塞任务。
      expect(await facade.listPendingVerifications()).toEqual([]);
      expect(await facade.getCurrentPermissionProfileReference()).toEqual(permissionBefore);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("严格档完整声明通过；重放幂等且跨进程可识别", async () => {
    const first = await createFacade();
    try {
      await first.configureAccuracyPolicy({
        tier: "strict",
        maximumModelCallCount: 4,
        expectedRevision: (await first.queryAccuracyPolicy()).revision,
        updatedByUserId: "user-1",
      });
      const accepted = await first.verifyTaskCompletion(completionInput());
      expect(accepted).toMatchObject({
        verdict: "accepted",
        tier: "strict",
        isSkipped: false,
        isIdempotentReplay: false,
      });
    } finally {
      await first.shutdown();
    }

    const second = await createFacade();
    try {
      const replay = await second.verifyTaskCompletion(completionInput());
      expect(replay).toMatchObject({ verdict: "accepted", isIdempotentReplay: true });
      const audit = await second.queryAccuracyVerificationAudit();
      // 重放不再产生新的校验层调用记录。
      expect(audit.filter((record) => record.isVerificationLayerInvoked)).toHaveLength(1);
    } finally {
      await second.shutdown();
    }
  }, 90_000);

  it("错收件人、缺必需条目与陈旧产物一律拒绝", async () => {
    const facade = await createFacade();
    try {
      await facade.configureAccuracyPolicy({
        tier: "strict",
        expectedRevision: (await facade.queryAccuracyPolicy()).revision,
        updatedByUserId: "user-1",
      });

      const wrongRecipient = await facade.verifyTaskCompletion(
        completionInput({
          completionAttemptId: "attempt-wrong-recipient",
          deliveredToRecipientIdentifier: "user-2",
        }),
      );
      expect(wrongRecipient.verdict).toBe("rejected");
      expect(wrongRecipient.reasons.join(" ")).toContain("wrong-recipient");

      const missingEntry = await facade.verifyTaskCompletion(
        completionInput({
          completionAttemptId: "attempt-missing-entry",
          completedEntryIdentifiers: [],
        }),
      );
      expect(missingEntry.verdict).toBe("rejected");
      expect(missingEntry.reasons.join(" ")).toContain("required-entry-missing");

      const staleArtifact = await facade.verifyTaskCompletion(
        completionInput({
          completionAttemptId: "attempt-stale-artifact",
          currentArtifactRevisions: { "evidence-1": 9 },
        }),
      );
      expect(staleArtifact.verdict).toBe("rejected");
      expect(staleArtifact.reasons.join(" ")).toContain("stale-artifact");

      const noUnderstanding = await facade.verifyTaskCompletion(
        completionInput({
          completionAttemptId: "attempt-no-understanding",
          understandingConfirmation: null,
        }),
      );
      expect(noUnderstanding.verdict).toBe("rejected");
      expect(noUnderstanding.reasons.join(" ")).toContain(
        "understanding-confirmation-missing",
      );
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("任务级覆盖把单任务降为快速档（不影响其他任务）", async () => {
    const facade = await createFacade();
    try {
      await facade.configureAccuracyPolicy({
        tier: "strict",
        taskTierOverrides: { "task-fast": "fast" },
        expectedRevision: (await facade.queryAccuracyPolicy()).revision,
        updatedByUserId: "user-1",
      });
      const fastTask = await facade.verifyTaskCompletion(
        completionInput({ taskIdentifier: "task-fast", completionAttemptId: "attempt-fast" }),
      );
      expect(fastTask).toMatchObject({ tier: "fast", skipReason: "tier-fast" });

      const strictTask = await facade.verifyTaskCompletion(
        completionInput({ completionAttemptId: "attempt-strict" }),
      );
      expect(strictTask).toMatchObject({ tier: "strict", verdict: "accepted" });
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("公共入口拒绝在关闭前的陈旧 revision 配置且不落盘", async () => {
    const facade = await createFacade();
    try {
      await expect(
        facade.configureAccuracyPolicy({
          tier: "strict",
          expectedRevision: 99,
          updatedByUserId: "user-1",
        }),
      ).rejects.toBeInstanceOf(PublicApplicationError);
      expect(await facade.queryAccuracyPolicy()).toMatchObject({
        tier: "standard",
        revision: 1,
      });
    } finally {
      await facade.shutdown();
    }
  }, 90_000);
});
