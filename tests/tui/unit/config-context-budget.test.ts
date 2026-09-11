/**
 * T09A-R1-02：CLI config context-budget 查看/设置。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalContextBudgetStore } from "../../../packages/core/src/orchestration/global-context-budget-store.js";
import { executeConfigContextBudgetCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-budget-cli-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-02：CLI 预算命令", () => {
  it("缺省显示配置值；给定 token 数则持久化并递增 revision", async () => {
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const showExitCode = await executeConfigContextBudgetCommand({
      stateDirectory,
      tokens: null,
      isJsonOutput: false,
    });
    expect(showExitCode).toBe(0);
    expect(stdoutChunks.join("")).toContain("configured: 4096");

    const setExitCode = await executeConfigContextBudgetCommand({
      stateDirectory,
      tokens: 0,
      isJsonOutput: false,
    });
    expect(setExitCode).toBe(0);
    expect(stdoutChunks.join("")).toContain("context-budget=0 revision=2");

    const stored = await new GlobalContextBudgetStore({ baseDirectory: stateDirectory }).readPolicy();
    expect(stored.configuredMaximumGlobalContextTokenCount).toBe(0);
    expect(stored.globalContextBudgetPolicyRevision).toBe(2);
  });

  it("非法值被存储层拒绝并以非 0 退出码收口", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let observedExitCode: number | null = null;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      observedExitCode = code ?? 0;
      throw new Error("process-exit-observed");
    }) as never);
    await expect(
      executeConfigContextBudgetCommand({
        stateDirectory,
        tokens: -5,
        isJsonOutput: false,
      }),
    ).rejects.toThrow("process-exit-observed");
    expect(observedExitCode).not.toBeNull();
    expect(observedExitCode).not.toBe(0);
  });
});
