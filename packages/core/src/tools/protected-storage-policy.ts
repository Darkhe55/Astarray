/**
 * 受保护存储策略（AR-01 / AR-01a）。
 * 将"工作区边界"与"受保护存储边界"分离：
 * 普通文件工具（readFile/listDirectory/writeFileTemporary/replaceFileContent 等）
 * 一律不得访问备份保管库与备份删除审计数据；受保护存储只能由备份服务
 * （进程内能力对象）与特权删除入口访问。
 *
 * 判定使用规范化路径组件（path.relative），不使用字符串前缀比较；
 * 目标路径须已由 WorkspaceBoundary 完成 realpath 逃逸校验（规范化后的绝对路径）。
 *
 * AR-01a 加固：
 * - 审计文件路径比较在 Windows（大小写不敏感文件系统）上不区分大小写。
 * - 词法判定之外增加真实路径（realpath/最近已存在祖先）比对，
 *   拦截"工作区内链接/联接指向备份保管库"的别名绕过。
 * - 目录条目过滤只作用于受保护根所在的状态目录，不在任意目录隐藏同名普通文件。
 */
import path from "node:path";
import { realpath } from "node:fs/promises";

import { DomainError } from "../core/errors.js";

export type GenericToolFileOperation =
  | "read"
  | "list"
  | "create"
  | "replace"
  | "delete";

export interface ProtectedStoragePolicyOptions {
  stateDirectoryPath: string;
}

/** Windows 文件系统大小写不敏感；POSIX 大小写敏感（不同大小写即不同文件）。 */
function isCaseInsensitiveFileSystem(): boolean {
  return process.platform === "win32";
}

function normalizeForComparison(targetPath: string): string {
  const normalizedPath = path.normalize(targetPath);
  if (isCaseInsensitiveFileSystem()) {
    return normalizedPath.toLowerCase();
  }
  return normalizedPath;
}

/**
 * 受保护存储策略。对普通工具的每个文件操作在真实执行前调用。
 * 受保护路径判定基于规范化组件：
 * - 路径位于 backup-vault 根或其子路径 → 拒绝；
 * - 路径等于审计文件（Windows 大小写不敏感）→ 拒绝；
 * - backup-vault 根自身 → 拒绝；
 * - 真实路径（realpath）同样落入上述任意区域 → 拒绝（拦截链接/联接别名）。
 */
export class ProtectedStoragePolicy {
  private readonly stateDirectoryPath: string;
  private readonly backupVaultRootPath: string;
  private readonly backupDeletionAuditFilePath: string;
  private readonly protectedStorageEntries = new Set<string>();

