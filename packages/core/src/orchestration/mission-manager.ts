/**
 * 任务状态管理（T08/T09）。
 * 管理 mission 概要（.astarray/missions/<missionId>/summary.json）与任务链。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import type { AgentMode, TaskChainDocument } from "../core/types.js";
import { taskChainSchema } from "../core/schemas.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import type { TaskStorePort } from "../core/types.js";

export interface MissionSummary {
  schemaVersion: 1;
  missionId: string;
  mode: AgentMode;
  prompt: string;
  createdAtIso: string;
  status: "running" | "done" | "cancelled" | "blocked";
}

export interface MissionStatus {
  missionId: string;
  summary: MissionSummary | null;
  taskChain: TaskChainDocument | null;
}

export interface CreateMissionInput {
  missionId: string;
  mode: AgentMode;
  prompt: string;
  taskNodes: TaskChainDocument["tasks"];
}

export class MissionManager {
  private readonly summaryWriteMutex = new AsyncMutex();

  constructor(
    private readonly taskStore: TaskStorePort,
    private readonly stateDirectory: string,
  ) {}

  private summaryFilePath(missionId: string): string {
    return path.join(
      this.stateDirectory,
      "missions",
      missionId,
      "summary.json",
    );
  }

  async createMission(input: CreateMissionInput): Promise<TaskChainDocument> {
    const document: TaskChainDocument = {
      schemaVersion: 1,
      missionId: input.missionId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      tasks: input.taskNodes,
    };
    const parsed = taskChainSchema.safeParse(document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `任务链非法: ${parsed.error.message}`,
      );
    }
    await this.taskStore.writeTaskChain(parsed.data);
    const summary: MissionSummary = {
      schemaVersion: 1,
      missionId: input.missionId,
      mode: input.mode,
      prompt: input.prompt,
      createdAtIso: new Date().toISOString(),
      status: "running",
    };
    await this.summaryWriteMutex.runExclusive(() =>
      writeAtomicJson(this.summaryFilePath(input.missionId), summary),
    );
    return parsed.data;
  }

  async updateMissionStatus(
    missionId: string,
    status: MissionSummary["status"],
  ): Promise<void> {
    await this.summaryWriteMutex.runExclusive(async () => {
      const summary = await this.readSummary(missionId);
      if (summary === null) {
        return;
      }
      await writeAtomicJson(this.summaryFilePath(missionId), {
        ...summary,
        status,
      });
    });
  }

  async readSummary(missionId: string): Promise<MissionSummary | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const rawContent = await readFile(this.summaryFilePath(missionId), "utf8");
      return JSON.parse(rawContent) as MissionSummary;
    } catch {
      return null;
    }
  }

  async getMissionStatus(missionId: string): Promise<MissionStatus> {
    const summary = await this.readSummary(missionId);
    const taskChain = await this.taskStore.readTaskChain(missionId);
    if (summary === null && taskChain === null) {
      throw new DomainError("mission-not-found", `任务不存在: ${missionId}`);
    }
    return { missionId, summary, taskChain };
  }

  async listMissionIds(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const missionsDirectory = path.join(this.stateDirectory, "missions");
    try {
      return await readdir(missionsDirectory);
    } catch {
      return [];
    }
  }
}
