/**
 * 工作区边界（T06/T12）。
 * 拒绝路径穿越（../ 逃逸）与符号链接逃逸；路径解析后必须位于工作区内。
 * 目标不存在时对最近存在的祖先目录做 realpath 校验。
 */
import path from "node:path";
import { realpath } from "node:fs/promises";

import { DomainError } from "../core/errors.js";
import { hasWindowsStyleAbsolutePathPrefix } from "./cross-platform-path-canonicalization.js";

export class WorkspaceBoundary {
  private readonly workspaceRootPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRootPath = path.resolve(workspaceRoot);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRootPath;
  }

  /**
   * 将请求路径解析为工作区内绝对路径；任何逃逸尝试抛
   * DomainError（path-escape-attempt）。
   */
  async resolveWithinWorkspace(requestedPath: string): Promise<string> {
    // LINUX-PORT-01：盘符/UNC 前缀在任何平台都是绝对路径。POSIX 上若不显式拒绝，
    // path.resolve 会把它当作普通相对名并"留在工作区内"，判定结果随平台改变。
    // 宿主已认定为绝对路径时仍交给下面的包含性判定（Windows 上工作区内绝对路径必须可用）。
    if (
      !path.isAbsolute(requestedPath) &&
      hasWindowsStyleAbsolutePathPrefix(requestedPath)
    ) {
      throw new DomainError(
        "path-escape-attempt",
        `跨平台绝对路径被拒绝: ${requestedPath}`,
      );
    }
    const resolvedPath = path.resolve(this.workspaceRootPath, requestedPath);
    if (!isPathWithin(this.workspaceRootPath, resolvedPath)) {
      throw new DomainError(
        "path-escape-attempt",
        `路径逃逸工作区被拒绝: ${requestedPath}`,
      );
    }
    await this.assertNoSymlinkEscape(resolvedPath);
    return resolvedPath;
  }

  private async assertNoSymlinkEscape(resolvedPath: string): Promise<void> {
    const anchorPath = await findNearestExistingAncestor(resolvedPath);
    if (anchorPath === null) {
      return;
    }
    const realAnchorPath = await realpath(anchorPath);
    if (!isPathWithin(this.workspaceRootPath, realAnchorPath)) {
      throw new DomainError(
        "path-escape-attempt",
        `符号链接逃逸工作区被拒绝: ${resolvedPath}`,
      );
    }
  }
}

function isPathWithin(workspaceRootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(workspaceRootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function findNearestExistingAncestor(
  targetPath: string,
): Promise<string | null> {
  let currentPath = targetPath;
  while (true) {
    try {
      await realpath(currentPath);
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
