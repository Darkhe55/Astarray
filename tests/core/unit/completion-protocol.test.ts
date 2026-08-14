/**
 * T07A 单测：明确完成协议与早停恢复（ADR-0015）。
 * 覆盖：完成事件解析（文本末行/结构化/正文伪造忽略）、验收器全条件
 * （重放/ID/revision/前驱/产物/门禁/未决项/证据/活锁/终态）、
 * 看门狗活性评估（健康/无进展活跃/失活）、续跑协调器（检查点/上限/幂等/
 * 旧请求不确定 blocked）。
 */
import { describe, expect, it } from "vitest";

import {
  CompletionControlParser,
  formatBlockedMarkerLine,
  formatCompletionMarkerLine,
  MAXIMUM_AUTOMATIC_CONTINUATION_ATTEMPTS,
  MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS,
  WATCHDOG_CHECK_INTERVAL_MILLISECONDS,
} from "../../../packages/core/src/core/completion-protocol.js";
import type { TaskCompletionEventV1 } from "../../../packages/core/src/core/completion-protocol.js";
import { LocalCompletionVerifier } from "../../../packages/core/src/orchestration/completion-verifier.js";
import type { CompletionVerificationContext } from "../../../packages/core/src/orchestration/completion-verifier.js";
import {
  AgentRunWatchdog,
  ContinuationCoordinator,
} from "../../../packages/core/src/orchestration/agent-run-watchdog.js";
import { EvidenceCompletionGate } from "../../../packages/core/src/tools/evidence-completion-gate.js";
import { EvidenceBundleBuilder } from "../../../packages/core/src/tools/evidence-bundle-builder.js";

function makeCompletionEvent(
  overrides: Partial<TaskCompletionEventV1> = {},
): TaskCompletionEventV1 {
  return {
    taskExecutionId: "task-exec-1",
    completionAttemptId: "attempt-1",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
    ...overrides,
  };
}

function makePassingContext(
  overrides: Partial<CompletionVerificationContext> = {},
): CompletionVerificationContext {
  return {
    taskExecutionId: "task-exec-1",
    expectedTaskIdentifiers: ["T-001"],
    currentTaskSequenceRevision: 1,
    completableTaskIdentifiers: ["T-001"],
    unsatisfiedPredecessorTaskIdentifiers: [],
    pendingWorkItemCount: 0,
    artifactVerificationEvidence: [
      { gateName: "产物存在", passed: true },
      { gateName: "测试通过", passed: true },
    ],
    hasUnresolvedLivelock: false,
    isTaskBudgetBypassed: false,
    hasUnresolvedBlockedOrFailedState: false,
    didProviderStreamEndCleanly: true,
    evidenceGate: null,
    usedCompletionAttemptIds: new Set<string>(),
    ...overrides,
  };
}

