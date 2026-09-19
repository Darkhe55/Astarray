/**
 * AR-01a 确定性单测：受保护存储策略的 fail-closed 分支。
 * 通过 vi.mock node:fs/promises 注入可控行为，不依赖真实文件系统链接的
 * 平台/时序差异（Windows junction 对 lstat 返回 ENOENT 是 Node 平台局限）。
 * LINUX-PORT-01：路径夹具按宿主平台构造；大小写语义由注入的文件系统能力决定，
 * 不再假定 POSIX 上存在大小写折叠。
 */
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

const mockedFs = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  mkdtemp: vi.fn(),
}));

vi.mock("node:fs/promises", () => mockedFs);

const STATE_DIRECTORY =
  process.platform === "win32" ? "C:\\data\\app" : "/data/app";

function statePath(...pathSegments: string[]): string {
  return path.join(STATE_DIRECTORY, ...pathSegments);
}

function makePolicy(
  fileSystemCaseSensitivity?: "case-sensitive" | "case-insensitive",
): ProtectedStoragePolicy {
  return new ProtectedStoragePolicy({
    stateDirectoryPath: STATE_DIRECTORY,
    ...(fileSystemCaseSensitivity === undefined ? {} : { fileSystemCaseSensitivity }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("AR-01a 策略 fail-closed（mock 确定性）", () => {
  it("realpath 可解析且真实目标在保护区内 → 拒绝", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockResolvedValue(statePath("backup-vault", "data", "x"));
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("workspace", "alias", "data", "x"),
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
    mockedFs.stat.mockResolvedValue({});
    mockedFs.lstat.mockImplementation(async (targetPath: string) => {
      if (String(targetPath).endsWith("alias")) {
        return { isSymbolicLink: () => true };
      }
      return { isSymbolicLink: () => false };
    });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("workspace", "alias", "data", "x"),
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
    mockedFs.stat.mockResolvedValue({});
    mockedFs.lstat.mockResolvedValue({ isSymbolicLink: () => false });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("missions", "m", "task-chain.json"),
        operation: "read",
      }),
    ).resolves.toBeUndefined();
  });

  it("realpath 返回非字符串时按词法路径兜底（fail-safe，不抛类型错误）", async () => {
    const policy = makePolicy();
    mockedFs.realpath.mockResolvedValue(undefined);
    mockedFs.stat.mockResolvedValue({});
    mockedFs.lstat.mockResolvedValue({ isSymbolicLink: () => false });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("missions", "m", "task-chain.json"),
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
        canonicalTargetPath: statePath("backup-vault", "data", "x"),
        operation: "read",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("大小写不敏感文件系统：大小写变体直接拒绝（不调用 realpath）", async () => {
    const policy = makePolicy("case-insensitive");
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("Backup-Vault", "Data", "x"),
        operation: "read",
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    expect(mockedFs.realpath).not.toHaveBeenCalled();
  });

  it("大小写敏感文件系统：大小写变体是不同资源，不命中保护区", async () => {
    const policy = makePolicy("case-sensitive");
    mockedFs.realpath.mockResolvedValue(statePath("Backup-Vault", "Data", "x"));
    mockedFs.stat.mockResolvedValue({});
    mockedFs.lstat.mockResolvedValue({ isSymbolicLink: () => false });
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: statePath("Backup-Vault", "Data", "x"),
        operation: "read",
      }),
    ).resolves.toBeUndefined();
  });
});
