/**
 * 跨平台路径规范化（LINUX-PORT-01）。
 *
 * 目标：安全判定（工作区边界、受保护存储、敏感内容、读取时间锁）在任何宿主平台上
 * 对同一路径字符串得出同一结论，并且"判定所用的规范路径"与"实际文件访问所用的路径"
 * 保持一致（实际访问始终用宿主原生绝对路径，只在本模块做比较用规范化）。
 *
 * 规则：
 * - 盘符（`C:`）与 UNC（`\\\\server`）前缀在任何平台都视为绝对路径；
 * - 反斜杠与正斜杠都视为分隔符（仅用于比较与身份键，不用于实际访问）；
 * - `.`/`..` 段按词法解析，不访问文件系统；
 * - 大小写折叠只在文件系统确实不区分大小写时生效：POSIX 默认不折叠，
 *   需要时用 detectFileSystemCaseSensitivity 探测实际能力（不按平台猜测）。
 */
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import path from "node:path";

export type FileSystemCaseSensitivity = "case-sensitive" | "case-insensitive";

/** 盘符前缀（含 `C:relative` 形式，fail-closed 一并视为绝对路径）。 */
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;
/** UNC 前缀：两个分隔符开头且后接非分隔符。 */
const WINDOWS_UNC_PREFIX_PATTERN = /^[\\/]{2}[^\\/]/;

export function hasWindowsStyleAbsolutePathPrefix(
  requestedPath: string,
): boolean {
  return (
    WINDOWS_DRIVE_PREFIX_PATTERN.test(requestedPath) ||
    WINDOWS_UNC_PREFIX_PATTERN.test(requestedPath)
  );
}

/** 跨平台绝对路径判定：宿主绝对路径或 Windows 风格绝对路径。 */
export function isAbsoluteOnAllPlatforms(requestedPath: string): boolean {
  return (
    path.isAbsolute(requestedPath) ||
    hasWindowsStyleAbsolutePathPrefix(requestedPath)
  );
}

/** 分隔符统一（仅用于比较/身份键，不用于实际文件访问）。 */
export function unifyPathSeparators(targetPath: string): string {
  return targetPath.replace(/\\/g, "/");
}

/** 平台默认大小写能力（探测不可用时的回退值）。 */
export function platformDefaultCaseSensitivity(): FileSystemCaseSensitivity {
  return process.platform === "win32" ? "case-insensitive" : "case-sensitive";
}

/**
 * 词法规范化：分隔符统一 + `.`/`..` 解析 + 尾部分隔符移除，保留盘符/UNC/根前缀。
 * 不访问文件系统，也不使用宿主 `path.resolve`（否则 Windows 风格路径在 POSIX 上
 * 会被改写为当前目录下的相对路径，导致判定与实际访问分叉）。
 */
export function canonicalizePathForPolicyComparison(
  targetPath: string,
  caseSensitivity: FileSystemCaseSensitivity = platformDefaultCaseSensitivity(),
): string {
  const unifiedPath = unifyPathSeparators(targetPath);
  const prefixLength = resolvePathPrefixLength(unifiedPath);
  const prefix = unifiedPath.slice(0, prefixLength);
  const pathSegments = resolveLexicalPathSegments(
    unifiedPath.slice(prefixLength),
    prefixLength === 0,
  );
  const canonicalPath =
    pathSegments.length === 0
      ? prefix === ""
        ? "."
        : prefix
      : `${prefix}${pathSegments.join("/")}`;
  return caseSensitivity === "case-insensitive"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
}

/** 规范路径包含关系（按段边界，避免 `/a/b` 误判 `/a/bc`）。 */
export function isCanonicalPathWithin(
  canonicalRootPath: string,
  canonicalCandidatePath: string,
): boolean {
  if (canonicalCandidatePath === canonicalRootPath) {
    return true;
  }
  const rootPrefix = canonicalRootPath.endsWith("/")
    ? canonicalRootPath
    : `${canonicalRootPath}/`;
  return canonicalCandidatePath.startsWith(rootPrefix);
}

