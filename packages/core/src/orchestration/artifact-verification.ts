/**
 * 产物对账（2026-10-02，用户指定第三条语义的落地件）。
 *
 * 语义：**未解决的必需操作失败或验收缺失不得结案**。
 * 本地只能对账"本 AGENT 自己确实写入过的路径"——这些是本地的确定性事实：
 *  - 写类工具调用**成功**时登记其目标路径（来自工具参数，不由模型自述）；
 *  - 完成事件若额外声明 `declaredArtifacts`，一并纳入对账；
 *  - 结案前逐条检查文件是否存在，缺失即拒绝结案。
 *
 * 刻意**不**把"模型文字里出现的路径"当作产物依据：模型自述不能作为本地事实。
 */
import { statSync } from "node:fs";
import path from "node:path";

/** 会改变工作区状态的工具（与 worker 的写工具集合保持一致）。 */
const MUTATING_TOOL_NAMES = new Set([
  "createProjectFile",
  "replaceFileContent",
  "writeFileTemporary",
  "backupVault",
  "deleteBackup",
]);

/** 参数中可能承载目标路径的键（按优先级）。 */
const TARGET_PATH_KEYS = ["filePath", "path", "targetPath", "fileName", "directoryPath"] as const;

export interface ArtifactVerificationEvidence {
  gateName: string;
  passed: boolean;
}

/** 从写类工具的参数中解析目标路径；非写类工具或无法解析返回 null。 */
export function extractArtifactPathFromToolCall(input: {
  toolName: string;
  argumentsJson: string;
}): string | null {
  if (!MUTATING_TOOL_NAMES.has(input.toolName)) {
    return null;
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(input.argumentsJson);
  } catch {
    return null;
  }
  if (parsedArguments === null || typeof parsedArguments !== "object") {
    return null;
  }
  const record = parsedArguments as Record<string, unknown>;
  for (const key of TARGET_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/** 相对路径只接受工作区内路径（拒绝绝对路径与向上越界），避免对账探出工作区。 */
function isSafeWorkspaceRelativePath(candidatePath: string): boolean {
  if (candidatePath === "") {
    return false;
  }
  if (path.isAbsolute(candidatePath) || /^[A-Za-z]:[\\/]/.test(candidatePath)) {
    return false;
  }
  const normalizedSegments = candidatePath.split(/[\\/]+/);
  return !normalizedSegments.includes("..");
}

/**
 * 逐条对账产物是否存在，产出可直接用于完成门禁的证据列表。
 * 不存在的路径 → `passed: false`（门禁据此拒绝结案）。
 */
export function verifyArtifactExistence(input: {
  artifactPaths: Iterable<string>;
  workspaceRootPath: string;
}): ArtifactVerificationEvidence[] {
  const evidence: ArtifactVerificationEvidence[] = [];
  for (const artifactPath of new Set(input.artifactPaths)) {
    if (!isSafeWorkspaceRelativePath(artifactPath)) {
      evidence.push({
        gateName: `产物存在性: ${artifactPath}（拒绝工作区外路径）`,
        passed: false,
      });
      continue;
    }
    const absolutePath = path.resolve(input.workspaceRootPath, artifactPath);
    let isExistingFile: boolean;
    try {
      isExistingFile = statSync(absolutePath).isFile();
    } catch {
      isExistingFile = false;
    }
    evidence.push({
      gateName: `产物存在性: ${artifactPath}`,
      passed: isExistingFile,
    });
  }
  return evidence;
}
