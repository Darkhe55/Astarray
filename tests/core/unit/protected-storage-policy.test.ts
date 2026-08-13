/**
 * AR-01 安全反例测试：普通工具不得访问备份保管库与审计存储。
 * 这些反例在 builtins 接线 ProtectedStoragePolicy 之前应当失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import type { ToolCallResult } from "../../../packages/core/src/core/types.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS, executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { BackupVault } from "../../../packages/core/src/tools/backup-vault.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let protectedStoragePolicy: ProtectedStoragePolicy;
let registry: ToolRegistry;
let wrapper: PolicyWrapper;
let vault: BackupVault;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar01-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: temporaryDirectory,
  });
  registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  // 真实场景：工作区根 = 项目根，状态目录（含保管库）位于工作区内
  const modeMachine = new ModeMachine("devolve");
  const sessionManager = new SessionAuthorizationManager();
  const permissionDecider = new PermissionDecider(modeMachine, sessionManager);
  wrapper = new PolicyWrapper({
    permissionDecider,
    registry,
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => 1_800_000_000,
    getCurrentMode: () => modeMachine.getCurrentMode(),
    protectedStoragePolicy,
  });
  vault = new BackupVault({ baseDirectory: temporaryDirectory });
  await vault.initialize();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

/** 在保管库内放置一个真实备份与审计文件，供反例使用。 */
async function seedProtectedContent(): Promise<{ backupIdentifier: string }> {
  const victimPath = path.join(workspaceDirectory, "victim.txt");
  await fs.writeFile(victimPath, "受保护内容", "utf8");
  const receipt = await vault.createPreMutationBackup({
    toolName: "replaceFileContent",
    targetPath: victimPath,
    mutationKind: "overwrite",
  });
  await fs.appendFile(
    path.join(temporaryDirectory, "backup-deletion-audit.jsonl"),
    '{"auditRecordId":"audit-1"}\n',
    "utf8",
  );
  return { backupIdentifier: receipt.backupIdentifier };
}

describe("AR-01 安全反例：普通工具不得访问受保护存储", () => {
  it("readFile 读取保管库文件必须被拒绝", async () => {
    const { backupIdentifier } = await seedProtectedContent();
    const protectedFilePath = path.join(
      temporaryDirectory,
      "backup-vault",
      "data",
      backupIdentifier,
    );
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: protectedFilePath }),
      "ar01-read-vault",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(
      (result as Extract<ToolCallResult, { kind: "error" }>).errorCode,
    ).toBe("tool-permission-denied");
  });

  it("readFile 读取审计文件必须被拒绝", async () => {
    await seedProtectedContent();
    const auditFilePath = path.join(
      temporaryDirectory,
      "backup-deletion-audit.jsonl",
    );
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: auditFilePath }),
      "ar01-read-audit",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(
      (result as Extract<ToolCallResult, { kind: "error" }>).errorCode,
    ).toBe("tool-permission-denied");
  });

  it("listDirectory 列出保管库根必须被拒绝", async () => {
    await seedProtectedContent();
    const result = await wrapper.execute(
      "listDirectory",
      JSON.stringify({ directoryPath: "backup-vault" }),
      "ar01-list-vault",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(
      (result as Extract<ToolCallResult, { kind: "error" }>).errorCode,
    ).toBe("tool-permission-denied");
  });

  it("replaceFileContent 覆盖保管库文件必须被拒绝", async () => {
    const { backupIdentifier } = await seedProtectedContent();
    const protectedFilePath = path.join(
      temporaryDirectory,
      "backup-vault",
      "data",
      backupIdentifier,
    );
    const result = await wrapper.execute(
      "replaceFileContent",
      JSON.stringify({ filePath: protectedFilePath, content: "篡改" }),
      "ar01-replace-vault",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(
      (result as Extract<ToolCallResult, { kind: "error" }>).errorCode,
    ).toBe("tool-permission-denied");
  });

  it("列出 .astarray（状态目录）不暴露受保护子项", async () => {
    await seedProtectedContent();
    const result = await executeBuiltinTool(
      "listDirectory",
      JSON.stringify({ directoryPath: temporaryDirectory }),
      {
        workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
        temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
        requestingAgentInstanceId: "agent-ar01",
        backupServicePort: null,
        vault: null,
        deletionController: null,
        protectedStoragePolicy,
      },
    );
    expect(result.outputText).not.toContain("backup-vault");
    expect(result.outputText).not.toContain("backup-deletion-audit.jsonl");
  });
});

