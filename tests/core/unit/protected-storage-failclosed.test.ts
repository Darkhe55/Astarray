/**
 * AR-01a 确定性单测：受保护存储策略的 fail-closed 分支。
 * 通过 vi.mock node:fs/promises 注入可控行为，不依赖真实文件系统链接的
 * 平台/时序差异（Windows junction 对 lstat 返回 ENOENT 是 Node 平台局限）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

const mockedFs = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock("node:fs/promises", () => mockedFs);

const STATE_DIRECTORY = "C:\\data\\app";

function makePolicy(): ProtectedStoragePolicy {
  return new ProtectedStoragePolicy({ stateDirectoryPath: STATE_DIRECTORY });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("AR-01a 策略 fail-closed（mock 确定性）", () => {
  it("realpath 可解析且真实目标在保护区内 → 拒绝", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockResolvedValue(
      "C:\\data\\app\\backup-vault\\data\\x",
    );
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\workspace\\alias\\data\\x",
        operation: "read",
      }),
    ).rejects.toMatchObject({
      errorCode: "tool-permission-denied",
      message: expect.stringContaining("链接/联接别名"),
    });
  });

  it("realpath 失败且路径链含符号链接 → fail-closed 拒绝", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockedFs.stat.mockResolvedValue({}); // 最近祖先"存在"
    mockedFs.lstat.mockImplementation(async (targetPath: string) => {
      if (String(targetPath).endsWith("alias")) {
        return { isSymbolicLink: () => true };
      }
      return { isSymbolicLink: () => false };
    });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\workspace\\alias\\data\\x",
        operation: "read",
      }),
    ).rejects.toMatchObject({
      errorCode: "tool-permission-denied",
      message: expect.stringContaining("链接/联接"),
    });
  });

  it("realpath 失败且无链接 → 词法判定兜底（普通路径放行）", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockedFs.stat.mockResolvedValue({}); // 最近祖先"存在"
    mockedFs.lstat.mockResolvedValue({ isSymbolicLink: () => false });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\missions\\m\\task-chain.json",
        operation: "read",
      }),
    ).resolves.toBeUndefined();
  });

  it("realpath 失败、无链接但词法路径在保护区内 → 词法拒绝", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\backup-vault\\data\\x",
        operation: "read",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("Windows 大小写变体（词法）直接拒绝", async () => {
    const policy = makePolicy();
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: "C:\\data\\app\\Backup-Vault\\Data\\x",
        operation: "read",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    expect(mockedFs.realpath).not.toHaveBeenCalled();
  });
});
