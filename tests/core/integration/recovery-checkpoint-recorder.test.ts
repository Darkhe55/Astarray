/**
 * E2E-01-03 S2：产品侧**恢复检查点写入者**与工具调用边界（红 → 绿）。
 *
 * 卡内验收②："恢复无重复副作用"。
 *
 * 已查证的既有缺陷（本次实现前）：`RecoveryCheckpointStore.writeCheckpoint` 只被测试调用，
 * 产品路径从不写检查点 → 真实项目上 `recover resume` 必然 `checkpoint-not-found`。
 *
 * 本文件在实现之前必须失败；并**与已接线的恢复分类服务联测**，证明"已确认成功不重复执行、
 * 非幂等且结果未知必须转人工裁决"这条语义在产品数据上成立。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoveryClassificationService } from "../../../packages/core/src/orchestration/recovery-classification-service.js";
import {
  RecoveryCheckpointRecorder,
  RecoveryCheckpointWriteQueue,
  RecoveryCheckpointingToolPort,
} from "../../../packages/core/src/orchestration/recovery-checkpoint-recorder.js";
import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import type { ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

let baseDirectory: string;

beforeEach(() => {
  baseDirectory = mkdtempSync(path.join(tmpdir(), "astarray-recovery-recorder-"));
});

afterEach(() => {
  rmSync(baseDirectory, { recursive: true, force: true });
});

function buildSnapshot() {
  return {
    agentIdentities: [
      {
        agentInstanceId: "worker:mission-s2:T-001:1",
        agentRole: "tertiary" as const,
        lifecycleState: "active" as const,
        handoffReference: null,
        parentAgentInstanceId: "secondary:mission-s2:1",
      },
    ],
    taskNodes: [
      {
        taskNodeIdentifier: "T-001",
        status: "running" as const,
        predecessorTaskNodeIdentifiers: [],
        priorityTier: 0,
        assignedAgentInstanceId: "worker:mission-s2:T-001:1",
        checkpointIdentifier: null,
        completionAttemptIdentifier: null,
      },
    ],
    humanChangeObservationRevision: 0,
    pendingConflictIdentifiers: [],
    providerRequests: [
      {
        providerRequestPublicIdentifier: "provider-request:1",
        lastEventAtIso: "2026-10-07T00:00:00.000Z",
        isStopConfirmed: true,
        completionEventState: "received" as const,
      },
    ],
    feedbackCursor: { enqueueCursor: 0, deliveryCursor: 0, ackCursor: 0 },
    permissionRecovery: [
      { permissionProfileReference: "assist-default", profileRevision: 1 },
    ],
    workingSetFileCountsByAgent: { "worker:mission-s2:T-001:1": 1 },
    taskChainCumulativeSourceCount: 1,
    gateStates: {
      testingGate: "pending" as const,
      acceptanceGate: "pending" as const,
      humanReviewGate: "pending" as const,
      installationGate: "pending" as const,
      backupDeletionGate: "pending" as const,
    },
  };
}

function buildRecorder(store: RecoveryCheckpointStore): RecoveryCheckpointRecorder {
  return new RecoveryCheckpointRecorder({
    store,
    sessionIdentifier: "session-s2",
    missionIdentifier: "mission-s2",
    taskChainIdentifier: "T-001",
    writingProcessInstanceIdentifier: "process-test-1",
    snapshotProvider: buildSnapshot,
    nowIso: () => "2026-10-07T00:00:00.000Z",
  });
}

describe("E2E-01-03 S2：检查点写入者", () => {
  it("① 能写出 schema 合法、可被存储读取的检查点，并记录工具调用状态", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);

    await recorder.recordToolCallState({
      toolCallIdentifier: "call-1",
      toolName: "replaceFileContent",
      state: "confirmed-success",
      isIdempotent: false,
      completionAttemptIdentifier: "attempt-1",
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    expect(latest).not.toBeNull();
    expect(latest?.checkpoint.missionIdentifier).toBe("mission-s2");
    expect(latest?.checkpoint.toolCalls).toHaveLength(1);
    expect(latest?.checkpoint.toolCalls[0]?.state).toBe("confirmed-success");
    expect(latest?.checkpoint.toolCalls[0]?.isIdempotent).toBe(false);
  });

  it("② 哈希链：第二次写入的 previousCheckpointHash 必须等于第一次写入的存储层哈希", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);

    const first = await recorder.writeCheckpointNow();
    await recorder.recordToolCallState({
      toolCallIdentifier: "call-2",
      toolName: "readFile",
      state: "confirmed-success",
      isIdempotent: true,
      completionAttemptIdentifier: null,
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    expect(latest?.checkpoint.previousCheckpointHash).toBe(first.checkpointHash);
  });

  it("③ 同一工具调用的状态可推进（started → confirmed-success），不重复计条目", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);

    await recorder.recordToolCallState({
      toolCallIdentifier: "call-3",
      toolName: "replaceFileContent",
      state: "started",
      isIdempotent: false,
      completionAttemptIdentifier: null,
    });
    await recorder.recordToolCallState({
      toolCallIdentifier: "call-3",
      toolName: "replaceFileContent",
      state: "confirmed-success",
      isIdempotent: false,
      completionAttemptIdentifier: null,
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    expect(latest?.checkpoint.toolCalls).toHaveLength(1);
    expect(latest?.checkpoint.toolCalls[0]?.state).toBe("confirmed-success");
  });

  /**
   * ④ 真实回归反例（2026-10-07）：**两个记录器共用同一 store**。
   *
   * 产品路径上一个 mission 会有多个 worker 实例（键 `missionId::agentInstanceId`），
   * 因此同一 store 会被多个记录器共用。首版实现的链状态（上次哈希 + 自增标识）是
   * **每实例私有**、标识都从 0001 起 → 第二个记录器覆盖同名前缀文件、并提出过期的
   * `previousCheckpointHash` → `writeCheckpoint` 抛"检查点哈希链断裂" → 装饰器在
   * `started` 阶段 fail-closed，工具不执行、任务重试到 blocked
   * （实测：`authorization-retry-closure` 由 0.689s 通过变成 30.7s 失败）。
   *
   * 本用例在**没有共享写队列**时应当失败；修复（无状态链 + 全局唯一时间单调标识 +
   * 共享写队列）后必须通过。
   */
  it("④ 两个记录器共用同一 store 时不得互相破坏哈希链（并发写入）", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const sharedWriteQueue = new RecoveryCheckpointWriteQueue();
    const buildSharedRecorder = (taskChainIdentifier: string) =>
      new RecoveryCheckpointRecorder({
        store,
        sessionIdentifier: "session-s2",
        missionIdentifier: "mission-s2",
        taskChainIdentifier,
        writingProcessInstanceIdentifier: "process-test-shared",
        snapshotProvider: buildSnapshot,
        nowIso: () => "2026-10-07T00:00:00.000Z",
        sharedWriteQueue,
      });
    const recorderA = buildSharedRecorder("T-001");
    const recorderB = buildSharedRecorder("T-002");

    // 交错 + 并发写入：不得有任何一次抛错。
    await recorderA.recordToolCallState({
      toolCallIdentifier: "a-1",
      toolName: "replaceFileContent",
      state: "started",
      isIdempotent: false,
      completionAttemptIdentifier: null,
    });
    await Promise.all([
      recorderA.recordToolCallState({
        toolCallIdentifier: "a-2",
        toolName: "replaceFileContent",
        state: "result-unknown",
        isIdempotent: false,
        completionAttemptIdentifier: null,
      }),
      recorderB.recordToolCallState({
        toolCallIdentifier: "b-1",
        toolName: "replaceFileContent",
        state: "started",
        isIdempotent: false,
        completionAttemptIdentifier: null,
      }),
    ]);

    // 每个记录器各自的状态都被保留（互不覆盖）。
    expect(recorderA.getToolCallStates()).toHaveLength(2);
    expect(recorderB.getToolCallStates()).toHaveLength(1);

    // 链仍然可信，且标识全局唯一（否则同名文件会互相覆盖）。
    const latest = await store.selectLatestTrustedCheckpoint();
    expect(latest).not.toBeNull();
    expect(latest?.checkpoint.previousCheckpointHash).not.toBeNull();
    const checkpointFileNames = readdirSync(
      path.join(baseDirectory, "recovery-checkpoints"),
    ).filter((name) => name.endsWith(".json"));
    expect(checkpointFileNames.length).toBe(3);
  });
});