export function classifyFileSystemCaseSensitivity(
  isSwappedCasePathResolvable: boolean,
): FileSystemCaseSensitivity {
  return isSwappedCasePathResolvable ? "case-insensitive" : "case-sensitive";
}

/** 探测所需的文件系统操作（可注入，保证探测分支可确定性测试）。 */
export interface CaseSensitivityProbeOperations {
  createProbeDirectory(probeParentDirectoryPath: string): Promise<string>;
  doesCaseSwappedPathExist(probeDirectoryPath: string): Promise<boolean>;
  removeProbeDirectory(probeDirectoryPath: string): Promise<void>;
}

/** 前缀含大小写字母，保证交换大小写后必与原路径不同。 */
const PROBE_DIRECTORY_PREFIX = "astarray-CaseProbe-";

export const defaultCaseSensitivityProbeOperations: CaseSensitivityProbeOperations =
  {
    createProbeDirectory: async (probeParentDirectoryPath) =>
      mkdtemp(path.join(probeParentDirectoryPath, PROBE_DIRECTORY_PREFIX)),
    doesCaseSwappedPathExist: async (probeDirectoryPath) => {
      const swappedCasePath = path.join(
        path.dirname(probeDirectoryPath),
        swapPathSegmentCase(path.basename(probeDirectoryPath)),
      );
      try {
        await stat(swappedCasePath);
        return true;
      } catch {
        return false;
      }
    },
    // 只删除刚创建的空探测目录：不使用递归删除，不触碰用户内容，也不使用 writeFile
    removeProbeDirectory: async (probeDirectoryPath) => {
      await rmdir(probeDirectoryPath);
    },
  };

/**
 * 探测目标目录所在文件系统是否区分大小写。
 * 探测失败（目录不可创建/不可读等）一律回退平台默认值，绝不假定"不敏感"：
 * 误判为不敏感会过度拒绝，误判为敏感会留下保护缺口，故失败时保守回退。
 */
export async function detectFileSystemCaseSensitivity(
  probeParentDirectoryPath: string,
  operations: CaseSensitivityProbeOperations = defaultCaseSensitivityProbeOperations,
): Promise<FileSystemCaseSensitivity> {
  let probeDirectoryPath: string;
  try {
    probeDirectoryPath = await operations.createProbeDirectory(
      probeParentDirectoryPath,
    );
  } catch {
    return platformDefaultCaseSensitivity();
  }
  try {
    const isSwappedCasePathResolvable =
      await operations.doesCaseSwappedPathExist(probeDirectoryPath);
    return classifyFileSystemCaseSensitivity(isSwappedCasePathResolvable);
  } catch {
    return platformDefaultCaseSensitivity();
  } finally {
    await operations.removeProbeDirectory(probeDirectoryPath).catch(() => {});
  }
}

/** 反转路径段中字母的大小写（用于探测文件系统是否区分大小写）。 */
function swapPathSegmentCase(pathSegment: string): string {
  return pathSegment.replace(/[A-Za-z]/g, (letter) =>
    letter === letter.toLowerCase()
      ? letter.toUpperCase()
      : letter.toLowerCase(),
  );
}

function resolvePathPrefixLength(unifiedPath: string): number {
  if (/^[A-Za-z]:\//.test(unifiedPath)) {
    return 3;
  }
  if (/^[A-Za-z]:$/.test(unifiedPath)) {
    return 2;
  }
  if (unifiedPath.startsWith("//")) {
    return 2;
  }
  if (unifiedPath.startsWith("/")) {
    return 1;
  }
  return 0;
}

function resolveLexicalPathSegments(
  remainderPath: string,
  canKeepParentSegments: boolean,
): string[] {
  const resolvedSegments: string[] = [];
  for (const pathSegment of remainderPath.split("/")) {
    if (pathSegment === "" || pathSegment === ".") {
      continue;
    }
    if (pathSegment === "..") {
      const previousSegment = resolvedSegments[resolvedSegments.length - 1];
      if (resolvedSegments.length > 0 && previousSegment !== "..") {
        resolvedSegments.pop();
      } else if (canKeepParentSegments) {
        resolvedSegments.push("..");
      }
      continue;
    }
    resolvedSegments.push(pathSegment);
  }
  return resolvedSegments;
}
