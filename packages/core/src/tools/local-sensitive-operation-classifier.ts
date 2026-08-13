/**
 * 本地敏感操作分类器（T06B / ADR-0014）。
 * 在 Ponder、Assist、Devolve 三种模式的策略判断之前，统一使用版本化静态
 * 元数据和确定性参数规则，识别文件变更、Git 变更、进程执行、网络、外部
 * 发布、凭据/备份访问和系统级操作。
 *
 * 规则在本地加载并执行；不发起云端分类请求。Provider 的分类、模型自述或
 * AI 风险评分只能作为非授权性诊断信息，不能允许、降级或绕过一次调用。
 */
import type { ToolDescriptor } from "../core/types.js";

/** 规则版本：规则变更时递增；拒绝事件携带该版本。 */
export const OPERATION_CLASSIFICATION_RULES_VERSION = 1;

export type SensitiveOperationClass =
  | "readonly-file"
  | "file-mutation"
  | "git-readonly"
  | "git-write"
  | "process-execution"
  | "network-access"
  | "external-publish"
  | "credentials-access"
  | "backup-access"
  | "system-level"
  | "state-query"
  | "unknown";

export interface OperationClassification {
  operationClass: SensitiveOperationClass;
  /** 是否属于"可证明只读"的能力（Ponder 白名单的硬前提）。 */
  isProvablyReadOnly: boolean;
  /** 是否属于敏感操作（凭据/备份/发布/系统级）。 */
  isSensitive: boolean;
  rulesVersion: number;
}

/** 破坏性 mutationKind 与操作类别映射（工具注册即声明，本地静态）。 */
const FILE_MUTATION_KINDS = new Set([
  "create-only",
  "delete-resource",
  "delete-content",
  "overwrite",
  "replace",
  "truncate",
  "delete-protected-backup",
]);

/** 仅按工具名即可确定性分类的映射（含现有内置工具与预留类别）。 */
const TOOL_NAME_CLASS: Record<string, SensitiveOperationClass> = {
  readFile: "readonly-file",
  listDirectory: "readonly-file",
  writeFileTemporary: "file-mutation",
  replaceFileContent: "file-mutation",
  backupVault: "backup-access",
  deleteBackup: "backup-access",
  taskSequenceStatus: "state-query",
  gitReadonlyView: "git-readonly",
};

/** 触发敏感分类的固定工具名前缀（凭据/发布/网络/进程类默认未注册，仍需分类）。 */
const SENSITIVE_TOOL_NAME_PATTERNS: Array<{
  pattern: RegExp;
  operationClass: SensitiveOperationClass;
}> = [
  { pattern: /^git\s*(push|pull|merge|rebase|reset|clean|checkout|branch\s+-[dD]|worktree\s+remove)/i, operationClass: "git-write" },
  { pattern: /^git\s+/i, operationClass: "git-readonly" },
  { pattern: /^searchProjectText$/i, operationClass: "readonly-file" },
  { pattern: /^(shell|exec|spawn|run|bash|sh|powershell|cmd)/i, operationClass: "process-execution" },
  { pattern: /^(http|https|fetch|web|curl|wget|download|request)/i, operationClass: "network-access" },
  { pattern: /^(publish|release|deploy|send|post|tweet|email)/i, operationClass: "external-publish" },
  { pattern: /(credential|secret|password|token|api[_-]?key|private[_-]?key|\.pem|\.key)/i, operationClass: "credentials-access" },
  { pattern: /^(install|uninstall|npm\s+install|apt|brew|pip)/i, operationClass: "system-level" },
  { pattern: /^(deleteBackup|purgeBackup)/i, operationClass: "backup-access" },
];

const SENSITIVE_CLASSES = new Set<SensitiveOperationClass>([
  "credentials-access",
  "backup-access",
  "external-publish",
  "system-level",
]);

export class LocalSensitiveOperationClassifier {
  /** 确定性分类：先按工具名静态映射，再按 mutationKind，最后按名称模式。 */
  classifyOperation(input: {
    toolName: string;
    mutationKind: ToolDescriptor["mutationKind"];
  }): OperationClassification {
    const staticClass = TOOL_NAME_CLASS[input.toolName];
    let operationClass: SensitiveOperationClass;
    if (staticClass !== undefined) {
      operationClass = staticClass;
    } else if (FILE_MUTATION_KINDS.has(input.mutationKind)) {
      operationClass = "file-mutation";
    } else {
      operationClass =
        this.classifyByNamePattern(input.toolName) ?? "unknown";
    }
    const isProvablyReadOnly =
      operationClass === "readonly-file" ||
      operationClass === "git-readonly" ||
      operationClass === "state-query";
    return {
      operationClass,
      isProvablyReadOnly,
      isSensitive: SENSITIVE_CLASSES.has(operationClass),
      rulesVersion: OPERATION_CLASSIFICATION_RULES_VERSION,
    };
  }

  private classifyByNamePattern(
    toolName: string,
  ): SensitiveOperationClass | null {
    for (const entry of SENSITIVE_TOOL_NAME_PATTERNS) {
      if (entry.pattern.test(toolName)) {
        return entry.operationClass;
      }
    }
    return null;
  }
}
