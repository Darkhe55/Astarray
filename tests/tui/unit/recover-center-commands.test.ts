/**
 * T12A-R1-01 测试：recover list/resume/abandon 走真实磁盘状态与检查点，
 * 损坏态不得静默重建为成功，abandon 保留产物。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";
import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import {
  executeRecoverAbandonCommand,
  executeRecoverListCommand,
  executeRecoverResumeCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12ar1-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

const taskNodes: TaskDependencyNode[] = [
  {
    id: "T-001",
    description: "任务一",
    dependsOn: [],
    taskType: "data",
    toolNames: ["readFile"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  },
];

function createMissionManager(): MissionManager {
  return new MissionManager(
    new TaskStore({ baseDirectory: stateDirectory }),
    stateDirectory,
  );
}

async function seedMission(missionId: string): Promise<MissionManager> {
  const manager = createMissionManager();
  await manager.createMission({
    missionId,
    mode: "assist",
    prompt: "分析项目",
    taskNodes,
  });
  return manager;
}

function summaryFilePath(missionId: string): string {
  return path.join(stateDirectory, "missions", missionId, "summary.json");
}

async function captureJson(
  run: () => Promise<number>,
): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
  try {
    const exitCode = await run();
    return {
      exitCode,
      payload: JSON.parse(chunks.join("")) as Record<string, unknown>,
    };
  } finally {
    spy.mockRestore();
  }
}

function makeTrustedCheckpoint(
  missionIdentifier: string,
  overrides: Record<string, unknown> = {},
) {
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
    contentHash: `sha256:${"a".repeat(64)}`,
    previousCheckpointHash: null,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    writingProcessInstanceIdentifier: "process-1",
    ...overrides,
  };
}

describe("recover list 反映磁盘真实状态", () => {
  it("列出磁盘上的 mission 并标记损坏 mission", async () => {
    await seedMission("mission-intact");
    await seedMission("mission-broken");
    await fs.writeFile(summaryFilePath("mission-broken"), "{ not json");

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(exitCode).toBe(0);
    expect(payload.recoveryCenterReady).toBe(true);
    const missions = payload.missions as Array<Record<string, unknown>>;
    const identifiers = missions.map((mission) => mission.missionIdentifier);
    expect(identifiers).toContain("mission-intact");
    expect(identifiers).toContain("mission-broken");
    const broken = missions.find(
      (mission) => mission.missionIdentifier === "mission-broken",
    );
    expect(broken?.isCorrupted).toBe(true);
    const intact = missions.find(
      (mission) => mission.missionIdentifier === "mission-intact",
    );
    expect(intact?.isCorrupted).toBe(false);
    expect(intact?.status).toBe("running");
    expect(payload.requiresDecisionMissions).toContain("mission-broken");
  });
});

describe("recover resume 依据磁盘状态与检查点", () => {
  it("摘要损坏 → blocked-state-corrupted，且不重写损坏文件", async () => {
    await seedMission("mission-broken");
    await fs.writeFile(summaryFilePath("mission-broken"), "{ not json");

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverResumeCommand({
        stateDirectory,
        missionIdentifier: "mission-broken",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(1);
    expect(payload.resumed).toBe(false);
    const decisions = payload.blockedDecisionItems as Array<
      Record<string, unknown>
    >;
    expect(decisions[0]?.decision).toBe("blocked-state-corrupted");
    expect(
      await fs.readFile(summaryFilePath("mission-broken"), "utf8"),
    ).toBe("{ not json");
  });

  it("无可信检查点 → checkpoint-not-found，且状态保持 blocked", async () => {
    const manager = await seedMission("mission-no-checkpoint");
    await manager.updateMissionStatus("mission-no-checkpoint", "blocked");

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverResumeCommand({
        stateDirectory,
        missionIdentifier: "mission-no-checkpoint",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(1);
    expect(payload.resumed).toBe(false);
    const decisions = payload.blockedDecisionItems as Array<
      Record<string, unknown>
    >;
    expect(decisions[0]?.decision).toBe("checkpoint-not-found");
    expect(
      (await manager.getMissionStatus("mission-no-checkpoint")).summary?.status,
    ).toBe("blocked");
  });

  it("存在可信检查点 → resumed，真正把状态恢复为 running", async () => {
    const manager = await seedMission("mission-resumable");
    await manager.updateMissionStatus("mission-resumable", "blocked");
    const checkpointStore = new RecoveryCheckpointStore({
      baseDirectory: stateDirectory,
    });
    await checkpointStore.writeCheckpoint({
      checkpoint: makeTrustedCheckpoint("mission-resumable") as never,
      writingProcessInstanceIdentifier: "process-1",
    });

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverResumeCommand({
        stateDirectory,
        missionIdentifier: "mission-resumable",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(0);
    expect(payload.resumed).toBe(true);
    expect(payload.recoveredSafeNodes).toEqual([]);
    expect(payload.blockedDecisionItems).toEqual([]);
    // 一次性授权不随恢复延续：必须显式上报重新授权要求
    expect(payload.reauthorizationRequiredTypes).toContain("session-authorization");
    expect(payload.requiresHandoffIdentity).toBe(false);
    expect(payload.readySetTaskNodeIdentifiers).toEqual([]);
    expect(
      (await manager.getMissionStatus("mission-resumable")).summary?.status,
    ).toBe("running");
  });

  it("已回收 Agent → 需新身份 + handoff，ready set 按前驱重算", async () => {
    const manager = await seedMission("mission-handoff");
    await manager.updateMissionStatus("mission-handoff", "blocked");
    const checkpointStore = new RecoveryCheckpointStore({
      baseDirectory: stateDirectory,
    });
    await checkpointStore.writeCheckpoint({
      checkpoint: makeTrustedCheckpoint("mission-handoff", {
        agentIdentities: [
          {
            agentInstanceId: "agent-reclaimed",
            agentRole: "tertiary",
            lifecycleState: "reclaimed",
            handoffReference: null,
            parentAgentInstanceId: "agent-secondary",
          },
        ],
        taskNodes: [
          {
            taskNodeIdentifier: "task-done",
            status: "done",
            predecessorTaskNodeIdentifiers: [],
            priorityTier: 1,
            assignedAgentInstanceId: null,
            checkpointIdentifier: null,
            completionAttemptIdentifier: null,
          },
          {
            taskNodeIdentifier: "task-ready",
            status: "pending",
            predecessorTaskNodeIdentifiers: ["task-done"],
            priorityTier: 1,
            assignedAgentInstanceId: null,
            checkpointIdentifier: null,
            completionAttemptIdentifier: null,
          },
          {
            taskNodeIdentifier: "task-waiting",
            status: "pending",
            predecessorTaskNodeIdentifiers: ["task-ready"],
            priorityTier: 0,
            assignedAgentInstanceId: null,
            checkpointIdentifier: null,
            completionAttemptIdentifier: null,
          },
        ],
      }) as never,
      writingProcessInstanceIdentifier: "process-1",
    });

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverResumeCommand({
        stateDirectory,
        missionIdentifier: "mission-handoff",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(0);
    expect(payload.resumed).toBe(true);
    expect(payload.requiresHandoffIdentity).toBe(true);
    expect(payload.readySetTaskNodeIdentifiers).toEqual(["task-ready"]);
    const identities = payload.identityRecoveries as Array<
      Record<string, unknown>
    >;
    expect(identities[0]?.isReusingOriginalIdentity).toBe(false);
    expect(String(identities[0]?.agentInstanceId)).toContain("agent-reclaimed");
    expect(String(identities[0]?.handoffReference)).toContain("handoff-from-");
  });

  it("非幂等工具结果未知 → 阻断恢复，安全节点仍上报且状态不变", async () => {
    const manager = await seedMission("mission-uncertain");
    await manager.updateMissionStatus("mission-uncertain", "blocked");
    const checkpointStore = new RecoveryCheckpointStore({
      baseDirectory: stateDirectory,
    });
    await checkpointStore.writeCheckpoint({
      checkpoint: makeTrustedCheckpoint("mission-uncertain", {
        toolCalls: [
          {
            toolCallIdentifier: "call-confirmed",
            toolName: "readFile",
            state: "confirmed-success",
            isIdempotent: true,
            completionAttemptIdentifier: null,
          },
          {
            toolCallIdentifier: "call-unknown",
            toolName: "writeFile",
            state: "result-unknown",
            isIdempotent: false,
            completionAttemptIdentifier: null,
          },
        ],
      }) as never,
      writingProcessInstanceIdentifier: "process-1",
    });

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverResumeCommand({
        stateDirectory,
        missionIdentifier: "mission-uncertain",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(1);
    expect(payload.resumed).toBe(false);
    expect(payload.recoveredSafeNodes).toEqual(["call-confirmed"]);
    const decisions = payload.blockedDecisionItems as Array<
      Record<string, unknown>
    >;
    expect(decisions[0]?.item).toBe("call-unknown");
    expect(decisions[0]?.decision).toBe("blocked-uncertain-side-effect");
    expect(
      (await manager.getMissionStatus("mission-uncertain")).summary?.status,
    ).toBe("blocked");
  });
});

describe("recover abandon 关闭调度但保留产物", () => {
  it("状态置 cancelled，任务链与摘要文件保留", async () => {
    const manager = await seedMission("mission-abandon");
    const taskChainPath = path.join(
      stateDirectory,
      "missions",
      "mission-abandon",
      "task-chain.json",
    );
    expect(await fs.readFile(taskChainPath, "utf8")).not.toBe("");

    const { exitCode, payload } = await captureJson(() =>
      executeRecoverAbandonCommand({
        stateDirectory,
        missionIdentifier: "mission-abandon",
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(0);
    expect(payload.abandoned).toBe(true);
    expect(payload.artifactsRetained).toBe(true);
    expect(
      (await manager.getMissionStatus("mission-abandon")).summary?.status,
    ).toBe("cancelled");
    expect(await fs.readFile(taskChainPath, "utf8")).not.toBe("");
    expect(
      JSON.parse(await fs.readFile(summaryFilePath("mission-abandon"), "utf8"))
        .status,
    ).toBe("cancelled");
  });
});