/**
 * 权限策略与会话授权（T02）。
 * 判定矩阵（Ponder 一律 deny；Devolve 注册工具 allow；Assist 按类别 + 会话授权）：
 *   readonly  → allow
 *   restricted→ 会话授权有效 ? allow : ask
 *   forbidden → deny
 * 会话授权：默认 10 分钟 TTL（ADR-0006）；参数哈希变更必须二次鉴权。
 */
import { createHash } from "node:crypto";

import { ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES } from "./types.js";
import type { AgentMode, PermissionResult, ToolCategory, ToolDescriptor } from "./types.js";
import type { ModeMachine } from "./mode-machine.js";

export interface SessionAuthorizationRecord {
  toolName: string;
  argumentHash: string;
  expiresAtUnixSeconds: number;
}

export class SessionAuthorizationManager {
  private readonly authorizations = new Map<string, SessionAuthorizationRecord>();

  constructor(private readonly ttlMinutes: number = ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES) {}

  grant(toolName: string, argumentHash: string, nowUnixSeconds: number): SessionAuthorizationRecord {
    const record: SessionAuthorizationRecord = {
      toolName,
      argumentHash,
      expiresAtUnixSeconds: nowUnixSeconds + this.ttlMinutes * 60,
    };
    this.authorizations.set(toolName, record);
    return record;
  }

  /**
   * 是否仍有效：存在记录、未过期、参数哈希一致。
   * 任一不满足即失效（参数变更触发二次鉴权）。
   */
  isAuthorized(toolName: string, argumentHash: string, nowUnixSeconds: number): boolean {
    const record = this.authorizations.get(toolName);
    if (record === undefined) {
      return false;
    }
    if (record.expiresAtUnixSeconds <= nowUnixSeconds) {
      this.authorizations.delete(toolName);
      return false;
    }
    return record.argumentHash === argumentHash;
  }

  revokeAll(): void {
    this.authorizations.clear();
  }
}

export class PermissionPolicy {
  /**
   * Ponder：本地只读白名单由 LocalToolPolicyEngine 判定（T06B），
   * 策略矩阵本身不再"一律 deny"——可证明只读的白名单工具放行，
   * 其余全部 deny。isPonderReadonlyAllowed 由引擎注入（本地确定性判定）。
   */
  evaluate(
    category: ToolCategory,
    mode: AgentMode,
    isSessionAuthorized: boolean,
    isPonderReadonlyAllowed: boolean = false,
  ): PermissionResult {
    if (mode === "ponder") {
      return isPonderReadonlyAllowed ? "allow" : "deny";
    }
    if (mode === "devolve") {
      return "allow";
    }
    switch (category) {
      case "readonly":
        return "allow";
      case "restricted":
        return isSessionAuthorized ? "allow" : "ask";
      case "forbidden":
        return "deny";
    }
  }
}

/**
 * 参数规范化（授权绑定口径）：JSON 对象**键序无语义**，故递归按键排序后序列化；
 * 数组顺序与所有值保持原样（值变化仍必须使授权失效）。
 *
 * 反例（2026-10-01 真实运行）：模型两次生成语义等价但键序不同的参数
 * （`{"content":…,"filePath":…}` vs `{"filePath":…,"content":…}`），
 * 字节级哈希导致用户已批准的调用**再次**要求逐次裁决，且用户无法自行避免。
 * 无法解析为 JSON 时退回原始字符串（保持严格性，不当作等价）。
 */
export function canonicalizeToolArguments(argumentsJson: string): string {
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
  return serializeCanonical(parsedArguments);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  return `{${sortedKeys
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`)
    .join(",")}}`;
}

/** 工具参数哈希：**规范化后**再 sha256（授权 key 与 argumentHash 必须同源）。 */
export function hashToolArguments(argumentsJson: string): string {
  return createHash("sha256")
    .update(canonicalizeToolArguments(argumentsJson))
    .digest("hex");
}

export interface ToolPermissionRequest {
  toolName: string;
  category: ToolCategory;
  argumentsJson: string;
}

/**
 * 组合裁决器：模式（来自 ModeMachine）+ 会话授权（来自 SessionAuthorizationManager）
 * + Ponder 本地只读白名单（来自 LocalToolPolicyEngine，T06B）。
 * 保证"降级后的下一次调用使用新策略"：每次裁决实时读取当前模式；
 * Ponder 下不查询会话授权（降级后旧授权不能沿用）。
 */
export class PermissionDecider {
  private readonly policy = new PermissionPolicy();
  /** T06B：Ponder 只读判定器（异步本地校验；未注入时 Ponder 一律 deny）。 */
  private readonly ponderReadonlyDecider:
    | ((input: {
        toolName: string;
        descriptor: ToolDescriptor;
        argumentsJson: string;
      }) => Promise<boolean>)
    | null;

  constructor(
    private readonly modeMachine: ModeMachine,
    private readonly sessionManager: SessionAuthorizationManager,
    ponderReadonlyDecider?: PermissionDecider["ponderReadonlyDecider"],
  ) {
    this.ponderReadonlyDecider = ponderReadonlyDecider ?? null;
  }

  async decide(
    request: ToolPermissionRequest,
    nowUnixSeconds: number,
  ): Promise<PermissionResult> {
    const mode = this.modeMachine.getCurrentMode();
    if (mode === "ponder") {
      if (this.ponderReadonlyDecider === null) {
        return "deny";
      }
      const isReadonlyAllowed = await this.ponderReadonlyDecider({
        toolName: request.toolName,
        descriptor: {
          name: request.toolName,
          summary: "",
          category: request.category,
          mutationKind: request.category === "readonly" ? "none" : "delete-content",
          // RELIABILITY-01-02 · R1：该处只做只读白名单判定，保守标为非幂等。
          isIdempotent: false,
          backupPolicy: "not-required",
          authorizationPolicy: "standard",
          supportedTaskTypes: [],
          inputSchema: null,
        },
        argumentsJson: request.argumentsJson,
      });
      return isReadonlyAllowed ? "allow" : "deny";
    }
    if (mode === "assist" && request.category === "restricted") {
      const argumentHash = hashToolArguments(request.argumentsJson);
      const isSessionAuthorized = this.sessionManager.isAuthorized(
        request.toolName,
        argumentHash,
        nowUnixSeconds,
      );
      return this.policy.evaluate(request.category, mode, isSessionAuthorized);
    }
    return this.policy.evaluate(request.category, mode, false);
  }
}
