/**
 * TOOLKIT-01-05 反例（2026-10-10，真实转换器片）：
 * 卡内检查点 05 要求"**先实现一个无外部副作用转换器**，验证沙箱/broker 边界"。
 * 上一轮只做了**门禁**（判定能否启用），**转换器本身并不存在** ⇒ 该检查点仍未落地。
 *
 * 本片实现一个**真实可运行**的确定性转换器（CSV → JSON 记录数组）及其受控执行入口，
 * 并钉住"无外部副作用 + 边界可靠"的语义：
 *  - **纯函数式**：只吃显式输入字符串、只产出值，**不读写文件、不起进程、不联网**；
 *  - **确定性**：同输入必然同输出（含键序稳定）；
 *  - **格式边界**：引号包裹、字段内逗号/换行、转义双引号必须正确解析；
 *  - **非法输入明确失败**（列数不一致等），**不得静默丢字段或补空值**；
 *  - **有界**：超出显式输入上限即拒绝（避免"不可控的大输入"变成资源问题）；
 *  - 执行入口必须**先过隔离门禁**：门禁不通过时**不得执行**；
 *  - 门禁通过后仍需**执行预算检查**（超预算不执行）。
 *
 * 只跑本地纯函数（临时目录仅用于证明"没有碰文件系统"）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DETERMINISTIC_CSV_TO_JSON_CONVERTER,
  runDeterministicProgramTool,
  type DeterministicProgramToolDeclaration,
} from "../../../packages/core/src/toolkit/deterministic-program-converter.js";
import type { SandboxCapabilityProfile } from "../../../packages/core/src/toolkit/program-tool-isolation-gate.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit05-conv-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildDeclaration(
  overrides: Partial<DeterministicProgramToolDeclaration> = {},
): DeterministicProgramToolDeclaration {
  return {
    ...DETERMINISTIC_CSV_TO_JSON_CONVERTER,
    ...overrides,
  };
}

function buildPlatform(
  overrides: Partial<SandboxCapabilityProfile> = {},
): SandboxCapabilityProfile {
  return {
    platformIdentifier: "win32-x64",
    hasEnforceableSandbox: true,
    hasControlledBroker: true,
    supportedCapabilities: [],
    maximumDependencyDepth: 4,
    maximumExecutionBudgetMilliseconds: 30_000,
    ...overrides,
  };
}

describe("TOOLKIT-01-05：转换器基本形态与确定性", () => {
  it("① 纯转换：显式输入 → JSON 记录数组，且同输入必然同输出", async () => {
    const inputText = "name,age\nAlice,30\nBob,25\n";
    const first = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText,
      cancellationSignal: new AbortController().signal,
    });
    const second = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText,
      cancellationSignal: new AbortController().signal,
    });
    expect(first.isSucceeded).toBe(true);
    expect(second.isSucceeded).toBe(true);
    expect(first.outputText).toBe(second.outputText);
    expect(JSON.parse(String(first.outputText))).toEqual([
      { name: "Alice", age: "30" },
      { name: "Bob", age: "25" },
    ]);
  });

  it("② 转换器声明为无能力需求、无副作用（不得自声明 readOnly 掩盖能力）", () => {
    expect(DETERMINISTIC_CSV_TO_JSON_CONVERTER.requiredCapabilities).toEqual([]);
    expect(DETERMINISTIC_CSV_TO_JSON_CONVERTER.declaredSideEffects).toEqual(["none"]);
    expect(DETERMINISTIC_CSV_TO_JSON_CONVERTER.readOnlySelfDeclaration).toBe(true);
  });

  it("③ 不碰文件系统：执行前后临时目录内容不变", async () => {
    const before = await fs.readdir(stateDirectory);
    await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText: "a\n1\n",
      cancellationSignal: new AbortController().signal,
    });
    const after = await fs.readdir(stateDirectory);
    expect(after).toEqual(before);
    expect(after).toEqual([]);
  });
});

describe("TOOLKIT-01-05：格式边界与非法输入", () => {
  it("④ 引号包裹、字段内逗号/换行、转义双引号必须正确解析", async () => {
    const inputText =
      'name,note\n"Doe, John","line1\nline2"\n"She said ""hi""",plain\n';
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText,
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isSucceeded).toBe(true);
    const parsed = JSON.parse(String(outcome.outputText)) as Array<Record<string, string>>;
    expect(parsed[0]?.["name"]).toBe("Doe, John");
    expect(parsed[0]?.["note"]).toBe("line1\nline2");
    expect(parsed[1]?.["name"]).toBe('She said "hi"');
  });

  it("⑤ 列数不一致必须**明确失败**（不得静默丢字段或补空值）", async () => {
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText: "a,b\n1\n",
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isSucceeded).toBe(false);
    expect(String(outcome.failureReason)).toMatch(/列数|字段数|不一致|第 2 行/);
    expect(outcome.outputText).toBeNull();
  });

  it("⑥ 空输入 / 只有表头必须明确失败（不得产出伪记录）", async () => {
    for (const inputText of ["", "a,b\n"]) {
      const outcome = await runDeterministicProgramTool({
        declaration: buildDeclaration(),
        platform: buildPlatform(),
        inputText,
        cancellationSignal: new AbortController().signal,
      });
      expect(outcome.isSucceeded, "输入 " + JSON.stringify(inputText) + " 必须失败").toBe(
        false,
      );
      expect(outcome.outputText).toBeNull();
    }
  });

  it("⑥b 只有空白/换行的输入必须明确失败（不得解析出空表头记录）", async () => {
    for (const inputText of ["\n", "   \n", "\r\n"]) {
      const outcome = await runDeterministicProgramTool({
        declaration: buildDeclaration(),
        platform: buildPlatform(),
        inputText,
        cancellationSignal: new AbortController().signal,
      });
      expect(
        outcome.isSucceeded,
        "输入 " + JSON.stringify(inputText) + " 必须失败",
      ).toBe(false);
      expect(outcome.outputText).toBeNull();
    }
  });
  it("⑦ 超出显式输入上限必须拒绝（有界，不得吞下不可控的大输入）", async () => {
    const hugeRows = Array.from({ length: 5_000 }, (_unused, index) => "r" + String(index)).join(
      "\n",
    );
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration({ maximumInputBytes: 1_024 }),
      platform: buildPlatform(),
      inputText: "a\n" + hugeRows + "\n",
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isSucceeded).toBe(false);
    expect(String(outcome.failureReason)).toMatch(/上限|过大|字节/);
  });
});

describe("TOOLKIT-01-05：执行入口必须先过隔离门禁", () => {
  it("⑧ 门禁不通过时**绝不执行**（例如平台缺沙箱）", async () => {
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration({
        readOnlySelfDeclaration: false,
        requiredCapabilities: ["file-read"],
        declaredSideEffects: ["file-read"],
      }),
      platform: buildPlatform({
        hasEnforceableSandbox: false,
        supportedCapabilities: ["file-read"],
      }),
      inputText: "a\n1\n",
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isSucceeded).toBe(false);
    expect(outcome.isEnabledByGate).toBe(false);
    expect(outcome.outputText).toBeNull();
    expect(String(outcome.failureReason)).toMatch(/沙箱|门禁|拒绝/);
  });

  it("⑨ 超执行预算不执行", async () => {
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration({ executionBudgetMilliseconds: 60_000 }),
      platform: buildPlatform({ maximumExecutionBudgetMilliseconds: 30_000 }),
      inputText: "a\n1\n",
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isSucceeded).toBe(false);
    expect(outcome.isEnabledByGate).toBe(false);
    expect(String(outcome.failureReason)).toMatch(/预算|budget/);
  });

  it("⑩ 已取消的信号不得执行", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText: "a\n1\n",
      cancellationSignal: controller.signal,
    });
    expect(outcome.isSucceeded).toBe(false);
    expect(String(outcome.failureReason)).toMatch(/取消|cancel/i);
  });

  it("⑪ 门禁通过时必须如实标注（isEnabledByGate=true）后再执行", async () => {
    const outcome = await runDeterministicProgramTool({
      declaration: buildDeclaration(),
      platform: buildPlatform(),
      inputText: "a\n1\n",
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.isEnabledByGate).toBe(true);
    expect(outcome.isSucceeded).toBe(true);
    expect(JSON.parse(String(outcome.outputText))).toEqual([{ a: "1" }]);
  });
});
