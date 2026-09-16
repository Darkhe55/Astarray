/**
 * ACCURACY-03：准确性 CLI（status/configure）——档位与预算经公共门面读写，关闭状态如实输出。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeAccuracyConfigureCommand,
  executeAccuracyStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-accuracy-cli-"));
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

describe("ACCURACY-03 准确性 CLI", () => {
  it("status 默认标准档开启；configure 后新进程读到 strict", async () => {
    const defaultCapture = captureStdout();
    const defaultExit = await executeAccuracyStatusCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(defaultExit).toBe(0);
    expect(JSON.parse(defaultCapture.getOutput())).toMatchObject({
      status: "ok",
      policy: { isEnabled: true, tier: "standard", revision: 1 },
    });

    const configureCapture = captureStdout();
    const configureExit = await executeAccuracyConfigureCommand({
      stateDirectory,
      tier: "strict",
      isEnabled: undefined,
      maximumModelCallCount: 2,
      maximumWallClockMilliseconds: undefined,
      expectedRevision: undefined,
      isJsonOutput: true,
    });
    expect(configureExit).toBe(0);
    expect(JSON.parse(configureCapture.getOutput())).toMatchObject({
      status: "ok",
      policy: {
        tier: "strict",
        revision: 2,
        budget: { maximumModelCallCount: 2 },
      },
    });

    // 跨进程：另一个 CLI 进程读到同一持久化策略。
    const secondCapture = captureStdout();
    await executeAccuracyStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(JSON.parse(secondCapture.getOutput())).toMatchObject({
      policy: { tier: "strict", revision: 2 },
    });
  }, 90_000);

  it("非法档位返回用法错误；关闭档位如实输出 enabled=false", async () => {
    captureStdout();
    const invalidExit = await executeAccuracyConfigureCommand({
      stateDirectory,
      tier: "sloppy",
      isEnabled: undefined,
      maximumModelCallCount: undefined,
      maximumWallClockMilliseconds: undefined,
      expectedRevision: undefined,
      isJsonOutput: true,
    });
    expect(invalidExit).toBe(2);

    const disableCapture = captureStdout();
    const disableExit = await executeAccuracyConfigureCommand({
      stateDirectory,
      tier: undefined,
      isEnabled: false,
      maximumModelCallCount: undefined,
      maximumWallClockMilliseconds: undefined,
      expectedRevision: undefined,
      isJsonOutput: true,
    });
    expect(disableExit).toBe(0);
    expect(JSON.parse(disableCapture.getOutput())).toMatchObject({
      policy: { isEnabled: false, revision: 2 },
    });
  }, 90_000);

  it("陈旧 revision 配置失败且不覆盖已持久化策略", async () => {
    captureStdout();
    await executeAccuracyConfigureCommand({
      stateDirectory,
      tier: "strict",
      isEnabled: undefined,
      maximumModelCallCount: undefined,
      maximumWallClockMilliseconds: undefined,
      expectedRevision: undefined,
      isJsonOutput: true,
    });

    const staleCapture = captureStdout();
    const staleExit = await executeAccuracyConfigureCommand({
      stateDirectory,
      tier: "fast",
      isEnabled: undefined,
      maximumModelCallCount: undefined,
      maximumWallClockMilliseconds: undefined,
      expectedRevision: 1,
      isJsonOutput: true,
    });
    expect(staleExit).toBe(1);

    const statusCapture = captureStdout();
    await executeAccuracyStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(JSON.parse(staleCapture.getOutput() + statusCapture.getOutput())).toMatchObject({
      policy: { tier: "strict", revision: 2 },
    });
  }, 90_000);
});