  constructor(options: ProtectedStoragePolicyOptions) {
    this.stateDirectoryPath = path.resolve(options.stateDirectoryPath);
    this.backupVaultRootPath = path.join(this.stateDirectoryPath, "backup-vault");
    this.backupDeletionAuditFilePath = path.join(
      this.stateDirectoryPath,
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
   * 普通工具文件操作前的强制检查；访问受保护存储统一拒绝（AR-01a 为异步：
   * 需解析真实路径以拦截链接/联接别名）。canonicalTargetPath 必须是已规范化的绝对路径。
   */
  async assertGenericToolAccessAllowed(input: {
    canonicalTargetPath: string;
    operation: GenericToolFileOperation;
  }): Promise<void> {
    const canonicalPath = path.resolve(input.canonicalTargetPath);
    if (this.isProtectedPath(canonicalPath)) {
      throw new DomainError(
        "tool-permission-denied",
        `受保护存储不可由普通工具访问（${input.operation}）: ${canonicalPath}`,
      );
    }
    // AR-01a：真实路径比对——工作区内链接/联接指向保管库时，词法路径在保护区内之外，
    // 但 realpath 解析出的真实目标在保护区内。
    const realTargetPath = await this.resolveRealPath(canonicalPath);
    if (this.isProtectedPath(realTargetPath)) {
      throw new DomainError(
        "tool-permission-denied",
        `受保护存储不可经链接/联接别名访问（${input.operation}）: ${canonicalPath}`,
      );
    }
  }

  /**
   * 普通工具列目录时过滤受保护条目（AR-01a：仅当目录是受保护根所在的状态目录时过滤，
   * 不在任意目录隐藏同名普通文件）。
   * directoryEntries 为 readdir 的条目名列表；返回过滤后的列表。
   */
  filterProtectedEntries(
    directoryCanonicalPath: string,
    directoryEntries: string[],
  ): string[] {
    if (!this.isStateDirectory(directoryCanonicalPath)) {
      return directoryEntries;
    }
    return directoryEntries.filter(
      (entry) => !this.protectedStorageEntries.has(entry),
    );
  }

  /** 受保护路径词法判定（同步；供快速拒绝与单元测试）。 */
  isProtectedPath(canonicalPath: string): boolean {
    const normalizedPath = path.normalize(canonicalPath);
    if (isPathWithin(this.backupVaultRootPath, normalizedPath)) {
      return true;
    }
    return (
      normalizeForComparison(normalizedPath) ===
      normalizeForComparison(this.backupDeletionAuditFilePath)
    );
  }

  private isStateDirectory(canonicalPath: string): boolean {
    const normalizedPath = path.normalize(canonicalPath);
    return (
      normalizeForComparison(normalizedPath) ===
      normalizeForComparison(this.stateDirectoryPath)
    );
  }

  /**
   * 解析真实路径（AR-01a fail-closed，确定性）：
   * 1) 目标存在则直接 realpath；
   * 2) 目标不存在时，用 stat（跟随链接的存在性检测）定位最近已存在祖先，
   *    再 lstat 检测 canonicalPath 到祖先之间（含祖先）的链接段：
   *    - 存在链接段且 realpath 无法解析 → 无法证明安全 → 拒绝；
   *    - 无链接段 → 用祖先 realpath + 剩余相对路径拼接。
   * 用 stat/lstat 而非 realpath 做存在性检测，避免 junction 对 realpath 的
   * 平台/时序差异导致别名放行。
   */
  private async resolveRealPath(canonicalPath: string): Promise<string> {
    try {
      return await realpath(canonicalPath);
    } catch {
      const anchorPath = await findNearestExistingAncestor(canonicalPath);
      if (anchorPath === null) {
        return canonicalPath;
      }
      const linkSegments = await collectLinkSegments(canonicalPath);
      if (linkSegments.length > 0) {
        throw new DomainError(
          "tool-permission-denied",
          `目标路径包含无法安全解析的链接/联接（${linkSegments.join(", ")}），拒绝访问`,
        );
      }
      try {
        const realAnchorPath = await realpath(anchorPath);
        const relativeRemainder = path.relative(anchorPath, canonicalPath);
        return path.join(realAnchorPath, relativeRemainder);
      } catch {
        // 无链接且祖先 realpath 失败（平台瞬时抖动）：回退词法路径，
        // 由词法保护区判定兜底（无链接即无别名风险）。
        return canonicalPath;
      }
    }
  }
}

/**
 * 定位最近已存在祖先（存在性检测，跟随链接）。
 * 用 fs.stat（跟随符号链接/联接）而非 realpath，保证 junction 场景下
 * 别名自身会被识别为"存在"，从而被后续 lstat 链接检测覆盖。
 */
async function findNearestExistingAncestor(
  targetPath: string,
): Promise<string | null> {
  const { stat } = await import("node:fs/promises");
  let currentPath = targetPath;
  while (true) {
    try {
      await stat(currentPath);
      return currentPath;
    } catch {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  }
}

/**
 * 收集 canonicalPath 到文件系统根之间所有符号链接/联接段（lstat）。
 * 遍历整条路径链，确保祖先中的链接（如工作区内指向保管库的别名）也会被检出。
 */
async function collectLinkSegments(canonicalPath: string): Promise<string[]> {
  const { lstat } = await import("node:fs/promises");
  const linkSegments: string[] = [];
  let currentPath = canonicalPath;
  while (true) {
    try {
      const linkStat = await lstat(currentPath);
      if (linkStat.isSymbolicLink()) {
        linkSegments.push(currentPath);
      }
    } catch {
      // 路径段不存在（含 Windows junction 对 lstat 返回 ENOENT 的平台局限）：
      // 继续向上；真实路径判定由 realpath 成功分支兜底
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }
  return linkSegments;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  // AR-01a：realpath 返回的路径大小写可能与保护区根不同（Windows 大小写不敏感），
  // 比较前统一规范化（normalize + 平台大小写折叠），避免 path.relative 字符比较误判。
  const normalizedRootPath = normalizeForComparison(rootPath);
  const normalizedCandidatePath = normalizeForComparison(candidatePath);
  const relativePath = path.relative(
    normalizedRootPath,
    normalizedCandidatePath,
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
