/**
 * 受保护存储策略（AR-01）。
 * 将"工作区边界"与"受保护存储边界"分离：
 * 普通文件工具（readFile/listDirectory/writeFileTemporary/replaceFileContent 等）
 * 一律不得访问备份保管库与备份删除审计数据；受保护存储只能由备份服务
 * （进程内能力对象）与特权删除入口访问。
 *
 * 判定使用规范化路径组件（path.relative），不使用字符串前缀比较；
 * 目标路径须已由 WorkspaceBoundary 完成 realpath 逃逸校验（规范化后的绝对路径）。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";

export type GenericToolFileOperation =
  | "read"
  | "list"
  | "create"
  | "replace"
  | "delete";

export interface ProtectedStoragePaths {
  /** 备份保管库根目录（含 manifest、数据快照、暂存与隔离区）。 */
  backupVaultRootPath: string;
  /** 备份删除审计文件（哈希链日志）。 */
  backupDeletionAuditFilePath: string;
}

export interface ProtectedStoragePolicyOptions {
  stateDirectoryPath: string;
}

/**
 * 受保护存储策略。对普通工具的每个文件操作在真实执行前调用。
 * 受保护路径的判定基于规范化组件：
 * - 路径位于 backup-vault 根或其子路径 → 拒绝；
 * - 路径等于审计文件 → 拒绝；
 * - backup-vault 根自身 → 拒绝。
 */
export class ProtectedStoragePolicy {
  private readonly backupVaultRootPath: string;
  private readonly backupDeletionAuditFilePath: string;
  private readonly protectedStorageEntries = new Set<string>();

  constructor(options: ProtectedStoragePolicyOptions) {
    const stateDirectoryPath = path.resolve(options.stateDirectoryPath);
    this.backupVaultRootPath = path.join(stateDirectoryPath, "backup-vault");
    this.backupDeletionAuditFilePath = path.join(
      stateDirectoryPath,
      "backup-deletion-audit.jsonl",
    );
    this.protectedStorageEntries.add("backup-vault");
    this.protectedStorageEntries.add("backup-deletion-audit.jsonl");
  }

  getBackupVaultRootPath(): string {
    return this.backupVaultRootPath;
  }

  getBackupDeletionAuditFilePath(): string {
    return this.backupDeletionAuditFilePath;
  }

  /**
   * 普通工具文件操作前的强制检查；访问受保护存储统一拒绝。
   * canonicalTargetPath 必须是已规范化的绝对路径。
   */
  assertGenericToolAccessAllowed(input: {
    canonicalTargetPath: string;
    operation: GenericToolFileOperation;
  }): void {
    const canonicalPath = path.resolve(input.canonicalTargetPath);
    if (this.isProtectedPath(canonicalPath)) {
      throw new DomainError(
        "tool-permission-denied",
        `受保护存储不可由普通工具访问（${input.operation}）: ${canonicalPath}`,
      );
    }
  }

  /**
   * 普通工具列目录时过滤受保护条目，避免暴露物理布局。
   * directoryEntries 为 readdir 的条目名列表；返回过滤后的列表。
   */
  filterProtectedEntries(directoryEntries: string[]): string[] {
    return directoryEntries.filter(
      (entry) => !this.protectedStorageEntries.has(entry),
    );
  }

  /** 受保护路径判定：位于保管库根或其子路径、等于审计文件，或等于保管库根自身。 */
  isProtectedPath(canonicalPath: string): boolean {
    const normalizedPath = path.normalize(canonicalPath);
    if (isPathWithin(this.backupVaultRootPath, normalizedPath)) {
      return true;
    }
    return normalizedPath === this.backupDeletionAuditFilePath;
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
