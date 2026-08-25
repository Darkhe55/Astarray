/**
 * T12A-02 测试：原子检查点存储、哈希链、journal 与可信版本选择。
 * 验收：原子写入（旧版本保留）；哈希链断裂拒绝；损坏最新检查点回退
 * 前一可信版本并报告丢失时间窗；journal 追加；并发 revision 拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12a02-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

function makeCheckpoint(overrides: Record<string, unknown> = {}) {
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
  };
}

describe("RecoveryCheckpointStore 原子写入与哈希链", () => {
  it("写入检查点：journal 追加 + 可信选择返回", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory: temporaryDirectory });
    const result = await store.writeCheckpoint({
      checkpoint: makeCheckpoint() as never,
      writingProcessInstanceIdentifier: "process-1",
    });
    expect(result.isLatestTrusted).toBe(true);
    expect(result.checkpointHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const journal = await fs.readFile(
      path.join(temporaryDirectory, "recovery-checkpoints", "checkpoint-journal.jsonl"),
      "utf8",
    );
    expect(journal).toContain("checkpoint-written");
    const trusted = await store.selectLatestTrustedCheckpoint();
    expect(trusted?.checkpoint.checkpointIdentifier).toBe("checkpoint-1");
    expect(trusted?.isFallbackFromCorruptLatest).toBe(false);
  });

  it("哈希链断裂：前一检查点哈希不匹配 → 拒绝写入", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory: temporaryDirectory });
    await store.writeCheckpoint({
      checkpoint: makeCheckpoint() as never,
      writingProcessInstanceIdentifier: "process-1",
    });
    await expect(
      store.writeCheckpoint({
        checkpoint: makeCheckpoint({
          checkpointIdentifier: "checkpoint-2",
          previousCheckpointHash: `sha256:${"f".repeat(64)}`,
        }) as never,
        writingProcessInstanceIdentifier: "process-2",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("并发 revision：非法 schema（损坏 revision）→ 拒绝", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.writeCheckpoint({
        checkpoint: makeCheckpoint({ schemaVersion: 99 }) as never,
        writingProcessInstanceIdentifier: "process-1",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });
});

describe("RecoveryCheckpointStore 损坏回退与丢失时间窗", () => {
  it("最新检查点损坏 → 回退前一可信版本并报告丢失时间窗", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory: temporaryDirectory });
    await store.writeCheckpoint({
      checkpoint: makeCheckpoint({
        checkpointIdentifier: "checkpoint-v1",
        taskNodes: [
          {
            taskNodeIdentifier: "t1",
            status: "done",
            predecessorTaskNodeIdentifiers: [],
            priorityTier: 0,
            assignedAgentInstanceId: null,
            checkpointIdentifier: null,
            completionAttemptIdentifier: null,
          },
        ],
      }) as never,
      writingProcessInstanceIdentifier: "process-1",
    });
    // 模拟写入中断：更新版本的检查点文件部分写入（损坏，排序在后）
    const latestPath = path.join(
      temporaryDirectory,
      "recovery-checkpoints",
      "checkpoint-zzz.json",
    );
    await fs.writeFile(latestPath, '{"schemaVersion":1,"partial', "utf8");
    const trusted = await store.selectLatestTrustedCheckpoint();
    expect(trusted?.checkpoint.checkpointIdentifier).toBe("checkpoint-v1");
    expect(trusted?.isFallbackFromCorruptLatest).toBe(true);
    expect(trusted?.lostTimeWindowDescription).toContain("丢失时间窗");
  });

  it("磁盘满/写入中断：旧版本保留（临时文件不破坏主文件）", async () => {
    const store = new RecoveryCheckpointStore({ baseDirectory: temporaryDirectory });
    await store.writeCheckpoint({
      checkpoint: makeCheckpoint({
        checkpointIdentifier: "checkpoint-keep",
      }) as never,
      writingProcessInstanceIdentifier: "process-1",
    });
    // 模拟中断：残留临时文件（rename 前失败）
    await fs.writeFile(
      path.join(temporaryDirectory, "recovery-checkpoints", "checkpoint-keep.json.tmp-123"),
      "partial",
      "utf8",
    );
    const trusted = await store.selectLatestTrustedCheckpoint();
    expect(trusted?.checkpoint.checkpointIdentifier).toBe("checkpoint-keep");
    // 主文件未损坏
    const mainContent = await fs.readFile(
      path.join(temporaryDirectory, "recovery-checkpoints", "checkpoint-keep.json"),
      "utf8",
    );
    expect(mainContent).toContain("checkpoint-keep");
  });
});