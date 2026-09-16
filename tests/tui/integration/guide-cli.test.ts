/**
 * GUIDE-01-04：指导 CLI（submit/status）——受理不等于已应用，延迟如实呈现。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeGuideStatusCommand,
  executeGuideSubmitCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guide-cli-"));
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

describe("GUIDE-01-04 指导 CLI", () => {
  it("无指导时 status 返回 no-guidance；submit 后为 queued 且延迟为空", async () => {
    const emptyCapture = captureStdout();
    const emptyExit = await executeGuideStatusCommand({
      stateDirectory,
      guidanceIdentifier: undefined,
      isJsonOutput: true,
    });
    expect(emptyExit).toBe(0);
    expect(JSON.parse(emptyCapture.getOutput())).toMatchObject({
      status: "no-guidance",
    });

    const submitCapture = captureStdout();
    const submitExit = await executeGuideSubmitCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      instructionText: "把写入改为只读校验",
      behaviorTier: "safe-point-guidance",
      isJsonOutput: true,
    });
    expect(submitExit).toBe(0);
    const submitted = JSON.parse(submitCapture.getOutput()) as {
      status: string;
      guidanceIdentifier: string;
      reasons: string[];
    };
    expect(submitted.status).toBe("accepted");
    expect(submitted.guidanceIdentifier).toBeTruthy();

    // 单进程 CLI 没有运行中的任务消费：状态保持 queued，延迟为 null（不虚报已应用）。
    const statusCapture = captureStdout();
    const statusExit = await executeGuideStatusCommand({
      stateDirectory,
      guidanceIdentifier: submitted.guidanceIdentifier,
      isJsonOutput: true,
    });
    expect(statusExit).toBe(0);
    const statusPayload = JSON.parse(statusCapture.getOutput()) as {
      status: string;
      entries: Array<{
        status: string;
        latencyMilliseconds: number | null;
        appliedAtIso: string | null;
      }>;
    };
    expect(statusPayload.status).toBe("ok");
    expect(statusPayload.entries).toHaveLength(1);
    expect(statusPayload.entries[0]?.status).toBe("queued");
    expect(statusPayload.entries[0]?.latencyMilliseconds).toBeNull();
    expect(statusPayload.entries[0]?.appliedAtIso).toBeNull();
    // 跨进程持久化：另一个 CLI 进程仍能查到提交记录，且如实标注应用状态未知。
    expect(
      (statusPayload.entries[0] as { isApplicationStatusKnown?: boolean })
        .isApplicationStatusKnown,
    ).toBe(false);
  }, 60_000);

  it("空指导文本返回用法错误（2），不产生队列条目", async () => {
    captureStdout();
    const exitCode = await executeGuideSubmitCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      instructionText: "   ",
      behaviorTier: "safe-point-guidance",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);

    const statusCapture = captureStdout();
    await executeGuideStatusCommand({
      stateDirectory,
      guidanceIdentifier: undefined,
      isJsonOutput: true,
    });
    expect(JSON.parse(statusCapture.getOutput())).toMatchObject({
      status: "no-guidance",
    });
  }, 60_000);
});
