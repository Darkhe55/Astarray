/**
 * ACCURACY-02：幂等签收、理解确认与"条目 → 证据"覆盖反例。
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryAccuracyAttemptJournal,
  TaskAccuracyVerifier,
  type AcceptanceEntry,
  type AccuracyVerifierPorts,
  type CompletionDeclaration,
  type EvidenceReference,
} from "../../../packages/core/src/orchestration/task-accuracy-verifier.js";

const ENTRIES: AcceptanceEntry[] = [
  {
    entryIdentifier: "E1",
    description: "产物 A",
    isRequired: true,
    evidenceRequirement: "artifact",
  },
  {
    entryIdentifier: "E2",
    description: "测试回执",
    isRequired: true,
    evidenceRequirement: "test-report",
  },
  {
    entryIdentifier: "E3",
    description: "可选说明",
    isRequired: false,
    evidenceRequirement: "any",
  },
];

const artifactRevisions = new Map<string, number>([
  ["artifact-1", 3],
  ["test-1", 5],
]);

function createPorts(
  overrides: Partial<AccuracyVerifierPorts> = {},
): AccuracyVerifierPorts {
  return {
    getCurrentTaskSequenceRevision: async () => 5,
    getRequiredAcceptanceEntries: async () => ENTRIES,
    getArtifactRevision: async (evidence: EvidenceReference) =>
      artifactRevisions.get(evidence.evidenceIdentifier) ?? null,
    getExpectedRecipientIdentifier: async () => "secondary-1",
    getTier: async () => "standard",
    isClarificationRequired: async () => false,
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    evidenceIdentifier: "artifact-1",
    entryIdentifier: "E1",
    evidenceKind: "artifact",
    contentHash: "sha256:aaa",
    producedAtRevision: 3,
    producedByAgentInstanceId: "tertiary-1",
    observedAtIso: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function declaration(
  overrides: Partial<CompletionDeclaration> = {},
): CompletionDeclaration {
  return {
    taskIdentifier: "T-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 5,
    completedEntryIdentifiers: ["E1", "E2"],
    evidenceReferences: [
      evidence(),
      evidence({
        evidenceIdentifier: "test-1",
        entryIdentifier: "E2",
        evidenceKind: "test-report",
        producedAtRevision: 5,
      }),
    ],
    deliveredToRecipientIdentifier: "secondary-1",
    ...overrides,
  };
}

describe("ACCURACY-02 幂等签收与证据覆盖", () => {
  it("正常完成：条目覆盖 + 真实证据 + 版本一致 → accepted", async () => {
    const verifier = new TaskAccuracyVerifier(createPorts());
    const result = await verifier.verifyCompletion(declaration());
    expect(result.verdict).toBe("accepted");
    expect(result.coveredEntryIdentifiers).toEqual(["E1", "E2"]);
    expect(result.tier).toBe("standard");
  });

  it("错收件人拒绝", async () => {
    const verifier = new TaskAccuracyVerifier(createPorts());
    const result = await verifier.verifyCompletion(
      declaration({ deliveredToRecipientIdentifier: "secondary-9" }),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.reasons.join(" ")).toContain("wrong-recipient");
  });

  it("重复派发幂等：同 attemptId 返回既有结论且不重复副作用", async () => {
    const journal = new InMemoryAccuracyAttemptJournal();
    const verifier = new TaskAccuracyVerifier(
      createPorts({
        findProcessedAttempt: (attemptId) => journal.findProcessedAttempt(attemptId),
        recordProcessedAttempt: (attemptId, result) =>
          journal.recordProcessedAttempt(attemptId, result),
      }),
    );
    const first = await verifier.verifyCompletion(declaration());
    expect(first.verdict).toBe("accepted");
    expect(first.isIdempotentReplay).toBe(false);

    const second = await verifier.verifyCompletion(declaration());
    expect(second.verdict).toBe("accepted");
    expect(second.isIdempotentReplay).toBe(true);
    expect(journal.size()).toBe(1);
  });

  it("崩溃重启后仍能识别重复派发（日志可恢复）", async () => {
    const journal = new InMemoryAccuracyAttemptJournal();
    const ports = createPorts({
      findProcessedAttempt: (attemptId) => journal.findProcessedAttempt(attemptId),
      recordProcessedAttempt: (attemptId, result) =>
        journal.recordProcessedAttempt(attemptId, result),
    });
    const firstVerifier = new TaskAccuracyVerifier(ports);
    await firstVerifier.verifyCompletion(declaration());

    // 模拟崩溃重启：新建 verifier，共享持久化日志。
    const restartedVerifier = new TaskAccuracyVerifier(ports);
    const replayed = await restartedVerifier.verifyCompletion(declaration());
    expect(replayed.isIdempotentReplay).toBe(true);
    expect(replayed.verdict).toBe("accepted");
  });

  it("旧版本与未来版本分别拒绝", async () => {
    const verifier = new TaskAccuracyVerifier(createPorts());
    const stale = await verifier.verifyCompletion(
      declaration({ taskSequenceRevision: 4, completionAttemptId: "attempt-stale" }),
    );
    expect(stale.reasons.join(" ")).toContain("stale-revision");

    const future = await verifier.verifyCompletion(
      declaration({ taskSequenceRevision: 6, completionAttemptId: "attempt-future" }),
    );
    expect(future.verdict).toBe("rejected");
    expect(future.reasons.join(" ")).toContain("future-revision");
  });

  it("伪造证据：缺指纹与严格档下的模型自述均拒绝", async () => {
    const standardVerifier = new TaskAccuracyVerifier(createPorts());
    const noHash = await standardVerifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-nohash",
        evidenceReferences: [
          evidence({ contentHash: null }),
          evidence({
            evidenceIdentifier: "test-1",
            entryIdentifier: "E2",
            evidenceKind: "test-report",
            producedAtRevision: 5,
          }),
        ],
      }),
    );
    expect(noHash.verdict).toBe("rejected");
    expect(noHash.forgedEvidenceIdentifiers).toEqual(["artifact-1"]);

    const strictVerifier = new TaskAccuracyVerifier(
      createPorts({ getTier: async () => "strict" }),
    );
    const modelClaim = await strictVerifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-model-claim",
        understandingConfirmation: {
          restatedGoal: "复述目标",
          confirmedAtIso: "2026-09-16T00:00:00.000Z",
        },
        evidenceReferences: [
          evidence({ evidenceKind: "model-claim", contentHash: null }),
          evidence({
            evidenceIdentifier: "test-1",
            entryIdentifier: "E2",
            evidenceKind: "test-report",
            producedAtRevision: 5,
          }),
        ],
      }),
    );
    expect(modelClaim.verdict).toBe("rejected");
    expect(modelClaim.forgedEvidenceIdentifiers).toEqual(["artifact-1"]);
  });

  it("陈旧产物：证据之后产物又被修改 → 拒绝", async () => {
    const verifier = new TaskAccuracyVerifier(
      createPorts({
        getArtifactRevision: async (reference) =>
          reference.evidenceIdentifier === "artifact-1" ? 9 : 5,
      }),
    );
    const result = await verifier.verifyCompletion(declaration());
    expect(result.verdict).toBe("rejected");
    expect(result.staleEvidenceIdentifiers).toEqual(["artifact-1"]);
    expect(result.reasons.join(" ")).toContain("stale-artifact");
  });

  it("空证据与必需条目漏报分别拒绝（部分完成只报告进度）", async () => {
    const verifier = new TaskAccuracyVerifier(createPorts());
    const emptyEvidence = await verifier.verifyCompletion(
      declaration({ completionAttemptId: "attempt-empty", evidenceReferences: [] }),
    );
    expect(emptyEvidence.reasons.join(" ")).toContain("empty-evidence");

    const partial = await verifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-partial",
        completedEntryIdentifiers: ["E1"],
      }),
    );
    expect(partial.verdict).toBe("rejected");
    expect(partial.missingRequiredEntryIdentifiers).toEqual(["E2"]);
    expect(partial.coveredEntryIdentifiers).toEqual(["E1"]);
    expect(partial.reasons.join(" ")).toContain("required-entry-missing");
  });

  it("快速档返回 independent quality-check-skipped（不得写成通过）", async () => {
    const verifier = new TaskAccuracyVerifier(
      createPorts({ getTier: async () => "fast" }),
    );
    const result = await verifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-fast",
        completedEntryIdentifiers: [],
        evidenceReferences: [],
      }),
    );
    expect(result.verdict).toBe("quality-check-skipped");
    expect(result.reasons.join(" ")).toContain("快速档跳过质量门禁");
    expect(result.reasons.join(" ")).not.toContain("accepted");

    // 快速档仍执行结构性检查（错收件人/版本）。
    const wrongRecipient = await verifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-fast-wrong",
        deliveredToRecipientIdentifier: "secondary-9",
      }),
    );
    expect(wrongRecipient.verdict).toBe("rejected");
  });

  it("严格档与歧义任务必须提供理解确认", async () => {
    const strictVerifier = new TaskAccuracyVerifier(
      createPorts({ getTier: async () => "strict" }),
    );
    const missing = await strictVerifier.verifyCompletion(
      declaration({ completionAttemptId: "attempt-strict" }),
    );
    expect(missing.verdict).toBe("rejected");
    expect(missing.reasons.join(" ")).toContain("understanding-confirmation-missing");

    const confirmed = await strictVerifier.verifyCompletion(
      declaration({
        completionAttemptId: "attempt-strict-2",
        understandingConfirmation: {
          restatedGoal: "复述：交付 X 并附测试回执",
          confirmedAtIso: "2026-09-16T00:00:00.000Z",
        },
      }),
    );
    expect(confirmed.verdict).toBe("accepted");
    expect(confirmed.isUnderstandingConfirmed).toBe(true);

    const ambiguousStandard = new TaskAccuracyVerifier(
      createPorts({ isClarificationRequired: async () => true }),
    );
    const ambiguous = await ambiguousStandard.verifyCompletion(
      declaration({ completionAttemptId: "attempt-ambiguous" }),
    );
    expect(ambiguous.reasons.join(" ")).toContain(
      "understanding-confirmation-missing",
    );
  });
});
