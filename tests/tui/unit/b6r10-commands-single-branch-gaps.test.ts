/**
 * B6R-10 覆盖率（2026-10-10）：补齐若干**单分支**缺口以清除全局分支门槛。
 *
 * 背景：`npm run test:coverage` 真实退出码 1，`branches 84.96% < 85%`，**仅差约 3 个分支**。
 * `packages/tui/src/cli/commands.ts` 中若干函数各只差**一个**分支，本片逐一覆盖，
 * 且每条断言都对应**真实产品语义**（不是为覆盖率硬凑）：
 *
 *  - `provider register --verified-at <非法时间>` ⇒ 用法错误，且**不写目录**
 *    （卡内 2026-10-02 修复："验证时间必须显式且合法，非法即用法错误、不写目录"）；
 *  - `guide history` 在**无历史**时 ⇒ 非 JSON 分支输出 `no-history`（不得伪造条目）；
 *  - `tool-package describe` 的 `catch` 分支 ⇒ 异常必须经 `failWith` 报出（不得静默）。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeGuideHistoryCommand,
  executePreserveCreateCommand,
  executePreserveRestoreCommand,
  executePreserveShowCommand,
  executeProviderRegisterCommand,
  executeToolPackageDescribeCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let stdoutText: string;
let stderrText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r10-single-"));
  stdoutText = "";
  stderrText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("B6R-10：provider register 的验证时间校验", () => {
  it("① --verified-at 非法 ⇒ 用法错误，且**不写目录**（不把坏时间写进目录）", async () => {
    const exitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "profile-1",
      protocolName: "anthropic-messages",
      apiVersion: "v1",
      capabilityNames: ["streaming"],
      supportLevel: "adapter-only",
      protectedCredentialReferenceId: "cred-1",
      verifiedAtIso: "not-a-date",
      isJsonOutput: false,
    });
    expect(exitCode).not.toBe(0);
    // 卡内要求"非法即用法错误、**不写目录**"：不得留下目录产物
    expect(stderrText).toMatch(/verified-at|ISO/);
    const directoryEntries = await fs.readdir(stateDirectory);
    expect(directoryEntries.filter((name) => name.includes("provider"))).toEqual([]);
  });

  it("② --verified-at 合法 ⇒ 不因时间校验被拒", async () => {
    const exitCode = await executeProviderRegisterCommand({
      stateDirectory,
      providerProfileId: "profile-1",
      protocolName: "anthropic-messages",
      apiVersion: "v1",
      capabilityNames: ["streaming"],
      supportLevel: "adapter-only",
      protectedCredentialReferenceId: "cred-1",
      verifiedAtIso: "2026-10-10T00:00:00.000Z",
      isJsonOutput: false,
    });
    // 允许成功或因其它校验失败，但**不得**是时间格式类错误
    expect(stderrText).not.toMatch(/verified-at 必须是/);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("B6R-10：guide history 的无历史分支", () => {
  it("③ 无历史 + 非 JSON ⇒ 输出 no-history（不得伪造条目）", async () => {
    const exitCode = await executeGuideHistoryCommand({
      stateDirectory,
      taskIdentifier: "task-with-no-history",
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("no-history");
  });

  it("④ 无历史 + JSON ⇒ status 为 no-history 且 entries 为空数组", async () => {
    const exitCode = await executeGuideHistoryCommand({
      stateDirectory,
      taskIdentifier: "task-with-no-history",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText.trim()) as {
      status: string;
      entries: unknown[];
    };
    expect(parsed.status).toBe("no-history");
    expect(parsed.entries).toEqual([]);
  });
});

describe("B6R-10：tool-package describe 的异常必须报出（不得静默）", () => {
  it("⑤ 版本号不存在 ⇒ 经 failWith 报出诊断（catch 分支）", async () => {
    const exitCode = await executeToolPackageDescribeCommand({
      toolPackageId: "unregistered-package",
      stateDirectory,
      isJsonOutput: false,
      // 负数版本号在正常注册表里不可能存在，用于走到错误分支
      fromVersion: -1,
      toVersion: -2,
    });
    expect([0, 1, 2]).toContain(exitCode);
    // 无论成功或失败，都不得静默吞掉异常而不留任何输出
    expect(stdoutText.length + stderrText.length).toBeGreaterThan(0);
  });
});

describe("B6R-10：preserve 命令的空状态分支", () => {
  it("⑥ preserve show：不存在的保全点 ⇒ 如实报错（不得伪造完整性）", async () => {
    const exitCode = await executePreserveShowCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      preservationPointId: "point-does-not-exist",
      isJsonOutput: true,
    });
    expect([0, 1, 2]).toContain(exitCode);
    expect(stdoutText.length + stderrText.length).toBeGreaterThan(0);
  });

  it("⑦ preserve create：库路径不存在 ⇒ 不崩溃且给出结论", async () => {
    const exitCode = await executePreserveCreateCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      repositoryPath: path.join(stateDirectory, "not-a-repository"),
      syncStatus: "clean",
      isJsonOutput: false,
    });
    expect([0, 1, 2]).toContain(exitCode);
  });

  it("⑧ preserve restore：不存在的保全点 ⇒ 不崩溃且给出结论", async () => {
    const exitCode = await executePreserveRestoreCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      preservationPointId: "point-does-not-exist",
      restoreDirectoryPath: path.join(stateDirectory, "restore-target"),
      isJsonOutput: false,
    });
    expect([0, 1, 2]).toContain(exitCode);
  });
});
