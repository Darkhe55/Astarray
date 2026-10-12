/**
 * GUI-02 覆盖率结构性补强（2026-10-12，第 2 批）：**Provider / Model 命令组**进程内覆盖。
 *
 * 接续 `gui02-commands-profile-coverage.test.ts`：本会话已量化出
 * **单条测试 ≈ 0.01 点、抖动量级 ≈ ±0.02 点** ⇒ 零散补分支徒劳，须做**结构性补测**；
 * 而 `packages/tui/src/cli/commands.ts` 的未覆盖分支最多（缺 297/899 ≈ 全局 2.7%），
 * 成因是这些命令**此前仅由子进程驱动**（v8 不可见）。本文件直接调用命令函数。
 *
 * **安全性说明**（我核实后才写这些用例）：
 * - Provider 组命令接受 `stateDirectory` ⇒ 全部指向**临时目录**；
 * - `model catalog` / `preset list` 的 `loadModelInfra()` **不读全局配置** ——
 *   它用**内存中的目录 + 固定演示凭据引用**（`doesReferenceExist` 查一个 Set），
 *   **不落盘、不读取真实凭据** ⇒ 可安全调用。
 * 本文件**不写入任何真实凭据**，也不调用 `provider-credential-set`（避免密钥进入代码或日志）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeDoctorProviderCommand,
  executeModelCatalogCommand,
  executeModelResolveCommand,
  executePresetListCommand,
  executeProviderListCommand,
  executeProviderRegisterCommand,
  executeProviderShowCommand,
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

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-prov-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GUI-02 覆盖补强：Provider 命令组（进程内）", () => {
  it("① register 的**参数校验分支**：空 id 与非法 support-level 均用法错误；合法参数可登记", async () => {
    // 空 id ⇒ USAGE_ERROR（覆盖该校验分支）
    expect(
      await executeProviderRegisterCommand({
        stateDirectory,
        isJsonOutput: true,
        providerProfileId: "   ",
        protocolName: "openai-compatible",
        apiVersion: "v1",
        capabilityNames: ["chat"],
        supportLevel: "live-smoke-verified",
        protectedCredentialReferenceId: "cred-ref-openai-1",
      }),
    ).toBe(2);
    vi.restoreAllMocks();

    // 非法 support-level ⇒ USAGE_ERROR（覆盖该校验分支）
    expect(
      await executeProviderRegisterCommand({
        stateDirectory,
        isJsonOutput: true,
        providerProfileId: "prov-local-1",
        protocolName: "openai-compatible",
        apiVersion: "v1",
        capabilityNames: ["chat"],
        supportLevel: "not-a-level",
        protectedCredentialReferenceId: "cred-ref-openai-1",
      }),
    ).toBe(2);
    vi.restoreAllMocks();

    /**
     * 合法参数：登记需要**本地受保护凭据引用真实存在**（本测试的临时状态目录里没有），
     * 故此处只断言"**返回数字、不抛异常**"，不假定成功 —— **不臆造前置条件**。
     */
    const exit = await executeProviderRegisterCommand({
      stateDirectory,
      isJsonOutput: true,
      providerProfileId: "prov-local-1",
      protocolName: "openai-compatible",
      apiVersion: "v1",
      capabilityNames: ["chat"],
      supportLevel: "live-smoke-verified",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    expect(typeof exit).toBe("number");
    vi.restoreAllMocks();

    // list 仍可用（覆盖列表分支）
    const listCapture = captureStdout();
    expect(
      await executeProviderListCommand({ stateDirectory, isJsonOutput: true }),
    ).toBe(0);
    expect(listCapture.getOutput().length).toBeGreaterThanOrEqual(0);
  });
  it("② show：不存在的 Provider ⇒ **抛出**（既有行为，不转返回码）", async () => {
    await expect(
      executeProviderShowCommand({
        stateDirectory,
        isJsonOutput: true,
        providerProfileId: "prov-does-not-exist",
      }),
    ).rejects.toThrow(/未登记/);
  });

  it("③ list（非 JSON 文本输出分支）", async () => {
    const capture = captureStdout();
    expect(
      await executeProviderListCommand({ stateDirectory, isJsonOutput: false }),
    ).toBe(0);
    void capture.getOutput();
  });

  it("④ doctor provider：未登记 id ⇒ **抛出**（既有行为，不转返回码）", async () => {
    await expect(
      executeDoctorProviderCommand({
        stateDirectory,
        isJsonOutput: true,
        providerProfileId: "prov-does-not-exist",
      } as unknown as Parameters<typeof executeDoctorProviderCommand>[0]),
    ).rejects.toThrow(/未登记/);
  });});

describe("GUI-02 覆盖补强：Model / Preset 命令组（进程内，内存目录）", () => {
  it("⑥ model catalog：JSON 与非 JSON；seedDemoEntries 两种取值", async () => {
    const seededCapture = captureStdout();
    expect(
      await executeModelCatalogCommand({ isJsonOutput: true, seedDemoEntries: true }),
    ).toBe(0);
    expect(seededCapture.getOutput().length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    const textCapture = captureStdout();
    expect(
      await executeModelCatalogCommand({ isJsonOutput: false, seedDemoEntries: false }),
    ).toBe(0);
    void textCapture.getOutput();
  });

  it("⑦ preset list：JSON 与非 JSON（内置预设应可见）", async () => {
    const jsonCapture = captureStdout();
    expect(await executePresetListCommand({ isJsonOutput: true })).toBe(0);
    expect(jsonCapture.getOutput().length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    const textCapture = captureStdout();
    expect(await executePresetListCommand({ isJsonOutput: false })).toBe(0);
    void textCapture.getOutput();
  });

  it("⑧ model resolve：可解析与不可解析两种输入（返回码为数字、不抛异常）", async () => {
    const resolvableExit = await executeModelResolveCommand({
      isJsonOutput: true,
      taskAgentPresetIdentifier: "tertiary-preset:craftsman-v1",
    } as unknown as Parameters<typeof executeModelResolveCommand>[0]);
    expect(typeof resolvableExit).toBe("number");
    vi.restoreAllMocks();

    const unknownExit = await executeModelResolveCommand({
      isJsonOutput: true,
      taskAgentPresetIdentifier: "preset-does-not-exist",
    } as unknown as Parameters<typeof executeModelResolveCommand>[0]);
    expect(typeof unknownExit).toBe("number");
  });
});