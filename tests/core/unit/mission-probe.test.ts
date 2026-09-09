/**
 * T12-04：MissionManager.probeMissionDirectory 只读探针（损坏容错）。
 * 单 mission 的 summary/任务链损坏只标记 corrupted，绝不抛错。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";

let temporaryDirectory: string;
let manager: MissionManager;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-probe-"));
  manager = new MissionManager(
    new TaskStore({ baseDirectory: temporaryDirectory }),
    temporaryDirectory,
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function missionDirectoryPath(missionId: string): string {
  return path.join(temporaryDirectory, "missions", missionId);
}

async function writeSummary(missionId: string, status: string): Promise<void> {
  await fs.mkdir(missionDirectoryPath(missionId), { recursive: true });
  await fs.writeFile(
    path.join(missionDirectoryPath(missionId), "summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId,
      mode: "assist",
      prompt: "探针任务",
      createdAtIso: "2026-08-26T10:00:00.000Z",
      status,
    }),
    "utf8",
  );
}

async function writeChain(
  missionId: string,
  corrupted: boolean,
): Promise<void> {
  const directoryPath = missionDirectoryPath(missionId);
  await fs.mkdir(directoryPath, { recursive: true });
  if (corrupted) {
    await fs.writeFile(
      path.join(directoryPath, "task-chain.json"),
      "{ 损坏的任务链",
      "utf8",
    );
    return;
  }
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId,
    revision: 1,
    updatedAtIso: "2026-08-26T10:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "任务",
        dependsOn: [],
        taskType: "data",
        toolNames: ["read"],
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ],
  };
  await fs.writeFile(
    path.join(directoryPath, "task-chain.json"),
    JSON.stringify(chain),
    "utf8",
  );
}

describe("MissionManager.probeMissionDirectory（T12-04）", () => {
  it("正常 mission：summary/任务链均可达，pendingTaskCount 正确", async () => {
    await writeSummary("mission-ok", "running");
    await writeChain("mission-ok", false);
    const probe = await manager.probeMissionDirectory("mission-ok");
    expect(probe.exists).toBe(true);
    expect(probe.hasSummary).toBe(true);
    expect(probe.summaryCorrupted).toBe(false);
    expect(probe.summaryStatus).toBe("running");
    expect(probe.hasTaskChain).toBe(true);
    expect(probe.taskChainCorrupted).toBe(false);
    expect(probe.pendingTaskCount).toBe(1);
  });

  it("summary 损坏：标记 summaryCorrupted 而不抛错", async () => {
    await fs.mkdir(missionDirectoryPath("mission-bad-summary"), { recursive: true });
    await fs.writeFile(
      path.join(missionDirectoryPath("mission-bad-summary"), "summary.json"),
      "{ 损坏的 summary",
      "utf8",
    );
    const probe = await manager.probeMissionDirectory("mission-bad-summary");
    expect(probe.exists).toBe(true);
    expect(probe.hasSummary).toBe(true);
    expect(probe.summaryCorrupted).toBe(true);
    expect(probe.summaryStatus).toBeNull();
  });

  it("任务链损坏：标记 taskChainCorrupted 而不抛错", async () => {
    await writeSummary("mission-bad-chain", "done");
    await writeChain("mission-bad-chain", true);
    const probe = await manager.probeMissionDirectory("mission-bad-chain");
    expect(probe.exists).toBe(true);
    expect(probe.hasTaskChain).toBe(true);
    expect(probe.taskChainCorrupted).toBe(true);
    expect(probe.pendingTaskCount).toBeNull();
  });

  it("缺失 mission：exists=false 且无损坏标记", async () => {
    const probe = await manager.probeMissionDirectory("mission-missing");
    expect(probe.exists).toBe(false);
    expect(probe.hasSummary).toBe(false);
    expect(probe.hasTaskChain).toBe(false);
    expect(probe.summaryCorrupted).toBe(false);
    expect(probe.taskChainCorrupted).toBe(false);
  });
});
