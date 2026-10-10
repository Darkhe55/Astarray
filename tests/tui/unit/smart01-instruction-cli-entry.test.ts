/**
 * SMART-01-04 反例（2026-10-10）：指令窗口的 **CLI 入口**必须与 SDK 入口**共享同一状态**。
 *
 * 卡内检查点要求"SDK/CLI/TUI/GUI 入口"；只做 SDK 不算完成。
 * 本文件钉住 CLI 侧最窄闭环：
 *  - `astarray instruction accept` 接收指令（上限 3，第 4 条**排队**不丢弃）；
 *  - `astarray instruction list` 只读展示窗口内/排队/终态；
 *  - **同一状态目录**下 CLI 写入的指令，SDK `queryInstructionWindow` 必须看得到（同一窗口，不是第二套）；
 *  - 超期必须**如实**报超时（`isTruthfulTimeout=true`），不得伪报已派发/已完成；
 *  - 未知幂等键必须响亮失败（非 0 退出码），不得伪造一条指令。
 *
 * 实现前：`executeInstructionAcceptCommand` 等入口不存在 ⇒ 本文件必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  executeInstructionAcceptCommand,
  executeInstructionDeadlineCommand,
  executeInstructionListCommand,
} from "../../../packages/tui/src/cli/commands.js";

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let stateDirectory: string;

/** 运行真实构建产物 `dist/cli.js`（改 src 后必须先 npm run build）。 */
async function runCli(
  args: string[],
  workingDirectory: string,
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const childProcess = spawn(process.execPath, [cliEntryPath, ...args], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdoutText = "";
  let stderrText = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => (stdoutText += chunk));
  childProcess.stderr.on("data", (chunk: string) => (stderrText += chunk));
  const exitCode = await new Promise<number>((resolve) => {
    childProcess.on("close", (code: number | null) => resolve(code ?? 1));
  });
  return { exitCode, stdoutText, stderrText };
}

let projectDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart01-cli-"));
  projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart01-cli-cwd-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(projectDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("SMART-01-04：指令窗口 CLI 入口", () => {
  it("① accept：上限 3 时第 4 条排队（exit 0），窗口文件落盘", async () => {
    const outcomes: number[] = [];
    for (let index = 1; index <= 4; index += 1) {
      outcomes.push(
        await executeInstructionAcceptCommand({
          stateDirectory,
          instructionText: "CLI 指令 " + String(index),
          idempotencyKey: "cli-k-" + String(index),
          isJsonOutput: true,
        }),
      );
    }
    expect(outcomes).toEqual([0, 0, 0, 0]);
    const windowFilePath = path.join(
      stateDirectory,
      "instruction-window",
      "instruction-window.json",
    );
    expect((await fs.readFile(windowFilePath, "utf8")).length).toBeGreaterThan(0);
  });

  it("② list 与 SDK 共享同一窗口：CLI 写入的指令 SDK 必须看得到", async () => {
    await executeInstructionAcceptCommand({
      stateDirectory,
      instructionText: "共享窗口指令",
      idempotencyKey: "cli-shared",
      isJsonOutput: true,
    });
    const exitCode = await executeInstructionListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);

    // 同一状态目录的 SDK facade 必须读到同一条指令（不是第二套窗口）。
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      concurrency: 2,
      failureThreshold: 3,
    });
    try {
      application.createSession({ sessionId: "s-cli", mode: "assist" });
      const snapshot = await application.queryInstructionWindow({ sessionId: "s-cli" });
      expect(snapshot.windowCapacity).toBe(3);
      expect(snapshot.activeInstructions.map((record) => record.instructionText)).toContain(
        "共享窗口指令",
      );
    } finally {
      await application.shutdown();
    }
  });

  it("③ deadline：超期必须如实报超时（不得伪报已派发/已完成）", async () => {
    const acceptedAtIso = "2026-10-10T00:00:00.000Z";
    await executeInstructionAcceptCommand({
      stateDirectory,
      instructionText: "会超期的指令",
      idempotencyKey: "cli-overdue",
      nowIso: acceptedAtIso,
      isJsonOutput: true,
    });

    const withinDeadlineExit = await executeInstructionDeadlineCommand({
      stateDirectory,
      idempotencyKey: "cli-overdue",
      nowIso: "2026-10-10T00:02:59.000Z",
      isJsonOutput: true,
    });
    expect(withinDeadlineExit).toBe(0);

    const overdueExit = await executeInstructionDeadlineCommand({
      stateDirectory,
      idempotencyKey: "cli-overdue",
      nowIso: "2026-10-10T00:03:01.000Z",
      isJsonOutput: true,
    });
    // 超期是**如实报告**，不是命令失败：必须 exit 0 且不得终止进程异常。
    expect(overdueExit).toBe(0);
  });

  it("④ 未知幂等键：必须非 0 退出码（响亮失败，不伪造指令）", async () => {
    const exitCode = await executeInstructionDeadlineCommand({
      stateDirectory,
      idempotencyKey: "cli-unknown",
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
  });

  /**
   * ⑤ 真实构建产物端到端：`dist/cli.js instruction accept` 写入后，
   * **另一个进程**（SDK facade）必须读到同一条指令 ⇒ 共享的是**同一落盘窗口**，
   * 不是同进程内存里的第二套计数。这也是"CLI 入口"真正接线的证据。
   */
  it("⑤ dist/cli.js 与 SDK 跨进程共享同一窗口（第 4 条排队、超期如实报超时）", async () => {
    for (let index = 1; index <= 4; index += 1) {
      const result = await runCli(
        [
          "instruction",
          "accept",
          "跨进程指令 " + String(index),
          "--idempotency-key",
          "x-" + String(index),
          "--now",
          "2026-10-10T00:00:00.000Z",
          "--json",
        ],
        projectDirectory,
      );
      expect(result.exitCode).toBe(0);
    }
    const acceptFourth = await runCli(
      [
        "instruction",
        "accept",
        "跨进程指令 4",
        "--idempotency-key",
        "x-4",
        "--now",
        "2026-10-10T00:00:00.000Z",
        "--json",
      ],
      projectDirectory,
    );
    // 同键同参 → 幂等复用（不重复占位、不新增指令）。
    expect(acceptFourth.exitCode).toBe(0);
    expect(acceptFourth.stdoutText).toContain("duplicate-idempotent");

    // 另一个进程读同一状态目录：必须是同一个窗口。
    const cliStateDirectory = path.join(projectDirectory, ".astarray");
    const application = await AstarrayApplicationFacade.create({
      stateDirectory: cliStateDirectory,
      mode: "assist",
      runtime: "mock",
      concurrency: 2,
      failureThreshold: 3,
    });
    try {
      application.createSession({ sessionId: "s-dist", mode: "assist" });
      const snapshot = await application.queryInstructionWindow({ sessionId: "s-dist" });
      expect(snapshot.windowCapacity).toBe(3);
      expect(snapshot.activeInstructions).toHaveLength(3);
      expect(snapshot.queuedInstructions.map((record) => record.instructionText)).toEqual([
        "跨进程指令 4",
      ]);
    } finally {
      await application.shutdown();
    }

    // 超期评估（CLI 侧）：必须如实报超时。
    const overdue = await runCli(
      [
        "instruction",
        "deadline",
        "--idempotency-key",
        "x-4",
        "--now",
        "2026-10-10T00:03:01.000Z",
        "--json",
      ],
      projectDirectory,
    );
    expect(overdue.exitCode).toBe(0);
    expect(overdue.stdoutText).toContain("overdue-not-dispatched");
    expect(overdue.stdoutText).toContain('"isTruthfulTimeout": true');

    // 未知键（CLI 侧）：响亮失败。
    const unknown = await runCli(
      ["instruction", "deadline", "--idempotency-key", "x-nope", "--json"],
      projectDirectory,
    );
    expect(unknown.exitCode).not.toBe(0);
  }, 120_000);
});
