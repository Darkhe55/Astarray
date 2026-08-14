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
import type { TaskSequenceStatusController } from "../orchestration/task-sequence-controllers.js";
import type { LocalToolPolicyEngine } from "./local-tool-policy-engine.js";
import type { SensitiveContentAccessPolicy } from "./sensitive-content-access-policy.js";
import type { ReadSuppressionLedger } from "./read-suppression-ledger.js";

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
  /**
   * T05C：任务序列状态控制面（只读工具注入；未装配时调用报错）。
   * 调用者身份由 harness 注入（requestingAgentInstanceId），模型无法填写
   * 他人 ID 获得他人视图。
   */
  taskSequenceStatusController?: TaskSequenceStatusController | null;
  /**
   * T06B：Ponder 本地只读边界（Ponder 专属工具注入；未装配时调用报错）。
   */
  localToolPolicyEngine?: LocalToolPolicyEngine | null;
  /** T06B：Ponder 只读 git 视图的工作仓库目录（通常为工作区根）。 */
  ponderGitRepositoryPath?: string | null;
  /**
   * T06C：全模式敏感内容禁读策略（所有模式、所有读通道执行前检查；
   * 未装配时跳过策略——由装配方保证注入）。
   */
  sensitiveContentAccessPolicy?: SensitiveContentAccessPolicy | null;
  /**
   * T07B：反自指读取账本（同源重复读取未变化内容时抑制；
   * 敏感内容禁读优先于时间锁）。
   */
  readSuppressionLedger?: ReadSuppressionLedger | null;
  /** T07B：任务执行标识（与 agentInstanceId 共同构成读取来源键）。 */
  taskExecutionId?: string | null;
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
  {
    name: "taskSequenceStatus",
    summary: "只读查看本 Agent 待办任务序列快照（ready set/顺序解释/任务包状态）",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {
      type: "object",
      properties: { sequenceId: { type: "string" } },
    },
  },
  {
    name: "searchProjectText",
    summary: "在工作区内检索文本（Ponder 只读；固定参数，不经 shell）",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
    },
  },
  {
    name: "gitReadonlyView",
    summary: "只读 Git 视图（status/diff/log；固定参数，不经 shell，无写入）",
    category: "readonly",
    mutationKind: "none",
    backupPolicy: "not-required",
    authorizationPolicy: "standard",
    supportedTaskTypes: ["data", "doc", "code"],
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["status", "diff", "log"] },
        limit: { type: "number" },
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
      // T06C：全模式敏感内容禁读（读取前 + 内容 DLP 双检）——优先于时间锁
      await assertSensitiveContentAllowed(executionContext, resolvedPath, null);
      // T07B：反自指读取时间锁（同源窗口内未变化 → resource-already-read）
      await assertNotAlreadyRead(executionContext, resolvedPath, "read");
      const content = await readFile(resolvedPath, "utf8");
      await assertSensitiveContentAllowed(executionContext, resolvedPath, content);
      // 登记读取（内容指纹供未变化判定）
      await registerReadForSuppression(
        executionContext,
        resolvedPath,
        "read",
        content,
      );
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
      // AR-01/AR-01a：仅当目录是受保护根所在的状态目录时过滤受保护条目
      let visibleEntries = entries
        .map((entry) => entry.name)
        .filter((entryName) =>
          executionContext.protectedStoragePolicy
            .filterProtectedEntries(resolvedPath, [entryName])
            .includes(entryName),
        );
      // T06C：过滤敏感条目（.env/凭据/私钥等），不泄露敏感名称
      const sensitivePolicy = executionContext.sensitiveContentAccessPolicy;
      if (sensitivePolicy !== null && sensitivePolicy !== undefined) {
        visibleEntries = sensitivePolicy.filterSensitiveDirectoryEntries(
          resolvedPath,
          visibleEntries,
        );
      }
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
      await resolveAndAssertAccess(executionContext, filePath, "replace");
      // AR-01a：紧邻 IO 的复检，复检结果（而非第一次解析结果）用于后续全部操作
      const resolvedPath = await resolveAndAssertAccess(executionContext, filePath, "replace");
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
    case "taskSequenceStatus": {
      const sequenceId = args["sequenceId"];
      if (typeof sequenceId !== "string") {
        throw new Error("taskSequenceStatus 参数 sequenceId 缺失或非法");
      }
      // 身份由 harness 注入：Agent 只能查看自己的序列（owner = 当前 Agent 实例）。
      const statusController = executionContext.taskSequenceStatusController;
      if (statusController === null || statusController === undefined) {
        throw new Error("taskSequenceStatus 控制面未装配");
      }
      const snapshot = await statusController.getSnapshot({
        ownerAgentInstanceId: executionContext.requestingAgentInstanceId,
        sequenceId,
        viewer: {
          sourceKind: "agent",
          actorId: executionContext.requestingAgentInstanceId,
        },
      });
      return {
        outputText: JSON.stringify(snapshot),
        isSideEffectFree: true,
      };
    }
    case "searchProjectText": {
      const pattern = args["pattern"];
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error("searchProjectText 参数 pattern 缺失或非法");
      }
      const localEngine = executionContext.localToolPolicyEngine;
      if (localEngine === null || localEngine === undefined) {
        throw new Error("searchProjectText 本地策略引擎未装配");
      }
      // 实际执行前再次校验（fail-closed 双时点）
      await localEngine.assertPonderToolExecutionAllowed({
        toolName: "searchProjectText",
        descriptor: BUILTIN_TOOL_DESCRIPTORS.find(
          (descriptor) => descriptor.name === "searchProjectText",
        )!,
        argumentsJson,
      });
      const matches = await searchProjectText(
        executionContext.workspaceBoundary.getWorkspaceRoot(),
        pattern,
        localEngine,
        executionContext.sensitiveContentAccessPolicy ?? null,
      );
      return { outputText: matches, isSideEffectFree: true };
    }
    case "gitReadonlyView": {
      const localEngine = executionContext.localToolPolicyEngine;
      if (localEngine === null || localEngine === undefined) {
        throw new Error("gitReadonlyView 本地策略引擎未装配");
      }
      await localEngine.assertPonderToolExecutionAllowed({
        toolName: "gitReadonlyView",
        descriptor: BUILTIN_TOOL_DESCRIPTORS.find(
          (descriptor) => descriptor.name === "gitReadonlyView",
        )!,
        argumentsJson,
      });
      const parsed = localEngine.parsePonderGitReadonlyArguments(args);
      if (parsed === null) {
        throw new Error("gitReadonlyView 参数非法");
      }
      const repositoryPath =
        executionContext.ponderGitRepositoryPath ??
        executionContext.workspaceBoundary.getWorkspaceRoot();
      const gitArguments = localEngine.buildPonderGitReadonlyArguments(
        parsed.view,
        parsed.logLimit,
      );
      const { GitProcess } = await import("../orchestration/git-process.js");
      const gitProcess = new GitProcess({ gitCommandTimeoutSeconds: 30 });
      const result = await gitProcess.run(
        repositoryPath,
        gitArguments,
        `Ponder 只读 git 视图 ${parsed.view}`,
      );
      const outputText =
        result.stdoutText.trim() === "" ? "（无输出）" : result.stdoutText;
      // T06C：git 视图输出做 DLP 扫描（固定视图无正文，防御未来视图扩展）
      const sensitivePolicy = executionContext.sensitiveContentAccessPolicy;
      if (sensitivePolicy !== null && sensitivePolicy !== undefined) {
        await sensitivePolicy.assertSensitiveContentReadAllowed({
          canonicalPath: repositoryPath,
          content: outputText,
        });
      }
      return { outputText, isSideEffectFree: true };
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
    // AR-01a：输出携带显式编码与媒体类型，调用者可区分普通文本与 base64 二进制
    const outputText =
      `[encoding: ${readResult.encoding}, media-type: ${readResult.mediaType}]\n${readResult.content}`;
    // T06C：备份恢复的 pre-image 可能是敏感文件（如 .env 的备份）——内容 DLP 扫描
    await assertSensitiveContentAllowed(executionContext, backupIdentifier, outputText);
    return { outputText, isSideEffectFree: true };
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
  await executionContext.protectedStoragePolicy.assertGenericToolAccessAllowed({
    canonicalTargetPath: resolvedPath,
    operation,
  });
  return resolvedPath;
}

