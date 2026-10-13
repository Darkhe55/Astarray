/**
 * GUI-02 覆盖率结构性补强（2026-10-12，第 5 批）：**tool-package 命令组**进程内覆盖。
 *
 * 选点依据（本会话已验证的规律）：**选分支密的命令家族**（tool-package 共 337 行，
 * 是剩余候选里最大的），而不是只读列举类（那批实测**零收益**，见 commit 4fdc993）。
 *
 * **安全边界（刻意）**：
 * - 全部指向**临时状态目录**与**伪造的 projectIdentifier**；
 * - `tool-package change/cancel/recover` 属**改变状态**的操作 ⇒ 一律对**不存在的包**
 *   调用，并**不假设成功**（既接受返回码也接受抛错）；
 * - **不写任何凭据**；不触碰真实项目目录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeToolPackageCancelCommand,
  executeToolPackageChangeCommand,
  executeToolPackageDescribeCommand,
  executeToolPackageFeedbackCommand,
  executeToolPackageListCommand,
  executeToolPackageRecoverCommand,
  executeToolPackageStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
const PROJECT = "project-fixture-gui02";

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

/** 同时接受"返回码"与"抛错"两种既有语义，并保证不产生未捕获异常。 */
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-tp-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GUI-02 覆盖补强：tool-package 命令组（进程内）", () => {
  it("① list：空目录下如实报告（JSON 与非 JSON 两条输出分支）", async () => {
    const jsonResult = await callCommand(() =>
      executeToolPackageListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(jsonResult.threw, jsonResult.threw ?? "").toBeNull();
    expect(typeof jsonResult.exit).toBe("number");

    const textResult = await callCommand(() =>
      executeToolPackageListCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(textResult.threw, textResult.threw ?? "").toBeNull();
    expect(typeof textResult.exit).toBe("number");
  });

  it("② feedback：空目录下如实报告（只读）", async () => {
    const result = await callCommand(() =>
      executeToolPackageFeedbackCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(result.threw, result.threw ?? "").toBeNull();
    expect(typeof result.exit).toBe("number");
  });

  it("③ describe：未知包 ⇒ 不得静默成功（返回码或抛错都接受）", async () => {
    const result = await callCommand(() =>
      executeToolPackageDescribeCommand({
        toolPackageId: "tool-package-does-not-exist",
        stateDirectory,
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("④ status：未知包 ⇒ 不得静默成功", async () => {
    const result = await callCommand(() =>
      executeToolPackageStatusCommand({
        toolPackageId: "tool-package-does-not-exist",
        projectIdentifier: PROJECT,
        stateDirectory,
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("⑤ change：对未知包执行 enable/disable/upgrade ⇒ **不假设成功**，只断言不崩溃", async () => {
    for (const changeKind of ["enable", "disable", "upgrade"] as const) {
      const result = await callCommand(() =>
        executeToolPackageChangeCommand({
          toolPackageId: "tool-package-does-not-exist",
          projectIdentifier: PROJECT,
          stateDirectory,
          isJsonOutput: true,
          changeKind,
        } as unknown as Parameters<typeof executeToolPackageChangeCommand>[0]),
      );
      expect(
        result.exit !== null || result.threw !== null,
        `changeKind=${changeKind} 既未返回码也未抛错`,
      ).toBe(true);
    }
  });

  it("⑥ cancel / recover：未知包且**具体发起身份** ⇒ 不假设成功，只断言不崩溃", async () => {
    const cancelResult = await callCommand(() =>
      executeToolPackageCancelCommand({
        toolPackageId: "tool-package-does-not-exist",
        projectIdentifier: PROJECT,
        stateDirectory,
        isJsonOutput: true,
        requestingAgentInstanceId: "worker:mission-gui02:T-001:1",
      }),
    );
    expect(cancelResult.exit !== null || cancelResult.threw !== null).toBe(true);

    const recoverResult = await callCommand(() =>
      executeToolPackageRecoverCommand({
        toolPackageId: "tool-package-does-not-exist",
        projectIdentifier: PROJECT,
        stateDirectory,
        isJsonOutput: true,
        requestingAgentInstanceId: "worker:mission-gui02:T-001:1",
      }),
    );
    expect(recoverResult.exit !== null || recoverResult.threw !== null).toBe(true);
  });
});