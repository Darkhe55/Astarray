/**
 * 本地工具策略引擎（T06B / ADR-0014）。
 * Ponder 只读白名单在工具暴露与真实执行两个时点校验：
 * - 只读文件适配器使用只读句柄（flag: "r"），经 WorkspaceBoundary 解析
 *   并通过 ProtectedStoragePolicy 与敏感路径过滤；
 * - 只读 Git 查询只暴露固定视图（status/diff/log），视图参数由引擎构造，
 *   模型不能注入任意 git 参数，也不经通用 shell；
 * - 工具未知、声明不完整、可能写入、同时读写或副作用无法证明时一律 fail-closed；
 * - 拒绝产生稳定本地事件（工具 ID、规则版本、原因），不记录文件秘密。
 */
import { DomainError } from "../core/errors.js";
import type { ToolDescriptor } from "../core/types.js";
import {
  LocalSensitiveOperationClassifier,
  OPERATION_CLASSIFICATION_RULES_VERSION,
} from "./local-sensitive-operation-classifier.js";
import type { WorkspaceBoundary } from "./workspace-boundary.js";
import type { ProtectedStoragePolicy } from "./protected-storage-policy.js";

/** Ponder 白名单：显式注册的本地只读能力。 */
export const PONDER_READONLY_TOOL_NAMES = [
  "readFile",
  "listDirectory",
  "searchProjectText",
  "taskSequenceStatus",
  "gitReadonlyView",
] as const satisfies readonly string[];

/** 固定只读 git 视图（参数由引擎构造，不拼接 shell）。 */
export const PONDER_READONLY_GIT_VIEWS = [
  "status",
  "diff",
  "log",
] as const satisfies readonly string[];

export const PONDER_GIT_LOG_MAX_LIMIT = 20;

/** Ponder 禁止触及的敏感文件名/路径模式（兼容 Windows 反斜杠分隔符）。 */
const PONDER_SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])(\.env|\.env\.[a-zA-Z0-9_-]+|credentials|secrets?|\.ssh)([\\/]|$)/i,
  /\.(pem|p12|pfx|jks|keystore|key)$/i,
  /(^|[\\/])\.git[\\/](config|credentials|http\.cookie)$/i,
];

export interface PonderDenialEvent {
  recordedAtIso: string;
  rulesVersion: number;
  toolName: string;
  reason: string;
}

export interface LocalToolPolicyEngineOptions {
  workspaceBoundary: WorkspaceBoundary;
  protectedStoragePolicy: ProtectedStoragePolicy;
  /** 本地拒绝事件接收器（安全组件本地记录；不持久化文件内容）。 */
  denialEventSink?: (event: PonderDenialEvent) => void;
}

export class LocalToolPolicyEngine {
  private readonly classifier = new LocalSensitiveOperationClassifier();

  constructor(private readonly options: LocalToolPolicyEngineOptions) {}

  /** Ponder 可暴露的工具白名单（只读能力的 schema 子集）。 */
  isPonderToolExposable(toolName: string): boolean {
    return (PONDER_READONLY_TOOL_NAMES as readonly string[]).includes(toolName);
  }

  /**
   * Ponder 实际执行前的强制校验（fail-closed）：
   * 白名单 + 只读分类 + 声明一致 + 参数安全。任何不确定都拒绝。
   */
  async assertPonderToolExecutionAllowed(input: {
    toolName: string;
    descriptor: ToolDescriptor;
    argumentsJson: string;
  }): Promise<void> {
    const reason = await this.evaluatePonderAccess(input);
    if (reason !== null) {
      this.emitDenial(input.toolName, reason);
      throw new DomainError(
        "tool-permission-denied",
        `Ponder 本地只读边界拒绝 ${input.toolName}: ${reason}`,
      );
    }
  }

