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

export function hashToolArguments(argumentsJson: string): string {
  return createHash("sha256").update(argumentsJson).digest("hex");
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
