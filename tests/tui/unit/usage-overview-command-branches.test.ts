/**
 * `executeUsageOverviewCommand` 的边界补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 该命令在 `commands.ts` 中是当前未覆盖分支最多的单个函数（32 条，L1223 起）。
 * 既有测试只覆盖"合法 JSON 调用 + 非法预算"，因此这里补：其余参数校验、文本输出分支、
 * 过滤分支、以及非法游标按既有约定容忍。
 *
 * 断言约定：用法错误用 **2**（与既有测试一致）；合法输入用 **0**；
 * 非法游标按分页约定**容忍并回退**（0）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeUsageOverviewCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(() => {
  stateDirectory = mkdtempSync(path.join(tmpdir(), "astarray-usage-overview-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("usage overview：参数校验分支", () => {
  it("预算非法：用法错误（2）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      inputTokenBudget: "不是数字",
    });
    expect(exitCode).toBe(2);
  });

  it("page-size 非法：用法错误（2）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      pageSize: "不是数字",
    });
    expect(exitCode).toBe(2);
  });

  it("detail-level 非法：用法错误（2）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      detailLevel: "不存在的层级",
    });
    expect(exitCode).toBe(2);
  });

  it("cursor 非法：按分页约定容忍并回退（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      cursor: "不是游标",
    });
    expect(exitCode).toBe(0);
  });
});

describe("usage overview：输出与过滤分支", () => {
  it("文本输出：空账目下成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({ stateDirectory, isJsonOutput: false });
    expect(exitCode).toBe(0);
  });

  it("JSON 输出：空账目下成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
  });

  it("按 mission 过滤：成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      missionIdentifier: "mission-does-not-exist",
    });
    expect(exitCode).toBe(0);
  });

  it("按 agent 过滤：成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      sourceAgentInstanceId: "worker:does-not-exist:1",
    });
    expect(exitCode).toBe(0);
  });

  it("预算给 0（保留账目但关闭提示）：成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      inputTokenBudget: "0",
    });
    expect(exitCode).toBe(0);
  });

  it("预算 1 + 分页游标 0 + 文本输出组合：成功退出（0）", async () => {
    const exitCode = await executeUsageOverviewCommand({
      stateDirectory,
      isJsonOutput: false,
      inputTokenBudget: "1",
      pageSize: "10",
      cursor: "0",
    });
    expect(exitCode).toBe(0);
  });
});