describe("ProtectedStoragePolicy 路径判定", () => {
  it("`..`、大小写与 Windows 分隔符不能绕过（规范化组件判定）", () => {
    const policy = new ProtectedStoragePolicy({
      stateDirectoryPath: "C:\\data\\app",
    });
    // 大小写变化（Windows 不区分）与 .. 穿越均命中保护区
    expect(
      policy.isProtectedPath("C:\\data\\app\\backup-vault\\data\\x"),
    ).toBe(true);
    expect(
      policy.isProtectedPath("C:\\data\\app\\backup-vault\\..\\backup-vault\\x"),
    ).toBe(true);
    expect(
      policy.isProtectedPath("C:\\data\\app\\backup-deletion-audit.jsonl"),
    ).toBe(true);
    // 工作区普通路径不受影响
    expect(policy.isProtectedPath("C:\\data\\app\\missions\\m\\task-chain.json")).toBe(false);
  });

  it("受保护根自身不可访问", async () => {
    const policy = new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    });
    expect(policy.isProtectedPath(path.join(temporaryDirectory, "backup-vault"))).toBe(true);
    await expect(
      policy.assertGenericToolAccessAllowed({
        canonicalTargetPath: path.join(temporaryDirectory, "backup-vault"),
        operation: "list",
      }),
    ).rejects.toThrowError(/受保护存储/);
  });

  it("filterProtectedEntries 只过滤状态目录中的受保护条目（AR-01a 收窄）", () => {
    const policy = new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    });
    const entries = [
      "missions",
      "backup-vault",
      "backup-deletion-audit.jsonl",
      "config.json",
    ];
    // 状态目录：过滤
    const filtered = policy.filterProtectedEntries(temporaryDirectory, entries);
    expect(filtered).toEqual(["missions", "config.json"]);
    // 任意普通目录：同名普通文件不被隐藏
    const ordinaryDirectory = path.join(workspaceDirectory, "docs");
    expect(
      policy.filterProtectedEntries(ordinaryDirectory, ["backup-vault", "notes.md"]),
    ).toEqual(["backup-vault", "notes.md"]);
  });

  it("listBackups 公开 DTO 不含对象哈希、能力标识与物理路径（AR-01）", async () => {
    const { backupIdentifier } = await seedProtectedContent();
    const summaries = await vault.listBackups(null);
    expect(summaries).toHaveLength(1);
    const serialized = JSON.stringify(summaries[0]);
    expect(serialized).not.toContain("targetFingerprintBeforeMutation");
    expect(serialized).not.toContain("backupContentHash");
    expect(serialized).not.toContain("restoreCapabilityIdentifier");
    expect(serialized).not.toContain("backup-vault/data");
    expect(summaries[0]).toMatchObject({
      backupIdentifier,
      toolName: "replaceFileContent",
      status: "active",
    });
  });

  it("预检后目标被替换为工作区外链接时，执行前复检拦截（TOCTOU）", async () => {
    // 被读文件置于子目录；复检时把子目录替换为指向外部的目录联接/junction（Windows 免特权）
    const subDirectory = path.join(workspaceDirectory, "sub");
    const targetPath = path.join(subDirectory, "toc.txt");
    await fs.mkdir(subDirectory, { recursive: true });
    await fs.writeFile(targetPath, "内容", "utf8");
    const outsideDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-ar01-outside-"),
    );
    await fs.writeFile(path.join(outsideDirectory, "secret.txt"), "机密", "utf8");

    // 包装 workspaceBoundary：第一次 resolve（预检）后，把子目录替换为指向工作区外的链接
    const boundary = new WorkspaceBoundary(temporaryDirectory);
    let resolveCallCount = 0;
    const toctouBoundary = {
      resolveWithinWorkspace: async (requestedPath: string) => {
        resolveCallCount += 1;
        if (resolveCallCount === 2) {
          await fs.rm(subDirectory, { recursive: true, force: true });
          await fs.symlink(outsideDirectory, subDirectory, "junction");
        }
        return boundary.resolveWithinWorkspace(requestedPath);
      },
    };
    // 复检（realpath）发现链接逃逸 → 直接抛 path-escape-attempt
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "workspace/sub/toc.txt" }),
        {
          workspaceBoundary: toctouBoundary as never,
          temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
          requestingAgentInstanceId: "agent-toc",
          backupServicePort: null,
          vault: null,
          deletionController: null,
          protectedStoragePolicy,
        },
      ),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
  });

  it("AR-01a：Windows 大小写变化不能绕过审计文件保护", async () => {
    const policy = new ProtectedStoragePolicy({
      stateDirectoryPath: "C:\\data\\app",
    });
    const caseVariants = [
      "C:\\data\\app\\BACKUP-DELETION-AUDIT.JSONL",
      "C:\\data\\app\\Backup-Deletion-Audit.jsonl",
      "C:\\data\\app\\BACKUP-VAULT",
      "C:\\data\\app\\Backup-Vault\\Data\\x",
    ];
    for (const variant of caseVariants) {
      expect(policy.isProtectedPath(variant)).toBe(true);
    }
    if (process.platform === "win32") {
      await expect(
        policy.assertGenericToolAccessAllowed({
          canonicalTargetPath: "C:\\data\\app\\Backup-Deletion-Audit.JSONL",
          operation: "read",
        }),
      ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    }
  });

  it("AR-01a：工作区内指向保管库的联接/符号链接别名不能读取保护内容", async () => {
    const { backupIdentifier } = await seedProtectedContent();
    // 工作区内建立 junction/符号链接：workspace/alias → backup-vault
    const aliasPath = path.join(workspaceDirectory, "alias");
    await fs.symlink(
      path.join(temporaryDirectory, "backup-vault"),
      aliasPath,
      "junction",
    );
    const aliasRealPath = await fs.realpath(aliasPath);
    expect(aliasRealPath).toContain("backup-vault");
    // 预检：确认别名可读（junction 有效）
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(
      fs.readFile(path.join(aliasPath, "data", backupIdentifier), "utf8"),
    ).resolves.toContain("schemaVersion");

    // 直连验证（绕过 wrapper）：别名访问必须拿不到保管库内容。
    // 注：Windows junction 对 lstat 返回 ENOENT 是 Node 平台局限，lstat 链检测不适用；
    // 安全目标为"模型经别名无法读取保护内容"：realpath 成功分支会拒绝，
    // realpath 失败时访问本身失败（ENOENT），两者均不可读。
    const directResult = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: path.join("alias", "data", backupIdentifier) }),
      {
        workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
        temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
        requestingAgentInstanceId: "agent-alias-direct",
        backupServicePort: null,
        vault: null,
        deletionController: null,
        protectedStoragePolicy,
      },
    ).catch((error: unknown) => ({
      kind: "error",
      errorCode:
        (error as { errorCode?: string }).errorCode ?? "thrown",
      errorMessage: (error as Error).message ?? "",
    }));
    const directOutput = JSON.stringify(directResult);
    expect(directOutput).not.toContain("schemaVersion");

    // wrapper 路径同样不可读
    const wrapperResult = await wrapper.execute(
      "readFile",
      JSON.stringify({
        filePath: path.join("alias", "data", backupIdentifier),
      }),
      "ar01a-alias-wrapper",
      new AbortController().signal,
    );
    expect(JSON.stringify(wrapperResult)).not.toContain("schemaVersion");

    // 预检：备份对象确实存在于真实保管库路径（junction 有效）
    const realBackupPath = path.join(
      temporaryDirectory,
      "backup-vault",
      "data",
      backupIdentifier,
    );
    await expect(fs.access(realBackupPath)).resolves.toBeUndefined();
  });

  it("AR-01a：replaceFileContent 使用复检后的路径（预检后换链被拦截）", async () => {
    const subDirectory = path.join(workspaceDirectory, "replace-target");
    const targetPath = path.join(subDirectory, "file.txt");
    await fs.mkdir(subDirectory, { recursive: true });
    await fs.writeFile(targetPath, "原始", "utf8");
    const outsideDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-ar01a-outside-"),
    );
    const boundary = new WorkspaceBoundary(temporaryDirectory);
    let resolveCallCount = 0;
    const toctouBoundary = {
      resolveWithinWorkspace: async (requestedPath: string) => {
        resolveCallCount += 1;
        if (resolveCallCount === 2) {
          await fs.rm(subDirectory, { recursive: true, force: true });
          await fs.symlink(outsideDirectory, subDirectory, "junction");
        }
        return boundary.resolveWithinWorkspace(requestedPath);
      },
    };
    await expect(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({ filePath: "workspace/replace-target/file.txt", content: "篡改" }),
        {
          workspaceBoundary: toctouBoundary as never,
          temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
          requestingAgentInstanceId: "agent-replace",
          backupServicePort: vault,
          vault,
          deletionController: null,
          protectedStoragePolicy,
        },
      ),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
  });
});