describe("E2E-01-03 S2：与恢复分类服务联测（验收②「恢复无重复副作用」语义）", () => {
  it("④ 已确认成功的非幂等工具 → 复用结果，绝不重复执行", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    await recorder.recordToolCallState({
      toolCallIdentifier: "call-success",
      toolName: "replaceFileContent",
      state: "confirmed-success",
      isIdempotent: false,
      completionAttemptIdentifier: "attempt-1",
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    if (latest === null) throw new Error("检查点未写入");
    const classification = new RecoveryClassificationService().classifyRecovery({
      checkpoint: latest.checkpoint,
      remainingRetryBudget: 3,
    });

    expect(classification.toolCallClassifications).toHaveLength(1);
    expect(classification.toolCallClassifications[0]?.classification.category).toBe(
      "reuse-confirmed-result",
    );
  });

  it("⑤ 非幂等且结果未知 → blocked-uncertain-side-effect（禁止自动二次执行）", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    await recorder.recordToolCallState({
      toolCallIdentifier: "call-unknown",
      toolName: "replaceFileContent",
      state: "result-unknown",
      isIdempotent: false,
      completionAttemptIdentifier: "attempt-1",
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    if (latest === null) throw new Error("检查点未写入");
    const classification = new RecoveryClassificationService().classifyRecovery({
      checkpoint: latest.checkpoint,
      remainingRetryBudget: 3,
    });

    expect(classification.toolCallClassifications[0]?.classification.category).toBe(
      "blocked-uncertain-side-effect",
    );
    expect(classification.hasBlockingItems).toBe(true);
  });

  it("⑥ 只读工具（幂等）不制造阻塞项", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    await recorder.recordToolCallState({
      toolCallIdentifier: "call-read",
      toolName: "readFile",
      state: "started",
      isIdempotent: true,
      completionAttemptIdentifier: null,
    });

    const latest = await store.selectLatestTrustedCheckpoint();
    if (latest === null) throw new Error("检查点未写入");
    const classification = new RecoveryClassificationService().classifyRecovery({
      checkpoint: latest.checkpoint,
      remainingRetryBudget: 3,
    });

    expect(classification.toolCallClassifications[0]?.classification.category).toBe(
      "bounded-retry",
    );
  });
});

/** 简单可注入内层端口。 */
function buildInnerToolPort(
  behavior: (toolName: string) => Promise<ToolCallResult>,
): ToolPort {
  return {
    execute: (toolName: string) => behavior(toolName),
  };
}

describe("E2E-01-03 S2：工具调用边界装饰器", () => {
  it("⑦ 成功执行 → 该调用被记为 confirmed-success", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    const decoratedPort = new RecoveryCheckpointingToolPort({
      innerToolPort: buildInnerToolPort(async () => ({
        kind: "success",
        callId: "call-ok",
        outputText: "已覆盖",
        isSideEffectFree: false,
      })),
      recorder,
      isMutatingTool: (toolName) => toolName === "replaceFileContent",
    });

    await decoratedPort.execute(
      "replaceFileContent",
      JSON.stringify({ filePath: "a.txt", content: "x" }),
      "call-ok",
      new AbortController().signal,
    );

    const states = recorder.getToolCallStates();
    expect(states).toHaveLength(1);
    expect(states[0]?.state).toBe("confirmed-success");
    expect(states[0]?.isIdempotent).toBe(false);
  });

  it("⑧ 写类工具抛错 → 记为 result-unknown（保守，禁止自动二次执行）并原样外抛", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    const decoratedPort = new RecoveryCheckpointingToolPort({
      innerToolPort: buildInnerToolPort(async () => {
        throw new Error("写入过程崩溃");
      }),
      recorder,
      isMutatingTool: (toolName) => toolName === "replaceFileContent",
    });

    await expect(
      decoratedPort.execute(
        "replaceFileContent",
        JSON.stringify({ filePath: "a.txt", content: "x" }),
        "call-crash",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/写入过程崩溃/);

    expect(recorder.getToolCallStates()[0]?.state).toBe("result-unknown");
  });

  it("⑨ 错误结果且确定未进入副作用通道 → confirmed-failure（可受预算约束重试）", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory });
    const recorder = buildRecorder(store);
    const decoratedPort = new RecoveryCheckpointingToolPort({
      innerToolPort: buildInnerToolPort(async () => ({
        kind: "error",
        callId: "call-denied",
        errorCode: "tool-permission-denied",
        errorMessage: "权限策略拒绝",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      })),
      recorder,
      isMutatingTool: () => true,
    });

    await decoratedPort.execute(
      "replaceFileContent",
      JSON.stringify({ filePath: "a.txt", content: "x" }),
      "call-denied",
      new AbortController().signal,
    );

    expect(recorder.getToolCallStates()[0]?.state).toBe("confirmed-failure");
  });
});
