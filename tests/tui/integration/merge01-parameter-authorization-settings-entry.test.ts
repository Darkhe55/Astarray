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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
 * 超时预算（2026-10-13，纵深防御）：本文件使用**子进程**，此前**未设置** `testTimeout`
 * ⇒ 沿用 vitest 默认 **5_000ms**。本批文件隔离实测均远低于该值（本文件最慢单例见
 * docs/reports/FEEDBACK_SHUTDOWN_DUPLICATE_5S_2026-10-13.md §12 的实测表），
 * 但满载争用系数实测约 1.4-3x —— 同类文件已因此出现过 `Test timed out in 5000ms`。
 * 故按仓库既有约定显式给预算（另有 30+ 文件同样用 60_000）；**断言一律不放宽**。
 */
vi.setConfig({ testTimeout: 60_000 });


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

  it("⑥ 【2026-11-08】只给 `--tool`、不给任何 `--disable-*` 也必须**真的写入**（不得静默忽略）", async () => {
    /**
     * ## 由来（真实用户实测踩到，不是推测）
     *
     * 用户为"真实 Provider + 工具真执行"预先放行工具，执行：
     *
     * ```
     * astarray settings parameter-authorization --tool "createProjectFile:allow" --confirm
     * ```
     *
     * 命令**退出 0、并打印了当前设置**（`规则数: 0；配置 revision: 0`）——
     * 看起来像成功，**实际上 `--tool` 被完全忽略**。
     *
     * ## 根因
     *
     * `parameter-authorization-settings-command.ts`：
     *
     * ```js
     * const isWriteRequested =
     *   options.shouldDisableGranularity || options.shouldDisableParameterAuthorization;
     * if (!isWriteRequested) { /* 只读分支：shapes 完全没用到 *\/ }
     * ```
     *
     * ⇒ **"给了 --tool"本身不算写入请求**，于是走只读分支、**静默丢弃所有 shape**，
     * 却仍然 `SUCCESS` 退出 —— 属于"静默忽略输入"。
     *
     * ## ⚠️ 为什么既有测试没拦住
     *
     * 本文件用例 ⑤（以及其它用例）**总是**把 `--tool` 与 `--disable-granularity`
     * 配对使用 ⇒ **"单独用 --tool"这条路径从未被测过**。
     * 那条配对的用法恰好绕过了这个分支判断，于是缺陷一直不可见。
     *
     * ## 本用例的判定方式
     *
     * **不信任命令自己的回显**（回显正是骗人的地方）：
     * 先用 SDK 取基线 revision，跑完 CLI 再用 SDK 复核 revision 是否真的变了。
     */
    const baselineApplication = await createApplication();
    let baselineRevision: number;
    try {
      baselineRevision =
        (await baselineApplication.queryParameterAuthorizationSettings())
          .configurationRevision;
    } finally {
      await baselineApplication.shutdown();
    }

    const cliResult = await runCli([
      "settings",
      "parameter-authorization",
      "--state-dir",
      stateDirectory,
      "--tool",
      "createProjectFile:allow",
      "--confirm",
      "--json",
    ]);
    expect(cliResult.exitCode).toBe(0);

    const afterApplication = await createApplication();
    try {
      const afterSettings =
        await afterApplication.queryParameterAuthorizationSettings();
      expect(
        afterSettings.configurationRevision,
        "只给 --tool 时设置没有被写入（被静默忽略了）：revision 仍为 " +
          String(afterSettings.configurationRevision),
      ).toBeGreaterThan(baselineRevision);
    } finally {
      await afterApplication.shutdown();
    }
  });
});