describe("CompletionControlParser", () => {
  const parser = new CompletionControlParser();

  it("文本兼容格式：标识在最终独立末行 → 解析成功", () => {
    const event = makeCompletionEvent();
    const output = `任务完成。\n${formatCompletionMarkerLine(event)}`;
    const parsed = parser.parseTextOutput({ finalOutputText: output });
    expect(parsed.kind).toBe("completion");
    if (parsed.kind === "completion") {
      expect(parsed.event.completionAttemptId).toBe("attempt-1");
      expect(parsed.event.claimedStatus).toBe("complete");
    }
  });

  it("标识出现在正文中间/普通文本 → 忽略（none）", () => {
    const event = makeCompletionEvent();
    const output = `第一行说 ${formatCompletionMarkerLine(event)}\n然后是更多正文`;
    expect(parser.parseTextOutput({ finalOutputText: output }).kind).toBe("none");
    expect(parser.parseTextOutput({ finalOutputText: "随便提到 ASTARRAY_TASK_COMPLETION_V1 但没 JSON" }).kind).toBe("none");
  });

  it("宽限期内可容忍末尾非标识行", () => {
    const event = makeCompletionEvent();
    const output = `正文\n${formatCompletionMarkerLine(event)}\n（补充说明）`;
    const parsed = parser.parseTextOutput({
      finalOutputText: output,
      markerGracePeriodLines: 1,
    });
    expect(parsed.kind).toBe("completion");
  });

  it("非法 JSON/字段缺失/claimedStatus 错误 → none", () => {
    expect(parser.tryParseMarkerLine(`${"ASTARRAY_TASK_COMPLETION_V1"} {bad json`)).toBeNull();
    expect(
      parser.tryParseMarkerLine(
        `${"ASTARRAY_TASK_COMPLETION_V1"} ${JSON.stringify({
          taskExecutionId: "x",
          claimedStatus: "done",
        })}`,
      ),
    ).toBeNull();
  });

  it("结构化控制帧解析（Provider 原生通道）", () => {
    const event = makeCompletionEvent();
    const parsed = parser.parseStructuredControl(formatCompletionMarkerLine(event));
    expect(parsed.kind).toBe("completion");
    const blocked = parser.parseStructuredControl(
      formatBlockedMarkerLine({
        taskExecutionId: "task-exec-1",
        blockReason: "需要用户输入",
        blockedTaskIdentifiers: ["T-001"],
      }),
    );
    expect(blocked.kind).toBe("blocked");
  });
});

describe("LocalCompletionVerifier", () => {
  const verifier = new LocalCompletionVerifier();

  it("合法事件且全部本地门禁通过 → 只结案一次（accepted）", () => {
    const context = makePassingContext();
    expect(verifier.verifyCompletion(makeCompletionEvent(), context)).toEqual({
      accepted: true,
    });
  });

  it("重放尝试 ID 拒绝", () => {
    const context = makePassingContext({
      usedCompletionAttemptIds: new Set(["attempt-1"]),
    });
    const decision = verifier.verifyCompletion(makeCompletionEvent(), context);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.rejectionReasons.join()).toContain("重放");
    }
  });

  it("任务执行 ID 不匹配 / revision 陈旧拒绝", () => {
    const wrongId = verifier.verifyCompletion(
      makeCompletionEvent({ taskExecutionId: "other-exec" }),
      makePassingContext(),
    );
    expect(wrongId.accepted).toBe(false);
    if (!wrongId.accepted) {
      expect(wrongId.rejectionReasons.join()).toContain("不匹配");
    }
    const stale = verifier.verifyCompletion(
      makeCompletionEvent({ taskSequenceRevision: 0 }),
      makePassingContext({ currentTaskSequenceRevision: 2 }),
    );
    expect(stale.accepted).toBe(false);
    if (!stale.accepted) {
      expect(stale.rejectionReasons.join()).toContain("陈旧");
    }
  });

  it("不可完成任务/未满足前驱/预期外任务拒绝", () => {
    const notCompletable = verifier.verifyCompletion(
      makeCompletionEvent({ completedTaskIdentifiers: ["T-002"] }),
      makePassingContext(),
    );
    expect(notCompletable.accepted).toBe(false);
    const unmetPredecessor = verifier.verifyCompletion(
      makeCompletionEvent(),
      makePassingContext({ unsatisfiedPredecessorTaskIdentifiers: ["T-001"] }),
    );
    expect(unmetPredecessor.accepted).toBe(false);
  });

  it("未决工作项/验收门禁失败/活锁/预算绕过/未解决阻塞/流未正常结束均拒绝", () => {
    const contexts: Array<Partial<CompletionVerificationContext>> = [
      { pendingWorkItemCount: 1 },
      { artifactVerificationEvidence: [{ gateName: "测试通过", passed: false }] },
      { hasUnresolvedLivelock: true },
      { isTaskBudgetBypassed: true },
      { hasUnresolvedBlockedOrFailedState: true },
      { didProviderStreamEndCleanly: false },
    ];
    for (const overrides of contexts) {
      const decision = verifier.verifyCompletion(
        makeCompletionEvent(),
        makePassingContext(overrides),
      );
      expect(decision.accepted).toBe(false);
    }
  });

  it("高严谨性任务证据门禁未满足 → 拒绝完成声明", () => {
    const builder = new EvidenceBundleBuilder();
    const gate = new EvidenceCompletionGate();
    // 仅推理的证据包
    const reasoningOnlyBundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        {
          entryType: "reasoning",
          claimIdentifier: "claim-1",
          premises: ["前提"],
          uncertainty: "高",
        },
      ],
    });
    const context = makePassingContext({
      evidenceGate: {
        gate,
        bundle: reasoningOnlyBundle,
        requiredClaimIdentifier: "claim-1",
        requireSourceText: true,
      },
    });
    const decision = verifier.verifyCompletion(makeCompletionEvent(), context);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.rejectionReasons.join()).toContain("证据门禁");
    }
  });

  it("高严谨性证据门禁满足时放行", () => {
    const builder = new EvidenceBundleBuilder();
    const gate = new EvidenceCompletionGate();
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        {
          entryType: "source",
          claimIdentifier: "claim-1",
          title: "t",
          publisherOrAuthor: "p",
          directLinkOrDocumentId: "d",
          publishedAtIso: null,
          retrievedAtIso: "2026-08-13T00:00:00.000Z",
          relevantExcerptSummary: "s",
          contentHash: `sha256:${"a".repeat(64)}`,
          sourceType: "official",
        },
      ],
    });
    const context = makePassingContext({
      evidenceGate: {
        gate,
        bundle,
        requiredClaimIdentifier: "claim-1",
        requireSourceText: true,
      },
    });
    expect(verifier.verifyCompletion(makeCompletionEvent(), context)).toEqual({
      accepted: true,
    });
  });
});

