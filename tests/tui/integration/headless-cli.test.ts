/**
 * T11 Headless CLI 集成测试：执行构建产物 dist/cli.js。
 * 断言：stdout 仅 JSON、退出码稳定、错误走 stderr。
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const distCliPath = path.join(process.cwd(), "dist", "cli.js");
const hasBuiltCli = existsSync(distCliPath);

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
});

function runCli(
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [distCliPath, ...args], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? -1,
  };
}

describe.skipIf(!hasBuiltCli)("Headless CLI（构建产物）", () => {
  it("run --runtime mock --json：stdout 仅 JSON，mission 完成", () => {
    const result = runCli(["run", "冒烟任务", "--mode", "assist", "--runtime", "mock", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      missionId: string;
      status: string;
      mode: string;
    };
    expect(parsed.missionId).toMatch(/^mission-/);
    expect(parsed.status).toBe("done");
    expect(parsed.mode).toBe("assist");
    expect(result.stderr).not.toContain(parsed.missionId);
  });

  it("run 非法模式：退出码 2，stdout 为空，错误在 stderr", () => {
    const result = runCli(["run", "x", "--mode", "bogus", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("配置非法");
  });

  it("run 非 json 模式拒绝", () => {
    const result = runCli(["run", "x", "--mode", "assist", "--runtime", "mock"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--json");
  });

  it("run 后 status <mission-id> --json 返回任务链", () => {
    const runResult = runCli(["run", "状态查询", "--mode", "assist", "--runtime", "mock", "--json"]);
    const { missionId } = JSON.parse(runResult.stdout) as { missionId: string };
    const statusResult = runCli(["status", missionId, "--json"]);
    expect(statusResult.exitCode).toBe(0);
    const parsed = JSON.parse(statusResult.stdout) as {
      missionId: string;
      status: string;
      tasks: unknown[];
    };
    expect(parsed.missionId).toBe(missionId);
    expect(parsed.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("status（无参数）列出 mission，stdout 无 JSON 包装", () => {
    runCli(["run", "列表任务", "--mode", "assist", "--runtime", "mock", "--json"]);
    const listResult = runCli(["status"]);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout.trim()).toMatch(/^mission-[a-f0-9]+$/);
  });

  it("status 不存在的 mission：退出码 2，错误在 stderr", () => {
    const result = runCli(["status", "mission-ghost", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("任务不存在");
  });

  it("cancel 已完成的 mission：返回 cancelled", () => {
    const runResult = runCli(["run", "待取消", "--mode", "assist", "--runtime", "mock", "--json"]);
    const { missionId } = JSON.parse(runResult.stdout) as { missionId: string };
    const cancelResult = runCli(["cancel", missionId, "--json"]);
    expect(cancelResult.exitCode).toBe(0);
    const parsed = JSON.parse(cancelResult.stdout) as { status: string };
    expect(parsed.status).toBe("cancelled");
  });

  it("resume 已完成的 mission：resumed=false", () => {
    const runResult = runCli(["run", "恢复任务", "--mode", "assist", "--runtime", "mock", "--json"]);
    const { missionId } = JSON.parse(runResult.stdout) as { missionId: string };
    const resumeResult = runCli(["resume", missionId, "--json"]);
    expect(resumeResult.exitCode).toBe(0);
    const parsed = JSON.parse(resumeResult.stdout) as { resumed: boolean };
    expect(parsed.resumed).toBe(false);
  });

  it("doctor --json：健康报告", () => {
    const result = runCli(["doctor", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { health: string; checks: Record<string, boolean> };
    expect(parsed.health).toBe("ok");
    expect(parsed.checks.nodeVersionSupported).toBe(true);
  });

  it("doctor（文本）：health ok", () => {
    const result = runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("health: ok");
  });

  it("config init：写入配置", async () => {
    const result = runCli(["config", "init"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("written:");
    const rawConfig = await fs.readFile(
      path.join(workingDirectory, ".astarray", "config.json"),
      "utf8",
    );
    const configContent = JSON.parse(rawConfig) as { mode: string };
    expect(configContent.mode).toBe("assist");
  });
});
