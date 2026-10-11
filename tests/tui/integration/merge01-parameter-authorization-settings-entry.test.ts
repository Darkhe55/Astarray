/**
 * MERGE-01-03 反例（2026-10-10）：参数授权设置必须**真的可达**，且**四入口一致**。
 *
 * 卡内 §1.3 要求参数授权总开关与每工具细分开关是**设置入口**；
 * 检查点 03 更明确要求："**CLI/TUI/GUI/SDK 设置一致**与包级执行证据"。
 *
 * 现状缺口（本轮实测）：`ParameterAuthorizationSettingsStore` 虽然存在并被 `public-sdk` 导出，
 * 但**全仓从未被构造**（`new ParameterAuthorizationSettingsStore` 零命中），CLI 也没有
 * 任何设置子命令 ⇒ "设置入口"在产品层面**不成立**，"四入口一致"更无从谈起。
 *
 * 本片钉住的语义：
 *  - SDK 能**读取**当前设置（默认两开关均开、且**不因读取而创建文件**）；
 *  - SDK 能**写入**设置，并把"关闭细分会放宽权限"的判定**接到真实写入路径上**
 *    （未确认即拒绝、且**不落地任何文件变更**）；
 *  - **CLI 与 SDK 结论一致**：同一状态目录下，CLI 读到的设置与 SDK 一致；
 *    CLI 写入未确认的放宽必须**同样被拒**且退出码非 0；
 *  - CLI 的 JSON 输出与 SDK 的结构**逐字段一致**（不得两套口径）。
 *
 * 只跑本地临时目录与真实 `dist/cli.js` 子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge01-settings-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
}

/** 运行真实 CLI 子进程，返回退出码与标准输出。 */
async function runCli(
  argumentsList: string[],
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.js"), ...argumentsList],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdoutText = "";
    let stderrText = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutText += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdoutText, stderrText }));
  });
}

describe("MERGE-01-03：参数授权设置必须真的可达（SDK）", () => {
  it("① SDK 能读取默认设置，且**读取不创建文件**", async () => {
    const application = await createApplication();
    try {
      const settings = await application.queryParameterAuthorizationSettings();
      expect(settings.isParameterAuthorizationEnabled).toBe(true);
      expect(settings.isParameterRulesEnabled).toBe(true);
      expect(settings.configurationRevision).toBeGreaterThanOrEqual(0);
    } finally {
      await application.shutdown();
    }
    // 读取不得产生副作用（不得为"读"而建文件）
    const settingsFilePath = path.join(
      stateDirectory,
      "tools",
      "parameter-authorization-settings.json",
    );
    await expect(fs.access(settingsFilePath)).rejects.toThrowError();
  });

  it("② 未确认的放宽必须被拒，且**不落地任何文件变更**", async () => {
    const application = await createApplication();
    try {
      const outcome = await application.updateParameterAuthorizationSettings({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
        toolAuthorizationShapes: [
          {
            toolName: "readFile",
            unifiedEffect: "allow",
            ruleEffects: [{ ruleIdentifier: "rule-deny-secrets", effect: "deny" }],
          },
        ],
        isConfirmedByAuthenticatedUser: false,
      });
      expect(outcome.isAccepted).toBe(false);
      expect(outcome.widenedPermissions.length).toBeGreaterThan(0);
    } finally {
      await application.shutdown();
    }
    const settingsFilePath = path.join(
      stateDirectory,
      "tools",
      "parameter-authorization-settings.json",
    );
    await expect(fs.access(settingsFilePath)).rejects.toThrowError();
  });

  it("③ 已确认的放宽可写入，并能被再次读出（round-trip）", async () => {
    const application = await createApplication();
    try {
      const accepted = await application.updateParameterAuthorizationSettings({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
        toolAuthorizationShapes: [
          {
            toolName: "readFile",
            unifiedEffect: "allow",
            ruleEffects: [{ ruleIdentifier: "rule-deny-secrets", effect: "deny" }],
          },
        ],
        isConfirmedByAuthenticatedUser: true,
      });
      expect(accepted.isAccepted).toBe(true);
    } finally {
      await application.shutdown();
    }

    // 新 facade（模拟重启）必须读到刚写入的值
    const reopenedApplication = await createApplication();
    try {
      const reloaded = await reopenedApplication.queryParameterAuthorizationSettings();
      expect(reloaded.isParameterRulesEnabled).toBe(false);
      expect(reloaded.isParameterAuthorizationEnabled).toBe(true);
    } finally {
      await reopenedApplication.shutdown();
    }
  });
});

describe("MERGE-01-03：CLI 与 SDK 设置必须一致", () => {
  it("④ CLI 读到的设置与 SDK 一致（JSON 结构逐字段相符）", async () => {
    // 先用 SDK 写入一个非默认值
    const application = await createApplication();
    try {
      await application.updateParameterAuthorizationSettings({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
        toolAuthorizationShapes: [],
        isConfirmedByAuthenticatedUser: true,
      });
    } finally {
      await application.shutdown();
    }

    const cliResult = await runCli([
      "settings",
      "parameter-authorization",
      "--state-dir",
      stateDirectory,
      "--json",
    ]);
    expect(cliResult.exitCode).toBe(0);

    const sdkApplication = await createApplication();
    try {
      const sdkSettings = await sdkApplication.queryParameterAuthorizationSettings();
      const cliSettings = JSON.parse(cliResult.stdoutText.trim()) as Record<string, unknown>;
      expect(cliSettings["isParameterAuthorizationEnabled"]).toBe(
        sdkSettings.isParameterAuthorizationEnabled,
      );
      expect(cliSettings["isParameterRulesEnabled"]).toBe(sdkSettings.isParameterRulesEnabled);
      expect(cliSettings["configurationRevision"]).toBe(sdkSettings.configurationRevision);
    } finally {
      await sdkApplication.shutdown();
    }
  });

  it("⑤ CLI 未确认的放宽必须**同样被拒**（退出码非 0，且不写文件）", async () => {
    const cliResult = await runCli([
      "settings",
      "parameter-authorization",
      "--state-dir",
      stateDirectory,
      "--disable-granularity",
      "--tool",
      "readFile:allow:rule-deny-secrets=deny",
      "--json",
    ]);
    expect(cliResult.exitCode).not.toBe(0);
    const settingsFilePath = path.join(
      stateDirectory,
      "tools",
      "parameter-authorization-settings.json",
    );
    await expect(fs.access(settingsFilePath)).rejects.toThrowError();
  });
});
