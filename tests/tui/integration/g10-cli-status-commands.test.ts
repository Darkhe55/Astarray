/**
 * G10 验收（2026-11-08，第 185 轮）：`preset list` 与 `concurrent status` **真的能从 CLI 调用**。
 *
 * ## 背景（G10）
 *
 * 这两个命令**早就实现**（`commands.ts` 里的 `executePresetListCommand` /
 * `executeConcurrentStatusCommand`），但**全仓没有任何 argv 分发** ⇒ 用户无法调用。
 * 第 184 轮已在 `cli.tsx` 按既有 commander 风格接入。
 *
 * ## 验收方式（真实入口）
 *
 * 用**真实子进程**跑构建产物 `dist/cli.js`（与 `tests/tui/integration/cli-observability-entry.test.ts`
 * 同一做法），`cwd` 用隔离目录（CLI 的 `defaultStateDirectory()` = `cwd/.astarray`）。
 *
 * ## 断言（读 G9 之后的如实语义）
 *
 * - 退出码 0；
 * - `--json` 输出可解析，且含 `modulesLoadable` 与 `componentsReadySemantics`
 *   （**不是**旧的不实字段 `componentsReady`）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const cliEntryPath = path.resolve(process.cwd(), "dist", "cli.js");

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g10-cli-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5 });
});

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliEntryPath, ...args], {
      cwd: workingDirectory,
      env: { ...process.env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("G10：两个此前未分发的状态命令必须可从 CLI 调用", () => {
  it("`preset list --json`：退出码 0，输出含如实的 modulesLoadable 语义", async () => {
    const result = await runCli(["preset", "list", "--json"]);
    expect(result.exitCode, "stderr: " + result.stderr.slice(0, 400)).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.modulesLoadable).toBeDefined();
    expect(parsed.componentsReadySemantics).toBe("module-loadable-not-assembly");
    expect(parsed.componentsReady, "旧的不实字段不得出现").toBeUndefined();
  });

  it("`concurrent status --json`：退出码 0，输出含如实的 modulesLoadable 语义", async () => {
    const result = await runCli(["concurrent", "status", "--json"]);
    expect(result.exitCode, "stderr: " + result.stderr.slice(0, 400)).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.modulesLoadable).toBeDefined();
    expect(parsed.componentsReadySemantics).toBe("module-loadable-not-assembly");
    expect(parsed.componentsReady).toBeUndefined();
  });
});