/**
 * T06C：全模式敏感内容禁读检查（路径身份 + 可选内容 DLP）。
 * 未装配策略时放行（装配方负责注入）；命中抛 sensitive-content-read-denied。
 */
async function assertSensitiveContentAllowed(
  executionContext: BuiltinToolExecutionContext,
  canonicalPath: string,
  content: string | null,
): Promise<void> {
  const sensitivePolicy = executionContext.sensitiveContentAccessPolicy;
  if (sensitivePolicy === null || sensitivePolicy === undefined) {
    return;
  }
  await sensitivePolicy.assertSensitiveContentReadAllowed({
    canonicalPath,
    content: content ?? undefined,
  });
}

/**
 * T07B：反自指读取时间锁——窗口内同源重复读取未变化内容 → 拒绝正文。
 * 敏感禁读优先：调用方须先执行 assertSensitiveContentAllowed。
 */
async function assertNotAlreadyRead(
  executionContext: BuiltinToolExecutionContext,
  canonicalPath: string,
  operationKind: "read" | "list" | "search",
): Promise<void> {
  const ledger = executionContext.readSuppressionLedger;
  if (ledger === null || ledger === undefined) {
    return;
  }
  const { buildReadParameterHash } = await import("./read-suppression-ledger.js");
  const { buildReadSuppressionDenial } = await import("./read-suppression-ledger.js");
  const decision = await ledger.querySuppression({
    agentInstanceId: executionContext.requestingAgentInstanceId,
    taskExecutionId: executionContext.taskExecutionId ?? null,
    canonicalPath,
    operationKind,
    normalizedRange: "full",
    parameterHash: buildReadParameterHash(canonicalPath),
  });
  if (decision.isSuppressed) {
    throw buildReadSuppressionDenial({
      readReceiptId: decision.readReceiptId!,
      firstReadAtUnixMilliseconds: decision.firstReadAtUnixMilliseconds!,
      retryAfterMilliseconds: decision.retryAfterMilliseconds,
    });
  }
}

