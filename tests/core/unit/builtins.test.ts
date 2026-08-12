import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import {
  BackupDeletionAuditLog,
  BackupDeletionAuthorizationController,
  BackupVault,
} from "../../../packages/core/src/tools/backup-vault.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let temporaryDirectoryPath: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-builtins-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(temporaryDirectoryPath);
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function executionContext() {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath,
    requestingAgentInstanceId: "agent-test",
    backupServicePort: null,
    vault: null,
    deletionController: null,
  };
}

describe("executeBuiltinTool", () => {
  it("readFile 读取工作区文件", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "a.txt"), "内容", "utf8");
    const result = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      executionContext(),
    );
    expect(result).toEqual({ outputText: "内容", isSideEffectFree: true });
  });

  it("readFile 参数非法报错", async () => {
    await expect(
      executeBuiltinTool("readFile", JSON.stringify({}), executionContext()),
    ).rejects.toThrowError(/filePath/);
  });

  it("readFile 文件不存在报错", async () => {
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "missing.txt" }),
        executionContext(),
      ),
    ).rejects.toThrow();
  });

  it("listDirectory 列出目录条目", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "a.txt"), "1", "utf8");
    await fs.mkdir(path.join(workspaceDirectory, "sub"));
    const result = await executeBuiltinTool(
      "listDirectory",
      JSON.stringify({ directoryPath: "." }),
      executionContext(),
    );
    expect(result.outputText).toContain("a.txt");
    expect(result.outputText).toContain("d sub");
  });

  it("listDirectory 参数非法报错", async () => {
    await expect(
      executeBuiltinTool("listDirectory", JSON.stringify({ directoryPath: 42 }), executionContext()),
    ).rejects.toThrowError(/directoryPath/);
  });

  it("writeFileTemporary 写入临时目录", async () => {
    const result = await executeBuiltinTool(
      "writeFileTemporary",
      JSON.stringify({ fileName: "out.txt", content: "数据" }),
      executionContext(),
    );
    expect(result.isSideEffectFree).toBe(false);
    const written = await fs.readFile(path.join(temporaryDirectoryPath, "out.txt"), "utf8");
    expect(written).toBe("数据");
  });

  it("writeFileTemporary 目标已存在时拒绝且保留原内容", async () => {
    const targetPath = path.join(temporaryDirectoryPath, "existing.txt");
    await fs.writeFile(targetPath, "原内容", "utf8");

    await expect(
      executeBuiltinTool(
        "writeFileTemporary",
        JSON.stringify({ fileName: "existing.txt", content: "覆盖内容" }),
        executionContext(),
      ),
    ).rejects.toThrow();

    expect(await fs.readFile(targetPath, "utf8")).toBe("原内容");
  });

  it("writeFileTemporary 参数缺失报错", async () => {
    await expect(
      executeBuiltinTool("writeFileTemporary", JSON.stringify({ fileName: "x" }), executionContext()),
    ).rejects.toThrowError(/content/);
  });

  it("writeFileTemporary 拒绝绝对路径文件名", async () => {
    await expect(
      executeBuiltinTool(
        "writeFileTemporary",
        JSON.stringify({ fileName: "C:/Windows/system.ini", content: "x" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/相对文件名/);
  });

  it("未知内置工具报错", async () => {
    await expect(
      executeBuiltinTool("deleteFile", JSON.stringify({}), executionContext()),
    ).rejects.toThrowError(/未知内置工具/);
  });
});

describe("T06A 备份层内置工具", () => {
  it("replaceFileContent：变更前自动保存 pre-image，可经 backupVault 恢复", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "notes.txt");
    await fs.writeFile(targetPath, "原始笔记", "utf8");
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-a",
      backupServicePort: vault,
      vault,
      deletionController: null,
    };
    const result = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: "notes.txt", content: "新笔记" }),
      context,
    );
    expect(result.outputText).toContain("自动备份");
    expect(await fs.readFile(targetPath, "utf8")).toBe("新笔记");
    const entries = await vault.listBackups(null);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "replaceFileContent", status: "active" });
    expect(await vault.readBackup(entries[0]!.backupIdentifier)).toBe("原始笔记");
    await vault.restoreBackup(entries[0]!.backupIdentifier);
    expect(await fs.readFile(targetPath, "utf8")).toBe("原始笔记");
  });

  it("replaceFileContent 缺少备份端口时拒绝执行", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "notes.txt"), "内容", "utf8");
    await expect(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({ filePath: "notes.txt", content: "x" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/缺少自动备份端口/);
  });

  it("deleteBackup：放权模式两阶段删除并写 HIGH 审计", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "victim.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    const modeMachine = new ModeMachine("devolve");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const deletionController = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: null,
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-devolve",
      backupServicePort: vault,
      vault,
      deletionController,
    };
    const result = await executeBuiltinTool(
      "deleteBackup",
      JSON.stringify({ backupIdentifiers: [receipt.backupIdentifier] }),
      context,
    );
    expect(result.outputText).toContain("已删除备份");
    expect(await vault.listBackups(null)).toHaveLength(0);
    const records = await auditLog.readAllRecords();
    const outcomes = records.map((record) => record.outcome);
    expect(outcomes).toEqual(["authorized", "quarantined", "purged"]);
    expect(records[0]?.reviewPriority).toBe("high");
  });

  it("deleteBackup：协同模式用户拒绝时不删除", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "victim.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const receipt = await vault.createPreMutationBackup({
      toolName: "deleteFile",
      targetPath,
      mutationKind: "delete-resource",
    });
    const modeMachine = new ModeMachine("assist");
    const auditLog = new BackupDeletionAuditLog(temporaryDirectory);
    const deletionController = new BackupDeletionAuthorizationController({
      mode: () => modeMachine.getCurrentMode(),
      controlPort: {
        requestAuthorization: async (request) => ({
          authorizationRequestId: request.authorizationRequestId,
          requestingAgentInstanceId: request.requestingAgentInstanceId,
          decision: "deny",
          authorizedBackupIdentifiers: [],
          expectedVaultRevision: 1,
          expiresAtIso: "2026-08-12T10:30:00.000Z",
        }),
      },
      auditLog,
      readCurrentVaultRevision: () => vault.getManifestRevision(),
    });
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-assist",
      backupServicePort: vault,
      vault,
      deletionController,
    };
    await expect(
      executeBuiltinTool(
        "deleteBackup",
        JSON.stringify({ backupIdentifiers: [receipt.backupIdentifier] }),
        context,
      ),
    ).rejects.toThrowError(/未获授权|拒绝/);
    expect(await vault.listBackups(null)).toHaveLength(1);
  });

  it("backupVault：list/read/restore 操作", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "doc.md");
    await fs.writeFile(targetPath, "v1", "utf8");
    await vault.createPreMutationBackup({
      toolName: "replaceFileContent",
      targetPath,
      mutationKind: "overwrite",
    });
    await fs.writeFile(targetPath, "v2", "utf8");
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-a",
      backupServicePort: vault,
      vault,
      deletionController: null,
    };
    const listResult = await executeBuiltinTool(
      "backupVault",
      JSON.stringify({ action: "list" }),
      context,
    );
    expect(listResult.outputText).toContain("doc.md");
    const backupIdentifier = (await vault.listBackups(null))[0]!.backupIdentifier;
    const readResult = await executeBuiltinTool(
      "backupVault",
      JSON.stringify({ action: "read", backupIdentifier }),
      context,
    );
    expect(readResult.outputText).toBe("v1");
    const restoreResult = await executeBuiltinTool(
      "backupVault",
      JSON.stringify({ action: "restore", backupIdentifier }),
      context,
    );
    expect(restoreResult.outputText).toContain("已恢复");
    expect(await fs.readFile(targetPath, "utf8")).toBe("v1");
  });

  it("backupVault 非法 action 报错", async () => {
    await expect(
      executeBuiltinTool(
        "backupVault",
        JSON.stringify({ action: "purge" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/list\/read\/restore/);
  });

  it("replaceFileContent 输出不暴露备份 ID（审计 S3）", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "secret.md");
    await fs.writeFile(targetPath, "原始", "utf8");
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-a",
      backupServicePort: vault,
      vault,
      deletionController: null,
    };
    const result = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: "secret.md", content: "新内容" }),
      context,
    );
    const backupIdentifier = (await vault.listBackups(null))[0]!.backupIdentifier;
    expect(result.outputText).not.toContain(backupIdentifier);
  });

  it("replaceFileContent TOCTOU 防护：备份后目标被修改则中止写入（审计 S3）", async () => {
    const vault = new BackupVault({ baseDirectory: temporaryDirectory });
    await vault.initialize();
    const targetPath = path.join(workspaceDirectory, "race.md");
    await fs.writeFile(targetPath, "原始", "utf8");
    const context = {
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      requestingAgentInstanceId: "agent-a",
      backupServicePort: vault,
      vault,
      deletionController: null,
    };
    // 备份后、写入前模拟第三方修改：用包装端口篡改目标指纹
    const wrappedBackupPort = {
      createPreMutationBackup: async (input: {
        toolName: string;
        targetPath: string;
        mutationKind: string;
      }) => {
        const receipt = await vault.createPreMutationBackup({
          toolName: input.toolName,
          targetPath: input.targetPath,
          mutationKind: input.mutationKind as "overwrite",
        });
        // 第三方在备份后修改了目标
        await fs.writeFile(targetPath, "被第三方篡改", "utf8");
        return receipt;
      },
      verifyTargetUnchanged: (path: string, fingerprint: string) =>
        vault.verifyTargetUnchanged(path, fingerprint),
    };
    await expect(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({ filePath: "race.md", content: "攻击载荷" }),
        { ...context, backupServicePort: wrappedBackupPort },
      ),
    ).rejects.toThrowError(/TOCTOU/);
    expect(await fs.readFile(targetPath, "utf8")).toBe("被第三方篡改");
  });
});
