/**
 * 行为反例（RELIABILITY-01-02 · R2，2026-10-02）：
 *
 * 审计（RELIABILITY-01-01 §疑点3）确认：`GitProcess` 超时只对**单个进程**发 SIGKILL，
 * 未做进程树/进程组收口 → 子进程派生的孙进程可能继续存活（残留句柄/继续写盘）。
 * 卡内要求："核查子进程树收口、退出确认、锁释放及远端结果对账；
 *          超时不能等同操作失败或停止成功。"
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";

vi.setConfig({ testTimeout: 60_000 });

let workingDirectoryPath: string;

beforeEach(async () => {
  workingDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-git-tree-"));
});

afterEach(async () => {
  try {
    await fs.rm(workingDirectoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

/** 孙进程心跳：每 50ms 追加一行；文件停止增长即表示孙进程已被收口。 */
function buildGrandchildHeartbeatScript(heartbeatPath: string): string {
  const escapedPath = heartbeatPath.replace(/\\/g, "\\\\");
  return [
    'const fs = require("node:fs");',
    "const timer = setInterval(() => {",
    `  try { fs.appendFileSync("${escapedPath}", "beat\\n"); } catch {}`,
    "}, 50);",
    "timer.unref?.();",
    "setTimeout(() => process.exit(0), 60000);",
  ].join("\n");
}

function buildParentScript(heartbeatPath: string): string {
  return [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(buildGrandchildHeartbeatScript(heartbeatPath))}], { stdio: "ignore", windowsHide: true });`,
    "child.unref();",
    "setTimeout(() => process.exit(0), 60000);",
  ].join("\n");
}

function countHeartbeatLines(heartbeatPath: string): number {
  if (!existsSync(heartbeatPath)) {
    return 0;
  }
  return readFileSync(heartbeatPath, "utf8").split("\n").filter((line) => line === "beat").length;
}

describe("GitProcess 超时的进程树收口（R2）", () => {
  it("⓪ 夹具活性：孙进程确实启动并在写心跳（否则本文件无判定力）", async () => {
    const heartbeatPath = path.join(workingDirectoryPath, "heartbeat-liveness.txt");
    const gitProcess = new GitProcess({
      gitCommandTimeoutSeconds: 30,
      executablePath: process.execPath,
      executableArgumentsPrefix: ["-e", buildParentScript(heartbeatPath)],
    });

    // 让夹具运行 1.2s 后主动放弃等待（不依赖超时），确认孙进程已写入心跳。
    await Promise.race([
      gitProcess.run(workingDirectoryPath, [], "夹具命令（活性）").catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 1_200)),
    ]);
    expect(countHeartbeatLines(heartbeatPath)).toBeGreaterThan(3);
  });

  it("① 超时后孙进程必须被收口（心跳停止增长）", async () => {
    const heartbeatPath = path.join(workingDirectoryPath, "heartbeat.txt");
    const gitProcess = new GitProcess({
      gitCommandTimeoutSeconds: 1,
      executablePath: process.execPath,
      executableArgumentsPrefix: ["-e", buildParentScript(heartbeatPath)],
    });

    // 超时必须可区分（不得等同操作失败）。
    await expect(
      gitProcess.run(workingDirectoryPath, [], "夹具命令（超时用例）"),
    ).rejects.toThrow(/超时/);

    // 让孙进程有机会暴露：等待 1.5s 后统计心跳（若仍存活会继续增长）。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const firstCount = countHeartbeatLines(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const secondCount = countHeartbeatLines(heartbeatPath);

    expect(secondCount).toBe(firstCount);
  });
});
