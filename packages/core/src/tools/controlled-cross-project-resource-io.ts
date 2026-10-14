/**
 * PROJECT-01-03（2026-10-30）：**受控的**跨项目资源 I/O 端口。
 *
 * ## 为什么需要它（卡内点名的缺口，2026-10-29 复查仍成立）
 *
 * `CrossProjectResourceIoPort` 此前**只有 CLI 的裸 `fs` 实现**
 * （`buildLocalResourceIoPort()`，注释自述"不引入核心包依赖"）⇒
 * `AstarrayApplicationFacade.create()` 的 `crossProjectResourceIo` 在 **SDK/GUI 路径恒为 `null`**
 * ⇒ 跨项目导入只能走 fail-closed 的 `cross-project-resource-io-unavailable`。
 *
 * 而**直接把 CLI 的裸端口搬进来是错的**：那等于"拿到绝对路径就能读写"，
 * 与 AGENTS.md"**权限在工具实际执行前检查**"和受保护存储禁令直接冲突。
 *
 * ## 本模块做什么
 *
 * 提供一个**受控**端口：**每一次**读写/建目录/存在性检查前，
 * 都必须先过两道本地确定性闸门：
 *  1. **工作区边界**（`WorkspaceBoundary.resolveWithinWorkspace`）——
 *     越界路径（`..` 逃逸、绝对路径指向工作区外）**拒绝**；
 *  2. **受保护存储禁令**（`ProtectedStoragePolicy.assertGenericToolAccessAllowed`）——
 *     保管库/删除审计等**拒绝**，且**词法与 realpath 双重比对**（防工作区内链接指向保管库）。
 *
 * 不做"先读后判"：**先判再读**，拒绝时**不触达资源**。
 */
import { promises as fs } from "node:fs";

import type { CrossProjectResourceIoPort } from "../orchestration/cross-project-authorization-store.js";
import type { GenericToolFileOperation } from "./protected-storage-policy.js";
import type { ProtectedStoragePolicy } from "./protected-storage-policy.js";
import type { WorkspaceBoundary } from "./workspace-boundary.js";

export interface ControlledCrossProjectResourceIoOptions {
  /** 目标项目工作区边界（所有路径必须落在其内）。 */
  workspaceBoundary: WorkspaceBoundary;
  /** 受保护存储策略（保管库/审计文件等一律拒绝）。 */
  protectedStoragePolicy: ProtectedStoragePolicy;
}

/**
 * 受控跨项目资源端口。
 *
 * 每个操作都遵循同一顺序：**解析到工作区内 → 过受保护存储判定 → 才触达磁盘**。
 * 任一步拒绝即抛错，**绝不"先读了再判"**。
 */
export class ControlledCrossProjectResourceIo implements CrossProjectResourceIoPort {
  private readonly workspaceBoundary: WorkspaceBoundary;
  private readonly protectedStoragePolicy: ProtectedStoragePolicy;

  constructor(options: ControlledCrossProjectResourceIoOptions) {
    this.workspaceBoundary = options.workspaceBoundary;
    this.protectedStoragePolicy = options.protectedStoragePolicy;
  }

  /**
   * 两道闸门合一的授权解析：**返回可用于磁盘访问的规范路径**。
   * 越界或命中受保护存储 ⇒ 抛错（DomainError），调用方不得继续。
   */
  private async authorizePath(
    absolutePath: string,
    operation: GenericToolFileOperation,
  ): Promise<string> {
    // ① 工作区边界：越界直接拒绝（不触达磁盘）
    const resolvedWithinWorkspace =
      await this.workspaceBoundary.resolveWithinWorkspace(absolutePath);
    // ② 受保护存储：词法 + realpath 双重比对
    await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
      canonicalTargetPath: resolvedWithinWorkspace,
      operation,
    });
    return resolvedWithinWorkspace;
  }

  async readTextFile(absolutePath: string): Promise<string> {
    const authorizedPath = await this.authorizePath(absolutePath, "read");
    return await fs.readFile(authorizedPath, "utf8");
  }

  async writeTextFile(absolutePath: string, content: string): Promise<void> {
    const authorizedPath = await this.authorizePath(absolutePath, "replace");
    await fs.mkdir(pathDirname(authorizedPath), { recursive: true });
    await fs.writeFile(authorizedPath, content, "utf8");
  }

  async ensureDirectory(absoluteDirectoryPath: string): Promise<void> {
    const authorizedPath = await this.authorizePath(absoluteDirectoryPath, "create");
    await fs.mkdir(authorizedPath, { recursive: true });
  }

  async fileExists(absolutePath: string): Promise<boolean> {
    const authorizedPath = await this.authorizePath(absolutePath, "read");
    try {
      await fs.access(authorizedPath);
      return true;
    } catch {
      return false;
    }
  }
}

/** 仅在已授权的规范路径上取父目录（避免再引入一次未授权路径运算）。 */
function pathDirname(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separatorIndex <= 0 ? filePath : filePath.slice(0, separatorIndex);
}
