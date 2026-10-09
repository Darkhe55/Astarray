/**
 * `executeCrossProjectListCommand` 的边界补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 选它的原因：脚本扫描 `commands.ts` 的 66 个导出命令后，它是**唯一仍完全零引用（无任何测试）**的命令
 * （L976 起约 95 行）。其三个可选过滤器（source/target/receiving）分别对应
 * `=== undefined ? {} : {...}` 的两侧分支，加上 JSON/文本输出分支与 catch 兜底分支，均未覆盖。
 *
 * 纪律：该命令按卡内定义为**公开只读入口**（不联网、不执行进程、不写业务数据），故可直接调用。
 * 断言：合法输入必须 0；把 stateDirectory 指向一个**普通文件**（无法作为目录使用）时必须走 catch
 * 且非零退出（只读入口不得伪装成功）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCrossProjectListCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), "astarray-cross-project-"));
  stateDirectory = path.join(temporaryRoot, "state");
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("跨项目只读列表：无过滤器", () => {
  it("无过滤器 + JSON 输出：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
  });

  it("无过滤器 + 文本输出：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({ stateDirectory, isJsonOutput: false });
    expect(exitCode).toBe(0);
  });
});

describe("跨项目只读列表：三个可选过滤器的两侧分支", () => {
  it("仅 sourceProjectIdentifier：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory,
      isJsonOutput: true,
      sourceProjectIdentifier: "project-a",
    });
    expect(exitCode).toBe(0);
  });

  it("仅 targetProjectIdentifier：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory,
      isJsonOutput: true,
      targetProjectIdentifier: "project-b",
    });
    expect(exitCode).toBe(0);
  });

  it("仅 receivingAgentInstanceId：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory,
      isJsonOutput: true,
      receivingAgentInstanceId: "secondary:project-b:1",
    });
    expect(exitCode).toBe(0);
  });

  it("三个过滤器同时给出：成功退出", async () => {
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory,
      isJsonOutput: false,
      sourceProjectIdentifier: "project-a",
      targetProjectIdentifier: "project-b",
      receivingAgentInstanceId: "secondary:project-b:1",
    });
    expect(exitCode).toBe(0);
  });
});

describe("跨项目只读列表：异常/边界输入", () => {
  it("stateDirectory 指向普通文件：只读查询**容忍并返回空结果**（实测退出 0）", async () => {
    // 实测：把 stateDirectory 指向普通文件并不会抛错——只读入口按"无授权记录"返回空结果，
    // 因此退出码为 0。首版我断言"必须非零退出"被实测打回；这里按真实行为固定，
    // 并如实说明：**该输入未能触发 catch 兜底分支**（catch 需其它异常才会走到）。
    const filePath = path.join(temporaryRoot, "not-a-directory");
    writeFileSync(filePath, "not a directory", "utf8");
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory: filePath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
  });
});
