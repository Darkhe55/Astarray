/**
 * Ponder 任务入口反例：Ponder 是本地只读问答（ADR-0014），不产生 mission。
 * 修复前：submitTask 回 accepted 且 missionIdentifier="ponder"，随后 queryTask 抛 mission-not-found（虚报受理）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ponder-entry-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createPonderApplication(): Promise<AstarrayApplicationFacade> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "ponder",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "s", mode: "ponder" });
  return application;
}

describe("Ponder 任务入口", () => {
  it("submitTask 明确拒绝：不产生 mission、不虚报受理", async () => {
    const application = await createPonderApplication();
    await expect(
      application.submitTask({
        sessionId: "s",
        taskIdentifier: "t-1",
        prompt: "只读问题",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-mode-transition" });
    await application.shutdown();
  });

  it("handleUserMessage 是 Ponder 的直接问答入口", async () => {
    const application = await createPonderApplication();
    const answer = await application.handleUserMessage("只读问题");
    expect(typeof answer).toBe("string");
    expect(answer.length).toBeGreaterThan(0);
    await application.shutdown();
  });
});
