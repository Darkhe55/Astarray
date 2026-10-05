/**
 * SMART-01-04 入口补做：CLI 四命令的端到端行为（真实子进程，隔离状态目录）。
 *
 * 覆盖：`perf overview`、`usage overview`、`doctor --errors`、`cross-project list`。
 * 纪律：全部只读 —— 运行前**隔离状态目录**，运行后目录内容不得变化；不得联网。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let baseDirectory: string;
const cliEntryPath = path.resolve(process.cwd(), "dist", "cli.js");

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-entry-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cliEntryPath, ...args], {
      // cwd = 隔离目录：CLI 的 defaultStateDirectory() 为 cwd/.astarray，故状态落在隔离目录内
      cwd: baseDirectory,
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

/** 只读端点不得在隔离目录中创建状态目录。 */
async function hasStateDirectoryBeenCreated(): Promise<boolean> {
  try {
    await fs.access(path.join(baseDirectory, ".astarray"));
    return true;
  } catch {
    return false;
  }
}

describe("CLI 入口补做：四命令可用且只读", () => {
  it("① perf overview --json：exit 0 且覆盖范围齐备，不报零耗时", async () => {
    const result = await runCli(["perf", "overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      coverage: { totalSampleCount: number };
      metrics: { durationMilliseconds: { mean: number | null }; isReportable: boolean };
    };
    expect(parsed.coverage.totalSampleCount).toBe(0);
    expect(parsed.metrics.durationMilliseconds.mean).toBeNull();
    expect(parsed.metrics.isReportable).toBe(false);
    expect(await hasStateDirectoryBeenCreated()).toBe(false);
  });

  it("② usage overview --json：exit 0，含免责说明且不虚报余额", async () => {
    const result = await runCli(["usage", "overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      costEstimate: { amountMinorUnits: number | null; disclaimer: string };
      coverage: { totalEntryCount: number };
    };
    expect(parsed.coverage.totalEntryCount).toBe(0);
    expect(parsed.costEstimate.amountMinorUnits).toBeNull();
    expect(parsed.costEstimate.disclaimer).toContain("官方");
    expect(await hasStateDirectoryBeenCreated()).toBe(false);
  });

  it("③ doctor --errors --json：exit 0，事实/推断/证据不足分列且不可报告时不报正常", async () => {
    const result = await runCli(["doctor", "--errors", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      deterministicFindings: unknown[];
      suspectedFindings: unknown[];
      insufficientEvidenceFindings: unknown[];
      isReportable: boolean;
      unreportableReason: string | null;
    };
    expect(parsed.deterministicFindings).toEqual([]);
    expect(parsed.suspectedFindings).toEqual([]);
    expect(parsed.insufficientEvidenceFindings).toEqual([]);
    expect(parsed.isReportable).toBe(false);
    expect(parsed.unreportableReason).toContain("样本不足");
    expect(await hasStateDirectoryBeenCreated()).toBe(false);
  });

  it("④ doctor --bundle：脱敏预览且不落盘", async () => {
    const result = await runCli(["doctor", "--bundle", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      redactionNotice: string;
      containsFullSession: boolean;
      containsSourceCode: boolean;
      containsRawLogs: boolean;
    };
    expect(parsed.redactionNotice).toContain("脱敏");
    expect(parsed.containsFullSession).toBe(false);
    expect(parsed.containsSourceCode).toBe(false);
    expect(parsed.containsRawLogs).toBe(false);
    expect(await hasStateDirectoryBeenCreated()).toBe(false);
  });

  it("⑤ cross-project list --json：exit 0，授权与副本结构齐备且只读", async () => {
    const result = await runCli(["cross-project", "list", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      filter: { sourceProjectIdentifier: string | null };
      authorizations: unknown[];
      copyReceipts: { count: number; receipts: unknown[] };
    };
    expect(parsed.filter.sourceProjectIdentifier).toBeNull();
    expect(parsed.authorizations).toEqual([]);
    expect(parsed.copyReceipts.count).toBe(0);
    expect(await hasStateDirectoryBeenCreated()).toBe(false);
  });

  it("⑥ 非法参数仍须用法错误（退出码 2），不得静默按默认值执行", async () => {
    const perfResult = await runCli(["perf", "overview", "--detail", "verbose"]);
    expect(perfResult.exitCode).toBe(2);
    const usageResult = await runCli(["usage", "overview", "--input-token-budget", "abc"]);
    expect(usageResult.exitCode).toBe(2);
  });
});
