/**
 * AR-07：关键模块分支缺口补测（backup-vault / sensitive-content / policy-wrapper）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupVault } from "../../../packages/core/src/tools/backup-vault.js";
import {
  SensitiveContentAccessPolicy,
  SensitiveResourceIdentityResolver,
} from "../../../packages/core/src/tools/sensitive-content-access-policy.js";
import type { SensitiveResourceIdentity } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function buildWrapper(overrides: Record<string, unknown> = {}): PolicyWrapper {
  const modeMachine = new ModeMachine("assist");
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
    registry,
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => 1_000_000,
    getCurrentMode: () => modeMachine.getCurrentMode(),
    protectedStoragePolicy: new ProtectedStoragePolicy({ stateDirectoryPath: temporaryDirectory }),
    ...overrides,
  });
}

function buildIdentity(overrides: Partial<SensitiveResourceIdentity> = {}): SensitiveResourceIdentity {
  return {
    canonicalPath: "C:/a.txt",
    realPath: "C:/a.txt",
    deviceInode: "1:2",
    normalizedCasePath: "c:/a.txt",
    isLinkLike: false,
    ...overrides,
  } as SensitiveResourceIdentity;
}

describe("AR-07：BackupVault 分支缺口", () => {
  it("二进制快照读取返回 base64；目录快照返回结构化清单", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();

    const binaryPath = path.join(temporaryDirectory, "binary.bin");
    await fs.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const binaryReceipt = await vault.createPreMutationBackup({
      toolName: "test",
      targetPath: binaryPath,
      mutationKind: "overwrite",
    });
    const binaryRead = await vault.readBackup(binaryReceipt.backupIdentifier);
    expect(binaryRead.encoding).toBe("base64");
    expect(binaryRead.mediaType).toBe("application/octet-stream");

    const directoryPath = path.join(temporaryDirectory, "dir-snapshot");
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(path.join(directoryPath, "inner.txt"), "内容", "utf8");
    const directoryReceipt = await vault.createPreMutationBackup({
      toolName: "test",
      targetPath: directoryPath,
      mutationKind: "delete-resource",
    });
    const directoryRead = await vault.readBackup(directoryReceipt.backupIdentifier);
    expect(directoryRead.mediaType).toBe("application/vnd.astarray.directory-snapshot");
    expect(directoryRead.content).toContain("inner.txt");
  });

  it("损坏快照（非对象 JSON）读取 fail-closed（journal-corrupted）", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(temporaryDirectory, "target.txt");
    await fs.writeFile(targetPath, "x", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "test",
      targetPath,
      mutationKind: "overwrite",
    });
    const preImagePath = path.join(
      temporaryDirectory,
      "backup-vault",
      "data",
      receipt.backupIdentifier,
    );
    await fs.writeFile(preImagePath, "null", "utf8");
    await expect(vault.readBackup(receipt.backupIdentifier)).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("恢复不存在的备份报 mission-not-found；隔离/清除未知 ID 安全跳过", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    await expect(vault.restoreBackup("backup-missing")).rejects.toMatchObject({
      errorCode: "mission-not-found",
    });
    expect(await vault.quarantineBackups(["backup-missing"])).toEqual([]);
    expect(await vault.purgeQuarantinedBackups(["backup-missing"])).toEqual([]);
  });
});

describe("AR-07：SensitiveContentAccessPolicy 分支缺口", () => {
  it("isSameResource：realpath 相同或硬链接身份相同即同一资源", () => {
    const resolver = new SensitiveResourceIdentityResolver();
    const base = buildIdentity();
    const sameRealPath = buildIdentity({ deviceInode: "9:9" });
    const sameInode = buildIdentity({
      realPath: "C:/b.txt",
      canonicalPath: "C:/b.txt",
      deviceInode: "1:2",
    });
    const different = buildIdentity({
      realPath: "C:/c.txt",
      canonicalPath: "C:/c.txt",
      deviceInode: "3:4",
    });
    expect(resolver.isSameResource(base, sameRealPath)).toBe(true);
    expect(resolver.isSameResource(base, sameInode)).toBe(true);
    expect(resolver.isSameResource(base, different)).toBe(false);
  });

  it("附加敏感模式命中归入 admin-extended", () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePatterns: [/forbidden-secret-name/i],
    });
    expect(policy.matchSensitivePathName("forbidden-secret-name.txt")).toBe("admin-extended");
  });

  it("DLP 命中但类别缺失时使用 dlp:unknown 稳定拒绝码", async () => {
    const policy = new SensitiveContentAccessPolicy({
      dlpScanner: {
        scanTextContent: async () => ({ isSensitive: true, matchedRuleCategory: null }),
      } as never,
    });
    const targetPath = path.join(temporaryDirectory, "ordinary.txt");
    await fs.writeFile(targetPath, "ordinary", "utf8");
    await expect(
      policy.assertSensitiveContentReadAllowed({
        canonicalPath: targetPath,
        content: "anything",
      } as never),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });
});

describe("AR-07：PolicyWrapper 分支缺口", () => {
  it("安装门禁装配且未提供执行标识时使用默认值", async () => {
    const assertInstallationAllowed = vi.fn(async () => ({ allowed: true, reason: null }));
    const wrapper = buildWrapper({
      installationGateGuard: { assertInstallationAllowed } as never,
      requestingAgentInstanceId: undefined,
      taskExecutionId: undefined,
    });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-1",
      new AbortController().signal,
    );
    expect(assertInstallationAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ requestingAgentInstanceId: "unknown-agent", taskExecutionId: "" }),
    );
    expect(result.kind).toBeDefined();
  });

  it("可配置引擎返回 ask → 执行前询问用户", async () => {
    const wrapper = buildWrapper({
      configurablePermissionPolicyEngine: {
        decide: async () => ({ decision: "ask" }),
      } as never,
      currentPermissionProfileReference: {
        permissionProfileId: "builtin:assist",
        displayName: "assist",
        isBuiltin: true,
        revision: 1,
        catalogVersion: 1,
      },
    });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-2",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect((result as { errorCode?: string }).errorCode).toBe("permission-ask-pending");
  });

  it("引擎装配但权限组引用 undefined → 授予会话授权被拒绝", async () => {
    const wrapper = buildWrapper({
      configurablePermissionPolicyEngine: { decide: async () => ({ decision: "allow" }) } as never,
      currentPermissionProfileReference: undefined,
    });
    await expect(
      wrapper.grantConfigurableSessionAuthorization({
        toolName: "project.read",
        argumentsJson: "{}",
      } as never),
    ).rejects.toThrow(/未装配/);
  });
});
