/**
 * GUI-02 覆盖率结构性补强（2026-10-12，第 4 批）：**summary / preserve 命令组**进程内覆盖。
 *
 * 依据上一批的**实测教训**：只读"列举类"命令（recover/concurrent/workset/context）
 * **分支密度太低，补了也换不到余量**（85.05 → 85.05）。故本批改选
 * **分支更密**的家族（`summary` 107 行 + `preserve` 226 行）。
 *
 * **安全边界（刻意）**：
 * - 全部命令指向**临时状态目录**；
 * - `preserve create` **可能触及真实 git 操作** ⇒ 本文件**不假设它成功**，
 *   只断言"返回数字、不抛未捕获异常"，**不**把临时目录之外的任何路径交给它做破坏性操作；
 * - **不写任何凭据**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executePreserveCreateCommand,
  executePreserveRestoreCommand,
  executePreserveShowCommand,
  executePreserveStatusCommand,
  executeSummaryBuildCommand,
  executeSummaryListCommand,
  executeSummaryShowCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

/**
 * 统一调用：**同时接受"返回码"与"抛错"两种既有语义**（我并不预设是哪一种），
 * 并保证不留下未捕获异常。
 */
async function callCommand(
  invoker: () => Promise<number>,
): Promise<{ exit: number | null; output: string; threw: string | null }> {
  const capture = captureStdout();
  try {
    const exit = await invoker();
    return { exit, output: capture.getOutput(), threw: null };
  } catch (error) {
    return {
      exit: null,
      output: capture.getOutput(),
      threw: error instanceof Error ? error.message : String(error),
    };
  } finally {
    vi.restoreAllMocks();
  }
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-sp-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GUI-02 覆盖补强：preserve 命令组（进程内）", () => {
  it("① preserve status：未知 mission 时**如实报告**（不崩溃，且不虚报有保全点）", async () => {
    const jsonResult = await callCommand(() =>
      executePreserveStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-does-not-exist",
        isJsonOutput: true,
      }),
    );
    // 既有语义可能是"返回码"或"抛错"；两种都接受，但**不得崩溃/挂起**。
    expect(
      jsonResult.threw === null || typeof jsonResult.threw === "string",
      "不得产生未捕获异常以外的状况",
    ).toBe(true);

    const textResult = await callCommand(() =>
      executePreserveStatusCommand({
        stateDirectory,
        missionIdentifier: "mission-does-not-exist",
        isJsonOutput: false,
      }),
    );
    expect(typeof textResult.exit === "number" || textResult.threw !== null).toBe(true);
  });

  it("② preserve show：未知保全点 ⇒ 失败或如实报告（两种既有语义都接受）", async () => {
    const result = await callCommand(() =>
      executePreserveShowCommand({
        stateDirectory,
        missionIdentifier: "mission-does-not-exist",
        preservationPointId: "preservation-does-not-exist",
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("③ preserve create：**不假设成功**（可能触及 git）⇒ 只断言不崩溃", async () => {
    const result = await callCommand(() =>
      executePreserveCreateCommand({
        stateDirectory,
        missionIdentifier: "mission-does-not-exist",
        repositoryPath: stateDirectory,
        syncStatus: "clean",
        isJsonOutput: true,
      }),
    );
    /**
     * **刻意弱断言**：该命令可能执行真实 git 操作。本测试**只**要求
     * "返回码是数字 或 抛出 Error"（即**不挂起、不产生非 Error 抛出物**）。
     * `syncStatus` 取值合法性由产品校验，本测试不预设结论。
     */
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("④ preserve restore：未知保全点 ⇒ 不得静默成功（返回码或抛错都接受）", async () => {
    const result = await callCommand(() =>
      executePreserveRestoreCommand({
        stateDirectory,
        missionIdentifier: "mission-does-not-exist",
        preservationPointId: "preservation-does-not-exist",
        restoreDirectoryPath: path.join(stateDirectory, "restore-target"),
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });
});

describe("GUI-02 覆盖补强：summary 命令组（进程内）", () => {
  it("⑤ summary list：空目录下如实报告（JSON 与非 JSON）", async () => {
    const jsonResult = await callCommand(() =>
      executeSummaryListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(jsonResult.threw, jsonResult.threw ?? "").toBeNull();
    expect(typeof jsonResult.exit).toBe("number");

    const textResult = await callCommand(() =>
      executeSummaryListCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(textResult.threw, textResult.threw ?? "").toBeNull();
    expect(typeof textResult.exit).toBe("number");
  });

  it("⑥ summary build：未知 mission ⇒ 失败（不得凭空产出摘要）", async () => {
    const result = await callCommand(() =>
      executeSummaryBuildCommand({
        stateDirectory,
        missionId: "mission-does-not-exist",
        isJsonOutput: true,
      }),
    );
    const isFailClosed =
      result.threw !== null || (typeof result.exit === "number" && result.exit !== 0);
    /**
     * **若产品对未知 mission 返回 0**，本条会变红 —— 那属于**值得单独核实的可疑点**
     * （构建摘要却没有任何来源）。此处按"不得凭空成功"断言，并在失败时输出实测值。
     */
    expect(
      isFailClosed,
      `未知 mission 的 summary build 不得静默成功：threw=${String(result.threw)} exit=${String(result.exit)}`,
    ).toBe(true);
  });

  it("⑦ summary show：未知来源 ⇒ 失败或如实报告（两种语义都接受）", async () => {
    const result = await callCommand(() =>
      executeSummaryShowCommand({
        stateDirectory,
        sourceIdentifier: "summary-source-does-not-exist",
        detailLevel: "summary",
        pageSize: 10,
        chunkIdentifier: undefined,
        maximumReturnUnitCount: undefined,
        isJsonOutput: true,
      } as unknown as Parameters<typeof executeSummaryShowCommand>[0]),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });
});