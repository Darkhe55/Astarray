import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";

let temporaryDirectory: string;
let missionManager: MissionManager;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mission-"));
  missionManager = new MissionManager(
    new TaskStore({ baseDirectory: temporaryDirectory }),
    temporaryDirectory,
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
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

describe("MissionManager", () => {
  it("createMission 写入任务链与概要", async () => {
    const document = await missionManager.createMission({
      missionId: "mission-1",
      mode: "assist",
      prompt: "分析项目",
      taskNodes,
    });
    expect(document.revision).toBe(1);
    const status = await missionManager.getMissionStatus("mission-1");
    expect(status.summary?.mode).toBe("assist");
    expect(status.summary?.prompt).toBe("分析项目");
    expect(status.summary?.status).toBe("running");
    expect(status.taskChain?.tasks).toHaveLength(1);
  });

  it("updateMissionStatus 更新概要状态", async () => {
    await missionManager.createMission({
      missionId: "mission-2",
      mode: "devolve",
      prompt: "部署",
      taskNodes,
    });
    await missionManager.updateMissionStatus("mission-2", "done");
    const status = await missionManager.getMissionStatus("mission-2");
    expect(status.summary?.status).toBe("done");
  });

  it("不存在的 mission getMissionStatus 抛 mission-not-found", async () => {
    await expect(
      missionManager.getMissionStatus("mission-ghost"),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("listMissionIds 列出已创建 mission", async () => {
    await missionManager.createMission({
      missionId: "mission-a",
      mode: "assist",
      prompt: "a",
      taskNodes,
    });
    await missionManager.createMission({
      missionId: "mission-b",
      mode: "ponder",
      prompt: "b",
      taskNodes,
    });
    const missionIds = await missionManager.listMissionIds();
    expect(missionIds.sort()).toEqual(["mission-a", "mission-b"]);
  });

  it("无 mission 时 listMissionIds 返回空数组", async () => {
    expect(await missionManager.listMissionIds()).toEqual([]);
  });

  it("创建非法任务链抛 invalid-task-chain", async () => {
    await expect(
      missionManager.createMission({
        missionId: "mission-bad",
        mode: "assist",
        prompt: "x",
        taskNodes: [],
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("updateMissionStatus 对不存在 mission 静默返回", async () => {
    await expect(
      missionManager.updateMissionStatus("mission-ghost", "done"),
    ).resolves.toBeUndefined();
  });
});
