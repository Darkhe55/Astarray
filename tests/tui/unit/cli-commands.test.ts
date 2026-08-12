/**
 * T11 CLI 命令单元测试：直接调用命令函数（temp 状态目录），不 spawn 进程。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCancelCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeConfigInitCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeDoctorCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeResumeCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeStatusCommand } from "../../../packages/tui/src/cli/commands.js";
import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";

let stateDirectory: string;
let originalCwd: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-unit-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

function captureStdout(): { write: (chunk: string) => void; getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    write: () => {},
    getOutput: () => chunks.join(""),
  };
}

describe("CLI 命令（直接调用）", () => {
  it("run：mock 运行时 mission 完成，stdout 为 JSON", async () => {
    const stdoutCapture = captureStdout();
    const exitCode = await executeRunCommand({
      prompt: "单元测试任务",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutCapture.getOutput()) as { missionId: string; status: string };
    expect(parsed.status).toBe("done");
    expect(parsed.missionId).toMatch(/^mission-/);
  }, 20_000);

  it("run：非法 runtime 退出码 2", async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeRunCommand({
      prompt: "x",
      mode: "assist",
      runtime: "openai-compatible",
      isJsonOutput: true,
      stateDirectory,
    }).catch(() => 2);
    expect(exitCode).toBe(2);
    expect(stderrChunks.join("")).toContain("尚未支持");
  });

  it("run：非 --json 退出码 2", async () => {
    const exitCode = await executeRunCommand({
      prompt: "x",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: false,
      stateDirectory,
    }).catch(() => 2);
    expect(exitCode).toBe(2);
  });

  it("status：列出 mission 与单个 mission 详情", async () => {
    const runStdout = captureStdout();
    await executeRunCommand({
      prompt: "状态测试",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    const { missionId } = JSON.parse(runStdout.getOutput()) as { missionId: string };

    const listCapture = captureStdout();
    const listExitCode = await executeStatusCommand({
      missionId: undefined,
      isJsonOutput: true,
      stateDirectory,
    });
    expect(listExitCode).toBe(0);
    const listParsed = JSON.parse(listCapture.getOutput()) as { missions: string[] };
    expect(listParsed.missions).toContain(missionId);

    const detailCapture = captureStdout();
    await executeStatusCommand({
      missionId,
      isJsonOutput: true,
      stateDirectory,
    });
    const detailParsed = JSON.parse(detailCapture.getOutput()) as {
      missionId: string;
      status: string;
      tasks: unknown[];
    };
    expect(detailParsed.missionId).toBe(missionId);
    expect(detailParsed.tasks.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("status：文本输出", async () => {
    const stdoutCapture = captureStdout();
    await executeStatusCommand({
      missionId: undefined,
      isJsonOutput: false,
      stateDirectory,
    });
    expect(stdoutCapture.getOutput().trim()).toBe("");
  });

  it("cancel：任务不存在时退出码 2", async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeCancelCommand({
      missionId: "mission-ghost",
      isJsonOutput: true,
      stateDirectory,
    }).catch(() => 2);
    expect(exitCode).toBe(2);
    expect(stderrChunks.join("")).toContain("任务不存在");
  });

  it("resume：不存在的 mission 退出码 2", async () => {
    const exitCode = await executeResumeCommand({
      missionId: "mission-ghost",
      isJsonOutput: true,
      stateDirectory,
    }).catch(() => 2);
    expect(exitCode).toBe(2);
  });

  it("doctor：JSON 健康报告", async () => {
    const stdoutCapture = captureStdout();
    const exitCode = await executeDoctorCommand({
      isJsonOutput: true,
      stateDirectory,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutCapture.getOutput()) as { health: string };
    expect(parsed.health).toBe("ok");
  });

  it("doctor：状态目录不可写时 health=failed", async () => {
    // 用同名文件占位，使 mkdir 失败
    await fs.rm(stateDirectory, { recursive: true, force: true });
    await fs.writeFile(stateDirectory, "占位", "utf8");
    const stdoutCapture = captureStdout();
    const exitCode = await executeDoctorCommand({
      isJsonOutput: true,
      stateDirectory,
    });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdoutCapture.getOutput()) as {
      health: string;
      checks: Record<string, boolean>;
    };
    expect(parsed.health).toBe("failed");
    expect(parsed.checks.stateDirectoryWritable).toBe(false);
  });

  it("config init：写入默认配置", async () => {
    const stdoutCapture = captureStdout();
    const exitCode = await executeConfigInitCommand({ stateDirectory });
    expect(exitCode).toBe(0);
    expect(stdoutCapture.getOutput()).toContain("written:");
    const configPath = path.join(stateDirectory, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { mode: string };
    expect(config.mode).toBe("assist");
  });

  it("config init：已存在目录时幂等", async () => {
    await executeConfigInitCommand({ stateDirectory });
    await executeConfigInitCommand({ stateDirectory });
    const configPath = path.join(stateDirectory, "config.json");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      mode: "assist",
    });
  });

  it("config init 覆盖已有配置前自动备份（审计 S7）", async () => {
    const configPath = path.join(stateDirectory, "config.json");
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ mode: "devolve", 用户配置: "必须保留" }, null, 2),
      "utf8",
    );
    await executeConfigInitCommand({ stateDirectory });
    // 新配置已写入
    const written = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      mode: string;
    };
    expect(written.mode).toBe("assist");
    // 旧配置进入备份库，可读取/恢复
    const { BackupVault } = await import(
      "../../../packages/core/src/tools/backup-vault.js"
    );
    const vault = new BackupVault({ baseDirectory: stateDirectory });
    await vault.initialize();
    const entries = await vault.listBackups(null);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "config-init", status: "active" });
    const backedUpContent = await vault.readBackup(entries[0]!.backupIdentifier);
    expect(backedUpContent).toContain("devolve");
  });

  it("status：文本模式输出 mission 详情", async () => {
    const runStdout = captureStdout();
    await executeRunCommand({
      prompt: "文本状态",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    const { missionId } = JSON.parse(runStdout.getOutput()) as { missionId: string };

    const textCapture = captureStdout();
    const exitCode = await executeStatusCommand({
      missionId,
      isJsonOutput: false,
      stateDirectory,
    });
    expect(exitCode).toBe(0);
    const textOutput = textCapture.getOutput();
    expect(textOutput).toContain(`mission: ${missionId}`);
    expect(textOutput).toContain("mode: assist");
    expect(textOutput).toContain("status: done");
  }, 20_000);

  it("doctor：文本模式输出", async () => {
    const stdoutCapture = captureStdout();
    const exitCode = await executeDoctorCommand({
      isJsonOutput: false,
      stateDirectory,
    });
    expect(exitCode).toBe(0);
    expect(stdoutCapture.getOutput()).toContain("health: ok");
  });

  it("resume：已完成 mission 返回 resumed=false（文本与 JSON）", async () => {
    const runStdout = captureStdout();
    await executeRunCommand({
      prompt: "恢复目标",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    const { missionId } = JSON.parse(runStdout.getOutput()) as { missionId: string };

    const jsonCapture = captureStdout();
    const jsonExitCode = await executeResumeCommand({
      missionId,
      isJsonOutput: true,
      stateDirectory,
    });
    expect(jsonExitCode).toBe(0);
    const parsed = JSON.parse(jsonCapture.getOutput()) as { resumed: boolean; status: string };
    expect(parsed.resumed).toBe(false);
    expect(parsed.status).toBe("done");

    const textCapture = captureStdout();
    const textExitCode = await executeResumeCommand({
      missionId,
      isJsonOutput: false,
      stateDirectory,
    });
    expect(textExitCode).toBe(0);
    expect(textCapture.getOutput()).toContain("already-complete");
  }, 20_000);

  it("cancel：已存在 mission 返回 cancelled（文本与 JSON）", async () => {
    const runStdout = captureStdout();
    await executeRunCommand({
      prompt: "取消目标",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    const { missionId } = JSON.parse(runStdout.getOutput()) as { missionId: string };

    const jsonCapture = captureStdout();
    const jsonExitCode = await executeCancelCommand({
      missionId,
      isJsonOutput: true,
      stateDirectory,
    });
    expect(jsonExitCode).toBe(0);
    expect(JSON.parse(jsonCapture.getOutput())).toMatchObject({
      missionId,
      status: "cancelled",
    });

    const textCapture = captureStdout();
    await executeCancelCommand({
      missionId,
      isJsonOutput: false,
      stateDirectory,
    });
    expect(textCapture.getOutput()).toContain(`cancelled: ${missionId}`);
  }, 20_000);

  it("bootstrap：启用独立反馈进程后可正常关闭", async () => {
    const { bootstrapCli } = await import("../../../packages/tui/src/cli/bootstrap.js");
    const startedAt = Date.now();
    const bootstrap = await bootstrapCli({
      mode: "assist",
      stateDirectory,
      concurrency: 4,
      failureThreshold: 3,
      maxLoopIterations: 8,
      useFeedbackProcess: true,
      streamOutput: () => {},
    }).catch((error: Error) => {
      throw new Error(`bootstrapCli 失败（${Date.now() - startedAt}ms）: ${error.message}`);
    });
    expect(bootstrap.supervisor).not.toBeNull();
    const health = await bootstrap.feedbackClient?.queryHealth();
    expect(health?.isHealthy).toBe(true);
    await bootstrap.shutdown();
  }, 15_000);

  it("launchTui：非 TTY 环境返回明确错误", async () => {
    const { launchTui } = await import("../../../packages/tui/src/cli/tui.js");
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    await expect(launchTui(stateDirectory)).rejects.toThrow();
    expect(stderrChunks.join("")).toContain("非 TTY");
  });

  it("doctor 不得破坏用户已有的 .write-probe 同名文件（审计 S1 回归）", async () => {
    const probeVictimPath = path.join(stateDirectory, ".write-probe");
    await fs.writeFile(probeVictimPath, "用户数据，不可丢失", "utf8");
    const stdoutCapture = captureStdout();
    const exitCode = await executeDoctorCommand({
      isJsonOutput: true,
      stateDirectory,
    });
    expect(exitCode).toBe(0);
    expect(stdoutCapture.getOutput()).toContain('"health": "ok"');
    // 用户文件必须原样保留
    expect(await fs.readFile(probeVictimPath, "utf8")).toBe(
      "用户数据，不可丢失",
    );
    // 探测不应留下残留文件
    const entries = await fs.readdir(stateDirectory);
    expect(
      entries.filter((entry) => entry.startsWith(".astarray-write-probe-")),
    ).toEqual([]);
  });
});
