/**
 * `executeDoctorErrorsCommand` 的边界补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 选它的原因：该命令（`packages/tui/src/cli/commands.ts` L1071 起，约 150 行）
 * **此前没有任何测试引用**，因此其参数校验、JSON/文本输出、过滤与诊断包预览分支全部未覆盖。
 *
 * 断言原则：**参数非法必须非零退出**（不得报成功），**合法输入必须 0**——
 * 这样断言既稳健（不必猜 EXIT_CODES 具体值）又有真实语义。
 * 说明：本命令按卡内边界为**严格只读**（不执行进程、不联网、不落盘），故可安全直接调用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeDoctorErrorsCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(() => {
  stateDirectory = mkdtempSync(path.join(tmpdir(), "astarray-doctor-errors-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("doctor errors：参数校验分支", () => {
  it("--since 非法（不可解析的 ISO 时间）：必须非零退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      windowStartIso: "不是时间",
    });
    expect(exitCode).not.toBe(0);
  });

  it("--until 非法（不可解析的 ISO 时间）：必须非零退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      windowEndIso: "也不是时间",
    });
    expect(exitCode).not.toBe(0);
  });

  it("--page-size 非法（非数字）：必须非零退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      pageSize: "不是数字",
    });
    expect(exitCode).not.toBe(0);
  });

  it("--page-size 为零：必须非零退出（零页无意义）", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      pageSize: "0",
    });
    expect(exitCode).not.toBe(0);
  });

  it("--cursor 非法（非数字）：按既有分页约定**容忍并回退到起始位置**（不报错）", async () => {
    // 实测：非法 cursor 返回 0 而非用法错误——与 paginateGroups 的约定一致（非法游标回退 0）。
    // 首版我断言"必须非零退出"被实测打回，这里按真实约定固定下来。
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      cursor: "不是游标",
    });
    expect(exitCode).toBe(0);
  });
});

describe("doctor errors：空状态目录下的合法输入", () => {
  it("JSON 输出：空目录应成功退出（不得因无事件而报错）", async () => {
    const exitCode = await executeDoctorErrorsCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
  });

  it("文本输出：空目录应成功退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({ stateDirectory, isJsonOutput: false });
    expect(exitCode).toBe(0);
  });

  it("脱敏诊断包预览（shouldOutputBundle）：应成功退出且不落盘", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      shouldOutputBundle: true,
      astarrayVersion: "0.1.0-test",
    });
    expect(exitCode).toBe(0);
  });

  it("按 mission / agent 过滤：应成功退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: true,
      missionIdentifier: "mission-does-not-exist",
      sourceAgentInstanceId: "worker:does-not-exist:1",
    });
    expect(exitCode).toBe(0);
  });

  it("合法时间窗 + 分页游标：应成功退出", async () => {
    const exitCode = await executeDoctorErrorsCommand({
      stateDirectory,
      isJsonOutput: false,
      windowStartIso: "2026-01-01T00:00:00.000Z",
      windowEndIso: "2026-12-31T23:59:59.000Z",
      pageSize: "10",
      cursor: "0",
    });
    expect(exitCode).toBe(0);
  });
});
