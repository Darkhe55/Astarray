/**
 * B6R-10 / 覆盖率门禁（2026-10-10）：`parameter-authorization-settings-command` 的**进程内**覆盖。
 *
 * 为什么必须有这一片：该 CLI 命令此前只由 `tests/tui/integration/...` **以子进程**驱动，
 * 而 v8 覆盖率**看不见子进程** ⇒ 该文件长期显示 **0%**（20 个分支全未覆盖），
 * 这是 `npm run test:coverage` 全局分支未达 85% 门槛的**最大单项缺口**。
 *
 * 本片在**本进程内**直接调用命令函数，覆盖：参数解析的**各类非法形态**（不得进入 SDK）、
 * 只读查询路径、（在仅有 mock 运行时下）写入被拒路径与 JSON 输出分支。
 *
 * 只跑本进程与本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeParameterAuthorizationSettingsCommand } from "../../../packages/tui/src/cli/parameter-authorization-settings-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-pa-cmd-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildOptions(overrides: Partial<Parameters<typeof executeParameterAuthorizationSettingsCommand>[0]> = {}) {
  return {
    stateDirectory,
    isJsonOutput: false,
    shouldDisableGranularity: false,
    shouldDisableParameterAuthorization: false,
    toolAuthorizationShapeSpecifications: [],
    isConfirmedByAuthenticatedUser: false,
    ...overrides,
  };
}

describe("MERGE-01：CLI 命令的参数解析（进程内，不得进入 SDK）", () => {
  it("① 缺少冒号分隔 ⇒ USAGE_ERROR，且不触碰状态目录", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({ toolAuthorizationShapeSpecifications: ["readFile"] }),
    );
    expect(exitCode).not.toBe(0);
    await expect(fs.access(path.join(stateDirectory, "parameter-authorization-settings.json"))).rejects.toThrowError();
  });

  it("② 统一效果非法 ⇒ USAGE_ERROR", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({ toolAuthorizationShapeSpecifications: ["readFile:maybe"] }),
    );
    expect(exitCode).not.toBe(0);
  });

  it("③ 工具名为空 ⇒ USAGE_ERROR", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({ toolAuthorizationShapeSpecifications: [":allow"] }),
    );
    expect(exitCode).not.toBe(0);
  });

  it("④ 规则段缺 `=` 或缺效果 ⇒ USAGE_ERROR", async () => {
    const missingEquals = await executeParameterAuthorizationSettingsCommand(
      buildOptions({ toolAuthorizationShapeSpecifications: ["readFile:allow:rule-x"] }),
    );
    expect(missingEquals).not.toBe(0);

    const badEffect = await executeParameterAuthorizationSettingsCommand(
      buildOptions({ toolAuthorizationShapeSpecifications: ["readFile:allow:rule-x=perhaps"] }),
    );
    expect(badEffect).not.toBe(0);
  });

  it("⑤ 合法形态（含多条规则）⇒ 只读查询成功（不因解析而失败）", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({
        toolAuthorizationShapeSpecifications: [
          "readFile:allow:rule-a=deny,rule-b=ask",
          "createProjectFile:ask",
        ],
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(0);
  });

  it("⑥ 合法形态 + 非 JSON 输出 ⇒ 只读查询成功（人类可读分支）", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({
        toolAuthorizationShapeSpecifications: ["readFile:allow:rule-a=deny"],
        isJsonOutput: false,
      }),
    );
    expect(exitCode).toBe(0);
  });

  it("⑦ 未确认即关闭细分 ⇒ 放宽被拒（非 0），且**不写文件**", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({
        shouldDisableGranularity: true,
        toolAuthorizationShapeSpecifications: ["readFile:allow:rule-deny=deny"],
        isJsonOutput: true,
      }),
    );
    expect(exitCode).not.toBe(0);
    await expect(fs.access(path.join(stateDirectory, "parameter-authorization-settings.json"))).rejects.toThrowError();
  });

  it("⑧ 已确认关闭细分 ⇒ 写入成功（JSON 输出分支）", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({
        shouldDisableGranularity: true,
        isConfirmedByAuthenticatedUser: true,
        toolAuthorizationShapeSpecifications: ["readFile:allow:rule-deny=deny"],
        isJsonOutput: true,
      }),
    );
    expect(exitCode).toBe(0);
  });

  it("⑨ 已确认关闭细分 + 非 JSON 输出 ⇒ 写入成功（人类可读分支）", async () => {
    const exitCode = await executeParameterAuthorizationSettingsCommand(
      buildOptions({
        shouldDisableParameterAuthorization: true,
        isConfirmedByAuthenticatedUser: true,
        isJsonOutput: false,
      }),
    );
    expect(exitCode).toBe(0);
  });
});
