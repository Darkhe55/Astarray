/**
 * GUIDE 增量：指导变更 CLI（change/history）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeGuideChangeCommand,
  executeGuideHistoryCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guide-change-cli-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    },
  );
  return { getOutput: () => chunks.join("") };
}

function changeOptions(overrides: Record<string, unknown> = {}) {
  return {
    stateDirectory,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    instructionText: "追加一条验收要求",
    changeIntent: "append" as string | null,
    requestedTaskSequenceRevision: 1,
    newTaskIdentifier: null,
    invalidatedArtifactIdentifiers: [] as string[],
    invalidatedAcceptanceEntryIdentifiers: [] as string[],
    behaviorTier: "safe-point-guidance" as const,
    isJsonOutput: true,
    ...overrides,
  };
}

describe("GUIDE 增量 CLI", () => {
  it("change append → 接受并显示新 revision；history 可见", async () => {
    const changeCapture = captureStdout();
    const changeExit = await executeGuideChangeCommand(changeOptions());
    expect(changeExit).toBe(0);
    const changePayload = JSON.parse(changeCapture.getOutput()) as {
      status: string;
      result: { changeIntent: string; newTaskSequenceRevision: number };
    };
    expect(changePayload.status).toBe("accepted");
    expect(changePayload.result.changeIntent).toBe("append");
    expect(changePayload.result.newTaskSequenceRevision).toBe(2);

    const historyCapture = captureStdout();
    const historyExit = await executeGuideHistoryCommand({
      stateDirectory,
      taskIdentifier: "task-1",
      isJsonOutput: true,
    });
    expect(historyExit).toBe(0);
    expect(JSON.parse(historyCapture.getOutput())).toMatchObject({
      status: "ok",
      entries: [{ taskSequenceRevision: 2, changeIntent: "append" }],
    });
  }, 90_000);

  it("未指定意图 → 澄清（exit 0，question 可见）", async () => {
    const capture = captureStdout();
    const exitCode = await executeGuideChangeCommand(
      changeOptions({ changeIntent: null }),
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.getOutput()) as {
      status: string;
      result: { clarificationQuestion: string | null };
    };
    expect(payload.status).toBe("needs-clarification");
    expect(payload.result.clarificationQuestion).toBeTruthy();
  }, 90_000);

  it("非法意图 → 用法错误（2）；陈旧 revision → 失败（1）", async () => {
    captureStdout();
    const invalidExit = await executeGuideChangeCommand(
      changeOptions({ changeIntent: "replace-everything" }),
    );
    expect(invalidExit).toBe(2);

    captureStdout();
    await executeGuideChangeCommand(changeOptions());
    captureStdout();
    const staleExit = await executeGuideChangeCommand(
      changeOptions({
        requestedTaskSequenceRevision: 1,
        instructionText: "落后观察（不同指导）",
      }),
    );
    expect(staleExit).toBe(1);
  }, 90_000);
});
