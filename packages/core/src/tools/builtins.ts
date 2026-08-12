/**
 * 内置工具（T06/T06A）：只读 + 受限写 + 备份层。
 * shell、安装、发布、付款类默认不提供（未注册 = Devolve 也无法调用）。
 * 所有文件工具强制工作区边界。
 * 破坏性工具（replaceFileContent）在变更前由工具自身调用备份端口自动保存完整 pre-image。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ToolDescriptor } from "../core/types.js";
import type { ToolBackupServicePort } from "../core/types.js";
import type { WorkspaceBoundary } from "./workspace-boundary.js";
import type { BackupDeletionAuthorizationController } from "./backup-vault.js";
import type { BackupVault } from "./backup-vault.js";
import type { ProtectedStoragePolicy } from "./protected-storage-policy.js";
import type { GenericToolFileOperation } from "./protected-storage-policy.js";

export interface BuiltinToolExecutionContext {
  workspaceBoundary: WorkspaceBoundary;
  temporaryDirectoryPath: string;
  requestingAgentInstanceId: string;
  backupServicePort: ToolBackupServicePort | null;
  vault: BackupVault | null;
  deletionController: BackupDeletionAuthorizationController | null;
  /**
   * AR-01：受保护存储策略（必填）。普通工具在真实执行文件操作前必须
   * 调用 assertGenericToolAccessAllowed，列目录时过滤受保护条目。
   */
  protectedStoragePolicy: ProtectedStoragePolicy;
}

export const BUILTIN_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "readFile",
    summary: "读取工作区内文件内容",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
  },
  {
    name: "listDirectory",
    summary: "列出工作区内目录条目",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: { type: "object", properties: { directoryPath: { type: "string" } } },
  },
  {
    name: "writeFileTemporary",
    summary: "仅新建工作区临时目录文件；目标已存在时拒绝（受限）",
    category: "restricted",
    mutationKind: "create-only",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["doc", "code", "data"],
    inputSchema: {
      type: "object",
      properties: {
        fileName: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "replaceFileContent",
    summary: "覆盖工作区内文件内容（破坏性；变更前自动备份完整 pre-image）",
    category: "restricted",
    mutationKind: "overwrite",
    backupPolicy: "automatic-preimage",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["doc", "code", "data"],
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "backupVault",
    summary: "受控备份库：列出/读取/恢复自动备份（恢复受标准门禁约束）",
    category: "restricted",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "backup-vault-action",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "restore"] },
        backupIdentifier: { type: "string" },
      },
    },
  },
  {
    name: "deleteBackup",
    summary: "特权删除备份（两阶段隔离+清除；协同模式需逐次授权，放权模式记录 HIGH 审计）",
    category: "restricted",
    mutationKind: "delete-protected-backup",
    backupPolicy: "protected-vault-deletion",
    authorizationPolicy: "backup-deletion",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {
      type: "object",
      properties: {
        backupIdentifiers: { type: "array", items: { type: "string" } },
      },
    },
  },
];

