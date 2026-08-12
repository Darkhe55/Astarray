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
import type { AgentMode, PermissionResult, ToolCategory } from "./types.js";
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
  evaluate(
    category: ToolCategory,
    mode: AgentMode,
    isSessionAuthorized: boolean,
  ): PermissionResult {
    if (mode === "ponder") {
      return "deny";
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
 * 组合裁决器：模式（来自 ModeMachine）+ 会话授权（来自 SessionAuthorizationManager）。
 * 保证"降级后的下一次调用使用新策略"：每次裁决实时读取当前模式。
 */
export class PermissionDecider {
  private readonly policy = new PermissionPolicy();

  constructor(
    private readonly modeMachine: ModeMachine,
    private readonly sessionManager: SessionAuthorizationManager,
  ) {}

  decide(request: ToolPermissionRequest, nowUnixSeconds: number): PermissionResult {
    const mode = this.modeMachine.getCurrentMode();
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