describe("AgentRunWatchdog", () => {
  it("默认常量正确", () => {
    expect(WATCHDOG_CHECK_INTERVAL_MILLISECONDS).toBe(5_000);
    expect(MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS).toBe(90_000);
    expect(MAXIMUM_AUTOMATIC_CONTINUATION_ATTEMPTS).toBe(3);
  });

  it("进展在阈值内 → healthy", () => {
    const clock = 0;
    const watchdog = new AgentRunWatchdog({
      nowUnixMilliseconds: () => clock,
      latestStreamEventUnixMilliseconds: () => clock - 1_000,
    });
    expect(watchdog.assess().status).toBe("healthy");
  });

  it("无进展但 Provider 仍活跃 → 仅健康探测（不取消不续跑）", () => {
    let clock = 0;
    const watchdog = new AgentRunWatchdog({
      nowUnixMilliseconds: () => clock,
      latestStreamEventUnixMilliseconds: () => 0,
      latestTaskRevisionChangeUnixMilliseconds: () => 0,
      isProviderRequestActive: () => true,
    });
    clock = MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS + 1;
    const assessment = watchdog.assess();
    expect(assessment.status).toBe("stalled-activity-unknown");
    expect(assessment.reason).toContain("仍活跃");
  });

  it("无进展且 Provider 已失活 → stalled-inactive（可安全续跑）", () => {
    let clock = 0;
    const watchdog = new AgentRunWatchdog({
      nowUnixMilliseconds: () => clock,
      latestStreamEventUnixMilliseconds: () => 0,
      latestTaskRevisionChangeUnixMilliseconds: () => 0,
      isProviderRequestActive: () => false,
    });
    clock = MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS + 1;
    expect(watchdog.assess().status).toBe("stalled-inactive");
  });

  it("运行中的工具调用不算无进展", () => {
    const clock = MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS + 1;
    const watchdog = new AgentRunWatchdog({
      nowUnixMilliseconds: () => clock,
      latestStreamEventUnixMilliseconds: () => 0,
      hasRunningToolCall: () => true,
    });
    expect(watchdog.assess().status).toBe("healthy");
  });
});