export async function executeBuiltinTool(
  toolName: string,
  argumentsJson: string,
  executionContext: BuiltinToolExecutionContext,
): Promise<{ outputText: string; isSideEffectFree: boolean }> {
  const args = JSON.parse(argumentsJson) as Record<string, unknown>;
  switch (toolName) {
    case "readFile": {
      const filePath = args["filePath"];
      if (typeof filePath !== "string") {
        throw new Error("readFile 参数 filePath 缺失或非法");
      }
      // 双层校验（AR-01）：预检 + 紧邻 IO 的复检，拦截"预检后目标被替换为链接"的 TOCTOU
      await resolveAndAssertAccess(executionContext, filePath, "read");
      const resolvedPath = await resolveAndAssertAccess(executionContext, filePath, "read");
      const content = await readFile(resolvedPath, "utf8");
      return { outputText: content, isSideEffectFree: true };
    }
    case "listDirectory": {
      const directoryPath = args["directoryPath"] ?? ".";
      if (typeof directoryPath !== "string") {
        throw new Error("listDirectory 参数 directoryPath 缺失或非法");
      }
      await resolveAndAssertAccess(executionContext, directoryPath, "list");
      const resolvedPath = await resolveAndAssertAccess(executionContext, directoryPath, "list");
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      // AR-01：列出受保护根的父目录时过滤受保护条目，不暴露物理布局
      const visibleEntries = entries
        .map((entry) => entry.name)
        .filter((entryName) =>
          executionContext.protectedStoragePolicy.filterProtectedEntries([entryName]).includes(entryName),
        );
      const renderedEntries = visibleEntries
        .map((entryName) => {
          const entry = entries.find((candidate) => candidate.name === entryName);
          return `${entry?.isDirectory() ? "d" : "-"} ${entryName}`;
        })
        .join("\n");
      return { outputText: renderedEntries, isSideEffectFree: true };
    }
    case "writeFileTemporary": {
      const fileName = args["fileName"];
      const content = args["content"];
      if (typeof fileName !== "string" || typeof content !== "string") {
        throw new Error("writeFileTemporary 参数 fileName/content 缺失或非法");
      }
      if (path.isAbsolute(fileName)) {
        throw new Error("writeFileTemporary 仅接受相对文件名");
      }
      const resolvedTargetPath = path.resolve(
        executionContext.temporaryDirectoryPath,
        fileName,
      );
      if (!isPathWithinDirectory(
        executionContext.temporaryDirectoryPath,
        resolvedTargetPath,
      )) {
        throw new Error("writeFileTemporary 拒绝穿越临时目录的文件名");
      }
      executionContext.protectedStoragePolicy.assertGenericToolAccessAllowed({
        canonicalTargetPath: resolvedTargetPath,
        operation: "create",
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(resolvedTargetPath, content, { encoding: "utf8", flag: "wx" });
      return {
        outputText: `已写入临时文件: ${fileName}`,
        isSideEffectFree: false,
      };
    }
    case "replaceFileContent": {
      const filePath = args["filePath"];
      const content = args["content"];
      if (typeof filePath !== "string" || typeof content !== "string") {
        throw new Error("replaceFileContent 参数 filePath/content 缺失或非法");
      }
      const resolvedPath =
        await executionContext.workspaceBoundary.resolveWithinWorkspace(filePath);
      executionContext.protectedStoragePolicy.assertGenericToolAccessAllowed({
        canonicalTargetPath: resolvedPath,
        operation: "replace",
      });
      await executionContext.workspaceBoundary.resolveWithinWorkspace(filePath);
      executionContext.protectedStoragePolicy.assertGenericToolAccessAllowed({
        canonicalTargetPath: resolvedPath,
        operation: "replace",
      });
      if (executionContext.backupServicePort === null) {
        throw new Error("replaceFileContent 缺少自动备份端口，拒绝执行破坏性变更");
      }
      // 变更前由工具自身自动保存完整 pre-image（不经过模型；备份 ID 不外泄给模型）
      const receipt = await executionContext.backupServicePort.createPreMutationBackup({
        toolName: "replaceFileContent",
        targetPath: resolvedPath,
        mutationKind: "overwrite",
      });
      // TOCTOU 闭环：写入前确认目标未被第三方修改，否则中止（审计 S3）
      const targetIsUnchanged =
        await executionContext.backupServicePort.verifyTargetUnchanged(
          resolvedPath,
          receipt.targetFingerprintBeforeMutation,
        );
      if (!targetIsUnchanged) {
        throw new Error(
          "replaceFileContent 中止：目标文件在备份后被修改（TOCTOU 防护）",
        );
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(resolvedPath, content, "utf8");
      return {
        outputText: `已覆盖 ${filePath}（变更前已自动备份，可经 backupVault 恢复）`,
        isSideEffectFree: false,
      };
    }
    case "backupVault": {
      return await executeBackupVaultAction(args, executionContext);
    }
    case "deleteBackup": {
      return await executeDeleteBackup(args, executionContext);
    }
    default:
      throw new Error(`未知内置工具: ${toolName}`);
  }
}

async function executeBackupVaultAction(
  args: Record<string, unknown>,
  executionContext: BuiltinToolExecutionContext,
): Promise<{ outputText: string; isSideEffectFree: boolean }> {
  const action = args["action"];
  if (action !== "list" && action !== "read" && action !== "restore") {
    throw new Error("backupVault 参数 action 必须为 list/read/restore");
  }
  if (executionContext.vault === null) {
    throw new Error("backupVault 不可用：备份库未初始化");
  }
  if (action === "list") {
    const entries = await executionContext.vault.listBackups(null);
    const rendered = entries
      .map(
        (entry) =>
          `${entry.backupIdentifier} ${entry.status} ${entry.toolName} → ${entry.targetPath}`,
      )
      .join("\n");
    return { outputText: rendered || "（无备份）", isSideEffectFree: true };
  }
  const backupIdentifier = args["backupIdentifier"];
  if (typeof backupIdentifier !== "string" || backupIdentifier.length === 0) {
    throw new Error("backupVault read/restore 需要 backupIdentifier");
  }
  if (action === "read") {
    const readResult = await executionContext.vault.readBackup(backupIdentifier);
    // AR-01：按显式编码返回内容（二进制以 base64，不按 UTF-8 损坏）
    return { outputText: readResult.content, isSideEffectFree: true };
  }
  const restored = await executionContext.vault.restoreBackup(backupIdentifier);
  return {
    outputText: `已恢复备份 ${backupIdentifier} → ${restored.restoredPath}`,
    isSideEffectFree: false,
  };
}

async function executeDeleteBackup(
  args: Record<string, unknown>,
  executionContext: BuiltinToolExecutionContext,
): Promise<{ outputText: string; isSideEffectFree: boolean }> {
  const backupIdentifiers = args["backupIdentifiers"];
  if (
    !Array.isArray(backupIdentifiers) ||
    backupIdentifiers.some((identifier) => typeof identifier !== "string") ||
    backupIdentifiers.length === 0
  ) {
    throw new Error("deleteBackup 参数 backupIdentifiers 必须为非空字符串数组");
  }
  if (executionContext.vault === null || executionContext.deletionController === null) {
    throw new Error("deleteBackup 不可用：备份库或授权控制器未初始化");
  }
  const identifiers = backupIdentifiers as string[];
  const warningText =
    `请求删除 ${identifiers.length} 个受保护备份（两阶段隔离+清除，不可恢复）。` +
    `涉及: ${identifiers.join(", ")}`;
  const expectedVaultRevision = executionContext.vault.getManifestRevision();

  const decision = await executionContext.deletionController.requestDeletionAuthorization({
    requestingAgentInstanceId: executionContext.requestingAgentInstanceId,
    toolCallId: `delete-backup-${Date.now()}`,
    backupIdentifiers: identifiers,
    warningText,
    expectedVaultRevision,
  });
  if (decision.decision !== "allow-once") {
    throw new Error("删除备份未获授权");
  }
  // 隔离前最终校验：授权绑定 revision 与当前清单 revision 必须一致（审计 S4）
  if (executionContext.vault.getManifestRevision() !== decision.expectedVaultRevision) {
    throw new Error(
      `备份库 revision 已变化（当前 ${executionContext.vault.getManifestRevision()}，授权绑定 ${decision.expectedVaultRevision}），删除中止`,
    );
  }
  const quarantined = await executionContext.vault.quarantineBackups(identifiers);
  await executionContext.deletionController.appendOutcomeAudit(
    executionContext.requestingAgentInstanceId,
    quarantined,
    "quarantined",
  );
  const purged = await executionContext.vault.purgeQuarantinedBackups(quarantined);
  await executionContext.deletionController.appendOutcomeAudit(
    executionContext.requestingAgentInstanceId,
    purged,
    "purged",
  );
  return {
    outputText: `已删除备份（隔离并清除）: ${purged.join(", ")}`,
    isSideEffectFree: false,
  };
}

function isPathWithinDirectory(directoryPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

/**
 * AR-01：解析工作区路径 + 受保护存储策略断言（一次访问检查）。
 * 配合 IO 前的第二次调用形成"预检 + 复检"，拦截目标在检查间隙被替换为链接的 TOCTOU。
 */
async function resolveAndAssertAccess(
  executionContext: BuiltinToolExecutionContext,
  requestedPath: string,
  operation: GenericToolFileOperation,
): Promise<string> {
  const resolvedPath =
    await executionContext.workspaceBoundary.resolveWithinWorkspace(requestedPath);
  executionContext.protectedStoragePolicy.assertGenericToolAccessAllowed({
    canonicalTargetPath: resolvedPath,
    operation,
  });
  return resolvedPath;
}