/** T07B：登记一次成功读取（内容指纹供未变化判定）。 */
async function registerReadForSuppression(
  executionContext: BuiltinToolExecutionContext,
  canonicalPath: string,
  operationKind: "read" | "list" | "search",
  content: string,
): Promise<void> {
  const ledger = executionContext.readSuppressionLedger;
  if (ledger === null || ledger === undefined) {
    return;
  }
  const { createHash } = await import("node:crypto");
  const { buildReadParameterHash } = await import("./read-suppression-ledger.js");
  await ledger.registerRead({
    agentInstanceId: executionContext.requestingAgentInstanceId,
    taskExecutionId: executionContext.taskExecutionId ?? null,
    canonicalPath,
    operationKind,
    normalizedRange: "full",
    parameterHash: buildReadParameterHash(canonicalPath),
    contentFingerprint: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  });
}

/**
 * T06B：Ponder 只读文本检索（不经 shell）。
 * 递归遍历工作区普通文件，逐文件经本地策略引擎校验后以只读方式搜索；
 * 跳过受保护/敏感路径与二进制文件，限制最大文件数与行数（有界）。
 */
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

async function searchProjectText(
  workspaceRootPath: string,
  pattern: string,
  localEngine: LocalToolPolicyEngine,
  sensitiveContentPolicy: SensitiveContentAccessPolicy | null,
): Promise<string> {
  const { readdir, readFile, access } = await import("node:fs/promises");
  const skipDirectories = new Set([
    "node_modules",
    ".git",
    "dist",
    ".astarray",
    "temp",
  ]);
  const results: string[] = [];
  let fileCount = 0;

  const visit = async (directoryPath: string): Promise<void> => {
    if (results.length >= MAX_SEARCH_RESULTS || fileCount >= MAX_SEARCH_FILES) {
      return;
    }
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || fileCount >= MAX_SEARCH_FILES) {
        return;
      }
      if (skipDirectories.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      try {
        await access(entryPath);
      } catch {
        continue;
      }
      // T06C：敏感文件名/路径直接跳过（不读取、不返回）
      if (
        sensitiveContentPolicy !== null &&
        sensitiveContentPolicy.matchSensitivePathName(entryPath) !== null
      ) {
        continue;
      }
      let resolvedPath: string;
      try {
        resolvedPath = await localEngine.assertPonderReadonlyFilePath(entryPath);
      } catch {
        continue; // 敏感路径/受保护区：跳过该文件，不中断检索
      }
      fileCount += 1;
      const fileStat = await import("node:fs/promises").then((fsModule) =>
        fsModule.stat(resolvedPath),
      );
      if (fileStat.size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(resolvedPath, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) {
        continue; // 二进制文件
      }
      // T06C：名称正常但内容疑似凭据 → 丢弃整行结果
      const lines = content.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!;
        if (line.includes(pattern)) {
          const relativePath = path.relative(workspaceRootPath, entryPath);
          results.push(`${relativePath}:${lineIndex + 1}:${line.slice(0, 200)}`);
          if (results.length >= MAX_SEARCH_RESULTS) {
            return;
          }
        }
      }
    }
  };

  await visit(workspaceRootPath);
  return results.length === 0
    ? "（未找到匹配）"
    : results.join("\n");
}
