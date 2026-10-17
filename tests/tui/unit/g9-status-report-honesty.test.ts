/**
 * G9 验收（2026-11-08，第 129 轮）：**状态汇报不得给"假保证"**。
 *
 * ## 背景（G9）
 *
 * `packages/tui/src/cli/commands.ts` 里两处 `componentsReady` 曾是**恒真**的：
 *
 * ```ts
 * const { BoundedProviderFallbackGuard } = await import("…");
 * const componentsReady = { fallbackGuard: BoundedProviderFallbackGuard !== null }; // 导入成功必然非 null
 * ```
 *
 * ⇒ 人类输出**永远打印「已装配」**，而对应组件在生产里**并没有被装配/使用**。
 *
 * ## 验收入口的口径（如实说明）
 *
 * 本轮核实：这两个子命令（`preset list`／`concurrent status`）**在 CLI 的 argv 分发里没有调用点**
 * （全仓只有测试直接调用其导出函数）⇒ 它们**不可从 CLI 到达**（已记为 **G10**）。
 * 因此本文件的"入口"是**产品代码里的命令函数本身**（即 CLI 若分发会调用的同一入口），
 * **不是** argv 层 —— 这一点我**不夸大**为"真实 CLI 入口已验收"。
 *
 * ## 断言（拔掉 G9 的修正 ⇒ 本文件必须变红）
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeConcurrentStatusCommand,
  executePresetListCommand,
} from "../../../packages/tui/src/cli/commands.js";

let restoreStdout: (() => void) | null = null;

afterEach(() => {
  restoreStdout?.();
  restoreStdout = null;
});

function captureStdout(): { readText: () => string } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    });
  restoreStdout = () => spy.mockRestore();
  return { readText: () => chunks.join("") };
}

describe("G9：状态汇报必须如实（模块可加载 ≠ 已装配）", () => {
  it("preset list --json：给出 modulesLoadable 与显式语义，且不再出现 componentsReady", async () => {
    const { readText } = captureStdout();
    expect(await executePresetListCommand({ isJsonOutput: true })).toBe(0);
    const parsed = JSON.parse(readText()) as Record<string, unknown>;
    expect(parsed.modulesLoadable).toBeDefined();
    expect(parsed.componentsReadySemantics).toBe("module-loadable-not-assembly");
    expect(parsed.componentsReady, "旧字段名已移除（它会让人误读为已装配）").toBeUndefined();
    expect(parsed.totalCount).toBeGreaterThanOrEqual(1);
  });

  it("preset list（人类可读）：只说『模块可加载』，不得声称『已装配』", async () => {
    const { readText } = captureStdout();
    expect(await executePresetListCommand({ isJsonOutput: false })).toBe(0);
    const text = readText();
    expect(text).toContain("模块可加载");
    expect(text, "『已装配』是未经核实的断言，必须消失").not.toContain("已装配");
  });

  it("concurrent status --json：同样带显式语义、不再有 componentsReady", async () => {
    const { readText } = captureStdout();
    expect(await executeConcurrentStatusCommand({ isJsonOutput: true })).toBe(0);
    const parsed = JSON.parse(readText()) as Record<string, unknown>;
    expect(parsed.modulesLoadable).toBeDefined();
    expect(parsed.componentsReadySemantics).toBe("module-loadable-not-assembly");
    expect(parsed.componentsReady).toBeUndefined();
  });

  it("concurrent status（人类可读）：只说『模块可加载』", async () => {
    const { readText } = captureStdout();
    expect(await executeConcurrentStatusCommand({ isJsonOutput: false })).toBe(0);
    const text = readText();
    expect(text).toContain("模块可加载");
    expect(text).not.toContain("已装配");
  });
});