describe("ContinuationCoordinator", () => {
  it("保存检查点后以新尝试 ID 续跑（幂等键保留）", async () => {
    const clock = 0;
    const savedCheckpoints: string[] = [];
    const coordinator = new ContinuationCoordinator({
      nowUnixMilliseconds: () => clock,
      saveCheckpoint: async (checkpoint) => {
        savedCheckpoints.push(checkpoint.checkpointId);
        return checkpoint.checkpointId;
      },
    });
    const outcome = await coordinator.planContinuation({
      taskExecutionId: "task-exec-1",
      attemptNumber: 0,
      incompleteTaskIdentifiers: ["T-001"],
      confirmedArtifactReferences: ["artifacts/a.json"],
      verificationGaps: ["测试未运行"],
      preservedIdempotencyKeys: ["idem-1"],
      isOldRequestConfirmedStopped: true,
    });
    expect(outcome.decision).toBe("continue");
    if (outcome.decision === "continue") {
      expect(outcome.request.attemptNumber).toBe(1);
      expect(outcome.request.completionAttemptId).toMatch(/^attempt-/);
      expect(outcome.request.checkpoint.preservedIdempotencyKeys).toEqual([
        "idem-1",
      ]);
      expect(savedCheckpoints).toHaveLength(1);
    }
  });

  it("达到续跑上限 → give-up（不机械重试）", async () => {
    const coordinator = new ContinuationCoordinator({
      maximumAutomaticContinuationAttempts: 3,
    });
    const outcome = await coordinator.planContinuation({
      taskExecutionId: "task-exec-1",
      attemptNumber: 3,
      incompleteTaskIdentifiers: ["T-001"],
      confirmedArtifactReferences: [],
      verificationGaps: [],
      preservedIdempotencyKeys: [],
      isOldRequestConfirmedStopped: true,
    });
    expect(outcome.decision).toBe("give-up");
    if (outcome.decision === "give-up") {
      expect(outcome.reason).toContain("上限");
    }
  });

  it("旧请求停止状态不确定 → blocked（不得并发续跑）", async () => {
    const coordinator = new ContinuationCoordinator();
    const outcome = await coordinator.planContinuation({
      taskExecutionId: "task-exec-1",
      attemptNumber: 0,
      incompleteTaskIdentifiers: ["T-001"],
      confirmedArtifactReferences: [],
      verificationGaps: [],
      preservedIdempotencyKeys: [],
      isOldRequestConfirmedStopped: false,
    });
    expect(outcome.decision).toBe("blocked");
    expect(coordinator.getUsedAttemptCount()).toBe(0);
  });

  it("新尝试 ID 唯一且不重放（记录到 usedCompletionAttemptIds）", async () => {
    const coordinator = new ContinuationCoordinator();
    const first = await coordinator.planContinuation({
      taskExecutionId: "task-exec-1",
      attemptNumber: 0,
      incompleteTaskIdentifiers: ["T-001"],
      confirmedArtifactReferences: [],
      verificationGaps: [],
      preservedIdempotencyKeys: [],
      isOldRequestConfirmedStopped: true,
    });
    const second = await coordinator.planContinuation({
      taskExecutionId: "task-exec-1",
      attemptNumber: 1,
      incompleteTaskIdentifiers: ["T-001"],
      confirmedArtifactReferences: [],
      verificationGaps: [],
      preservedIdempotencyKeys: [],
      isOldRequestConfirmedStopped: true,
    });
    if (first.decision === "continue" && second.decision === "continue") {
      expect(first.request.completionAttemptId).not.toBe(
        second.request.completionAttemptId,
      );
      expect(coordinator.getUsedAttemptCount()).toBe(2);
    }
  });
});
