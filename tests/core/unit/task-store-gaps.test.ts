/**
 * B6R-11：TaskStore 缺口分支（writeTaskChain schemaVersion 不匹配拒绝 114）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ts-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    revision: 1,
    updatedAtIso: "2026-08-16T00:00:00.000Z",
    tasks: [
      {
        id: "t1",
        description: "任务一",
        dependsOn: [],
        taskType: "project",
        toolNames: ["project.read"],
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ],
    ...overrides,
  } as never;
}

describe("TaskStore 缺口分支", () => {
  it("不支持的 schemaVersion → 拒绝（114）", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.writeTaskChain(makeDocument({ schemaVersion: 99 })),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("正常写入 → 读取往返", async () => {
    const store = new TaskStore({ baseDirectory: temporaryDirectory });
    await store.writeTaskChain(makeDocument());
    const document = await store.readTaskChain("mission-1");
    expect(document?.missionId).toBe("mission-1");
    expect(await store.readTaskChain("mission-ghost")).toBeNull();
  });
});