  /** 返回 null 表示放行；否则返回拒绝原因。 */
  async evaluatePonderAccess(input: {
    toolName: string;
    descriptor: ToolDescriptor;
    argumentsJson: string;
  }): Promise<string | null> {
    if (!this.isPonderToolExposable(input.toolName)) {
      return `工具不在 Ponder 只读白名单`;
    }
    const classification = this.classifier.classifyOperation({
      toolName: input.toolName,
      mutationKind: input.descriptor.mutationKind,
    });
    if (!classification.isProvablyReadOnly) {
      return `操作分类非只读（${classification.operationClass}）`;
    }
    if (input.descriptor.category !== "readonly") {
      return `声明类别非 readonly（${input.descriptor.category}），拒绝暴露`;
    }
    if (input.descriptor.backupPolicy !== "not-required") {
      return `声明备份策略异常（${input.descriptor.backupPolicy}），fail-closed`;
    }
    if (input.descriptor.mutationKind !== "none") {
      return `声明变更类型非 none（${input.descriptor.mutationKind}），fail-closed`;
    }
    return this.validateArguments(input.toolName, input.argumentsJson);
  }

  /** Ponder 只读文件路径是否安全（工作区边界 + 受保护区 + 敏感路径）。 */
  async assertPonderReadonlyFilePath(requestedPath: string): Promise<string> {
    const resolvedPath = await this.options.workspaceBoundary.resolveWithinWorkspace(
      requestedPath,
    );
    await this.options.protectedStoragePolicy.assertGenericToolAccessAllowed({
      canonicalTargetPath: resolvedPath,
      operation: "read",
    });
    if (
      PONDER_SENSITIVE_PATH_PATTERNS.some((pattern) =>
        pattern.test(resolvedPath),
      )
    ) {
      const reason = `敏感路径被排除: ${requestedPath}`;
      this.emitDenial("readFile", reason);
      throw new DomainError("tool-permission-denied", `Ponder 拒绝 ${reason}`);
    }
    return resolvedPath;
  }

  /** 解析并校验 Ponder 只读 git 视图参数（引擎构造固定参数，模型不可注入）。 */
  parsePonderGitReadonlyArguments(args: unknown): {
    view: (typeof PONDER_READONLY_GIT_VIEWS)[number];
    logLimit: number | null;
  } | null {
    const view = (args as { view?: unknown }).view;
    if (
      typeof view !== "string" ||
      !(PONDER_READONLY_GIT_VIEWS as readonly string[]).includes(view)
    ) {
      return null;
    }
    const logLimitRaw = (args as { limit?: unknown }).limit;
    let logLimit: number | null = null;
    if (view === "log") {
      if (typeof logLimitRaw !== "number" || !Number.isInteger(logLimitRaw)) {
        return null;
      }
      logLimit = Math.max(1, Math.min(logLimitRaw, PONDER_GIT_LOG_MAX_LIMIT));
    }
    const typedView = view as (typeof PONDER_READONLY_GIT_VIEWS)[number];
    return { view: typedView, logLimit };
  }

  /** 由视图参数构造固定 git 参数序列（只读，无 shell）。 */
  buildPonderGitReadonlyArguments(view: string, logLimit: number | null): string[] {
    switch (view) {
      case "status":
        return ["status", "--porcelain"];
      case "diff":
        return ["diff", "--stat", "HEAD"];
      case "log":
        return ["log", "--oneline", "-n", `${logLimit ?? 10}`];
      default:
        return [];
    }
  }

  private async validateArguments(
    toolName: string,
    argumentsJson: string,
  ): Promise<string | null> {
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      return `参数不可解析，fail-closed`;
    }
    if (toolName === "gitReadonlyView") {
      return this.parsePonderGitReadonlyArguments(args) === null
        ? `gitReadonlyView 视图不在只读白名单或参数非法`
        : null;
    }
    if (toolName === "searchProjectText") {
      const pattern = (args as { pattern?: unknown }).pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        return `searchProjectText 参数 pattern 缺失或非法`;
      }
      if (pattern.length > 200) {
        return `searchProjectText pattern 过长（>200 字符）`;
      }
      return null;
    }
    return null;
  }

  private emitDenial(toolName: string, reason: string): void {
    this.options.denialEventSink?.({
      recordedAtIso: new Date().toISOString(),
      rulesVersion: OPERATION_CLASSIFICATION_RULES_VERSION,
      toolName,
      reason,
    });
  }
}
