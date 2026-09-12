/**
 * T12A-R1-04 测试：recover resume --execute 真正续接既有 mission 并完成产物。
 * 验收：至少一条恢复任务真正完成产物；租约门禁防双跑；终态 mission 不重复执行；
 * 不确定任务（无可信检查点）有可操作裁决且不执行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";
import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import { executeRecoverResumeCommand } from "../../../packages/tui/src/cli/commands.js";
import { makeRecoveryCheckpoint } from "../../support/recovery-checkpoint-fixture.js";

let stateDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12ar1-04-"));
  stdoutBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function missionManager(): MissionManager {
  return new MissionManager(
    new TaskStore({ baseDirectory: stateDirectory }),
    stateDirectory,
  );
}

const interruptedTaskNodes = [
  {
    id: "T-001",
    description: "恢复后应真正完成的任务",
    dependsOn: [],
    taskType: "data" as const,
    toolNames: ["readFile"],
    assignedAgentId: null,
    status: "pending" as const,
    resultLocation: null,
  },
];

async function seedInterruptedMission(
  missionId: string,
  options: { withCheckpoint: boolean; status?: "blocked" | "cancelled" | "done" },
): Promise<void> {
  const manager = missionManager();
  await manager.createMission({
    missionId,
    mode: "assist",
    prompt: "中断恢复探针",
    taskNodes: interruptedTaskNodes,
  });
  await manager.updateMissionStatus(missionId, options.status ?? "blocked");
  if (options.withCheckpoint) {
    await new RecoveryCheckpointStore({ baseDirectory: stateDirectory }).writeCheckpoint({
      checkpoint: makeRecoveryCheckpoint(missionId),
      writingProcessInstanceIdentifier: "process-crashed",
    });
  }
}

async function writeExpiredLease(missionId: string): Promise<void> {
  const leaseStore = new MissionLeaseStore({
    stateDirectory,
    nowMilliseconds: () => Date.now() - 300_000,
  });
  const outcome = await leaseStore.tryAcquire({
    missionId,
    processInstanceId: "crashed-process",
    purpose: "run",
    claimantDescription: "崩溃进程遗留租约",
  });
  expect(outcome.status).toBe("acquired");
}

async function writeActiveLease(missionId: string): Promise<void> {
  const leaseStore = new MissionLeaseStore({ stateDirectory });
  const outcome = await leaseStore.tryAcquire({
    missionId,
    processInstanceId: "other-live-process",
    purpose: "run",
    claimantDescription: "其他活动进程",
  });
  expect(outcome.status).toBe("acquired");
}

function parseOutput(): Record<string, unknown> {
  return JSON.parse(stdoutBuffer.join("")) as Record<string, unknown>;
}

async function workArchiveExists(missionId: string): Promise<boolean> {
  const agentsDirectory = path.join(stateDirectory, "missions", missionId, "agents");
  try {
    const agentIdentifiers = await fs.readdir(agentsDirectory);
    for (const agentIdentifier of agentIdentifiers) {
      try {
        await fs.access(
          path.join(agentsDirectory, agentIdentifier, "work-archive.json"),
        );
        return true;
      } catch {
        // 继续找
      }
    }
  } catch {
    return false;
  }
  return false;
}

describe("recover resume --execute", () => {
  it("接管过期租约、真正完成既有 mission 的未完成任务并产出产物", async () => {
    await seedInterruptedMission("mission-resume", { withCheckpoint: true });
    await writeExpiredLease("mission-resume");

    const exitCode = await executeRecoverResumeCommand({
      stateDirectory,
      missionIdentifier: "mission-resume",
      isJsonOutput: true,
      isExecutionRequested: true,
    });
    expect(exitCode).toBe(0);
    const view = parseOutput();
    expect(view.resumed).toBe(true);
    expect(view.executed).toBe(true);
    expect(view.status).toBe("done");
    expect(view.leaseTakeoverPerformed).toBe(true);
    expect(Number(view.completedTaskCount)).toBeGreaterThanOrEqual(1);

    const manager = missionManager();
    const status = await manager.getMissionStatus("mission-resume");
    expect(status.summary?.status).toBe("done");
    expect(status.taskChain?.tasks.every((task) => task.status === "done")).toBe(true);
    expect(await workArchiveExists("mission-resume")).toBe(true);
    // 租约已释放：不留下活动租约阻碍后续进程
    const lease = await new MissionLeaseStore({ stateDirectory }).readLeaseSummary(
      "mission-resume",
      "verifier",
    );
    expect(lease.isActive).toBe(false);
  });

  it("其他进程持有活动租约 → 拒绝双跑且不执行", async () => {
    await seedInterruptedMission("mission-locked", { withCheckpoint: true });
    await writeActiveLease("mission-locked");

    const exitCode = await executeRecoverResumeCommand({
      stateDirectory,
      missionIdentifier: "mission-locked",
      isJsonOutput: true,
      isExecutionRequested: true,
    });
    expect(exitCode).not.toBe(0);
    expect(stdoutBuffer.join("")).toContain("mission-locked");
    expect((await missionManager().getMissionStatus("mission-locked")).summary?.status).toBe(
      "blocked",
    );
    expect(await workArchiveExists("mission-locked")).toBe(false);
  });

  it("已取消 mission → mission-already-terminal 裁决且不执行", async () => {
    await seedInterruptedMission("mission-cancelled", {
      withCheckpoint: true,
      status: "cancelled",
    });

    const exitCode = await executeRecoverResumeCommand({
      stateDirectory,
      missionIdentifier: "mission-cancelled",
      isJsonOutput: true,
      isExecutionRequested: true,
    });
    expect(exitCode).not.toBe(0);
    const view = parseOutput();
    const decisions = (view.blockedDecisionItems as Array<Record<string, unknown>>).map(
      (item) => item.decision,
    );
    expect(decisions).toContain("mission-already-terminal");
    expect(await workArchiveExists("mission-cancelled")).toBe(false);
  });

  it("无可信检查点 → checkpoint-not-found 且不执行（可操作裁决）", async () => {
    await seedInterruptedMission("mission-no-checkpoint", {
      withCheckpoint: false,
    });
    await executeRecoverResumeCommand({
      stateDirectory,
      missionIdentifier: "mission-no-checkpoint",
      isJsonOutput: true,
      isExecutionRequested: true,
    }).then((exitCode) => expect(exitCode).not.toBe(0));
    expect((await missionManager().getMissionStatus("mission-no-checkpoint")).summary?.status).toBe(
      "blocked",
    );
    expect(await workArchiveExists("mission-no-checkpoint")).toBe(false);
  });
});
