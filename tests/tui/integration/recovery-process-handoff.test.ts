/**
 * T12A-R1-04 集成测试：构建产物跨进程恢复交接。
 * 验收：另一进程接管过期租约、真正完成既有 mission 并查询最终结果；
 * 活动租约拒绝双跑；产物与租约收口可见。
 */
import { existsSync, promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";
import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import { makeRecoveryCheckpoint } from "../../support/recovery-checkpoint-fixture.js";

const distCliPath = path.join(process.cwd(), "dist", "cli.js");
const hasBuiltCli = existsSync(distCliPath);

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-handoff-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
} {
  const result = spawnSync(process.execPath, [distCliPath, ...args], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
    timedOut: result.error !== undefined,
  };
}

const stateDirectory = (): string => path.join(workingDirectory, ".astarray");

async function seedInterruptedMission(missionId: string): Promise<void> {
  const manager = new MissionManager(
    new TaskStore({ baseDirectory: stateDirectory() }),
    stateDirectory(),
  );
  await manager.createMission({
    missionId,
    mode: "assist",
    prompt: "跨进程中断恢复探针",
    taskNodes: [
      {
        id: "T-001",
        description: "跨进程恢复任务",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ],
  });
  await manager.updateMissionStatus(missionId, "blocked");
  await new RecoveryCheckpointStore({
    baseDirectory: stateDirectory(),
  }).writeCheckpoint({
    checkpoint: makeRecoveryCheckpoint(missionId),
    writingProcessInstanceIdentifier: "crashed-process",
  });
  const expiredLeaseStore = new MissionLeaseStore({
    stateDirectory: stateDirectory(),
    nowMilliseconds: () => Date.now() - 300_000,
  });
  const outcome = await expiredLeaseStore.tryAcquire({
    missionId,
    processInstanceId: "crashed-process",
    purpose: "run",
    claimantDescription: "崩溃进程遗留租约",
  });
  expect(outcome.status).toBe("acquired");
}

describe.skipIf(!hasBuiltCli)("跨进程恢复交接（构建产物）", () => {
  it("第二个进程接管过期租约并真正完成 mission，第三个进程查询到 done 与产物", async () => {
    const missionId = "mission-handoff";
    await seedInterruptedMission(missionId);

    const resumeResult = runCli([
      "recover",
      "resume",
      missionId,
      "--execute",
      "--json",
    ]);
    expect(resumeResult.timedOut).toBe(false);
    expect(resumeResult.exitCode).toBe(0);
    const resumedView = JSON.parse(resumeResult.stdout) as {
      resumed: boolean;
      executed: boolean;
      status: string;
      leaseTakeoverPerformed: boolean;
      completedTaskCount: number;
    };
    expect(resumedView.resumed).toBe(true);
    expect(resumedView.executed).toBe(true);
    expect(resumedView.status).toBe("done");
    expect(resumedView.leaseTakeoverPerformed).toBe(true);
    expect(resumedView.completedTaskCount).toBeGreaterThanOrEqual(1);

    const statusResult = runCli(["status", missionId, "--json"]);
    expect(statusResult.exitCode).toBe(0);
    const statusView = JSON.parse(statusResult.stdout) as {
      status: string;
      tasks: Array<{ status: string }>;
    };
    expect(statusView.status).toBe("done");
    expect(statusView.tasks.every((task) => task.status === "done")).toBe(true);

    const workArchivePath = path.join(
      stateDirectory(),
      "missions",
      missionId,
      "agents",
    );
    const agentIdentifiers = await fs.readdir(workArchivePath);
    let hasWorkArchive = false;
    for (const agentIdentifier of agentIdentifiers) {
      if (
        existsSync(path.join(workArchivePath, agentIdentifier, "work-archive.json"))
      ) {
        hasWorkArchive = true;
      }
    }
    expect(hasWorkArchive).toBe(true);

    const lease = await new MissionLeaseStore({
      stateDirectory: stateDirectory(),
    }).readLeaseSummary(missionId, "verifier-process");
    expect(lease.isActive).toBe(false);
  });

  it("其他进程持有活动租约 → 第二个进程拒绝续接且不产生产物", async () => {
    const missionId = "mission-active-lease";
    await seedInterruptedMission(missionId);
    // 用活动租约覆盖过期租约（属主为另一进程）
    await fs.rm(
      path.join(stateDirectory(), "missions", missionId, "mission-lease.json"),
      { force: true },
    );
    const liveLeaseStore = new MissionLeaseStore({
      stateDirectory: stateDirectory(),
    });
    const acquired = await liveLeaseStore.tryAcquire({
      missionId,
      processInstanceId: "other-live-process",
      purpose: "run",
      claimantDescription: "其他活动进程",
    });
    expect(acquired.status).toBe("acquired");

    const resumeResult = runCli([
      "recover",
      "resume",
      missionId,
      "--execute",
      "--json",
    ]);
    expect(resumeResult.exitCode).not.toBe(0);
    expect(resumeResult.stdout).toContain("mission-locked");

    const statusResult = runCli(["status", missionId, "--json"]);
    const statusView = JSON.parse(statusResult.stdout) as { status: string };
    expect(statusView.status).toBe("blocked");
    const agentsDirectory = path.join(stateDirectory(), "missions", missionId, "agents");
    const agentsExist = existsSync(agentsDirectory)
      ? (await fs.readdir(agentsDirectory)).length > 0
      : false;
    expect(agentsExist).toBe(false);
  });
});
