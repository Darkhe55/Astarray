/**
 * 可配置权限策略引擎（T06F / ADR-0020）。
 * 在 schema 暴露与实际执行前读取当前 profile 快照并裁决：
 * - 未映射工具拒绝（catalog 断言）；
 * - 工具需多项权限时取最严格结果；
 * - profile revision、工具权限映射或调用参数变化后，旧 ask 授权失效
 *   （授权记录绑定 profile revision 与目录版本）；
 * - 模式/权限组选择只能来自认证用户控制面。
 *
 * 内部强制执行层（敏感禁读、自动备份、身份认证、OS 边界等）不属于
 * 可配置权限目录；命中内部层只返回稳定最小"操作不可用"结果，
 * 详细分类只进入受保护内部审计。
 */
import { createHash } from "node:crypto";

import type { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";
import type { PermissionProfileStore } from "./permission-profile-store.js";
import type {
  PermissionProfileDocument,
  PermissionProfileReference,
} from "./permission-profile-store.js";

export interface ProfileBoundAuthorization {
  profileReference: PermissionProfileReference;
  profileRevision: number;
  catalogVersion: number;
  argumentHash: string;
  expiresAtUnixSeconds: number;
}

export interface ConfigurablePermissionPolicyEngineOptions {
  catalog: PermissionCapabilityCatalog;
  profileStore: PermissionProfileStore;
  /** 会话授权（bind revision；revokeAll 由调用方在 profile 切换时调用）。 */
  authorizations?: Map<string, ProfileBoundAuthorization>;
  nowUnixSeconds?: () => number;
  authorizationTtlSeconds?: number;
}

export type ConfigurablePermissionDecision =
  | { decision: "allow" }
  | { decision: "ask" }
  | { decision: "deny"; reason: string };

/**
 * 引擎裁决结果（内部审计与 UI 区分；模型只看到 deny/ask/allow）。
 * 内部执行层命中时 reason 为稳定最小文本，不含规则类别。
 */
export class ConfigurablePermissionPolicyEngine {
  private readonly catalog: PermissionCapabilityCatalog;
  private readonly profileStore: PermissionProfileStore;
  private readonly authorizations: Map<string, ProfileBoundAuthorization>;
  private readonly nowUnixSeconds: () => number;
  private readonly authorizationTtlSeconds: number;

  constructor(options: ConfigurablePermissionPolicyEngineOptions) {
    this.catalog = options.catalog;
    this.profileStore = options.profileStore;
    this.authorizations = options.authorizations ?? new Map();
    this.nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.authorizationTtlSeconds = options.authorizationTtlSeconds ?? 600;
  }

  /** 读取 profile 快照（内置动态生成；自定义读盘）。 */
  async readProfileSnapshot(
    reference: PermissionProfileReference,
  ): Promise<PermissionProfileDocument> {
    return this.profileStore.readProfile(reference);
  }

  /** 评估工具在该 profile 下的基础决定（最严格结果）。 */
  evaluateToolDecision(input: {
    toolName: string;
    profile: PermissionProfileDocument;
  }): PermissionDecision {
    return this.catalog.evaluateToolPermission({
      toolName: input.toolName,
      capabilityDecisions: input.profile.capabilityDecisions,
    });
  }

  /**
   * 实际执行前裁决：
   * - 未映射工具 → deny（未分类工具拒绝执行）；
   * - 基础决定 deny → deny；
   * - allow → allow；
   * - ask → 检查绑定当前 profile revision 的会话授权，有效则 allow，
   *   否则 ask。
   */
  async decide(input: {
    toolName: string;
    profileReference: PermissionProfileReference;
    argumentsJson: string;
  }): Promise<ConfigurablePermissionDecision> {
    if (!this.catalog.isToolMapped(input.toolName)) {
      return {
        decision: "deny",
        reason: "操作不可用",
      };
    }
    const profile = await this.profileStore.readProfile(input.profileReference);
    const baseDecision = this.evaluateToolDecision({
      toolName: input.toolName,
      profile,
    });
    if (baseDecision === "deny") {
      return { decision: "deny", reason: "操作不可用" };
    }
    if (baseDecision === "allow") {
      return { decision: "allow" };
    }
    // ask：绑定 profile revision 的授权
    const authorizationKey = this.authorizationKey(input.toolName, input.argumentsJson);
    const authorization = this.authorizations.get(authorizationKey);
    if (authorization === undefined) {
      return { decision: "ask" };
    }
    if (authorization.expiresAtUnixSeconds <= this.nowUnixSeconds()) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (
      authorization.profileReference.kind === "custom" &&
      (input.profileReference.kind !== "custom" ||
        authorization.profileReference.profileId !== input.profileReference.profileId)
    ) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (authorization.profileReference.kind === "builtin") {
      if (input.profileReference.kind !== "builtin") {
        this.authorizations.delete(authorizationKey);
        return { decision: "ask" };
      }
    }
    if (
      authorization.profileRevision !== profile.revision ||
      authorization.catalogVersion !== profile.catalogVersion
    ) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (authorization.argumentHash !== this.hashArguments(input.argumentsJson)) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    return { decision: "allow" };
  }

  /** 用户裁决后授予（绑定 profile revision 与目录版本；参数哈希）。 */
  async grantSessionAuthorization(input: {
    toolName: string;
    profileReference: PermissionProfileReference;
    argumentsJson: string;
  }): Promise<void> {
    const profile = await this.profileStore.readProfile(input.profileReference);
    this.authorizations.set(this.authorizationKey(input.toolName, input.argumentsJson), {
      profileReference: input.profileReference,
      profileRevision: profile.revision,
      catalogVersion: profile.catalogVersion,
      argumentHash: this.hashArguments(input.argumentsJson),
      expiresAtUnixSeconds: this.nowUnixSeconds() + this.authorizationTtlSeconds,
    });
  }

  private authorizationKey(toolName: string, argumentsJson: string): string {
    return `${toolName}:${this.hashArguments(argumentsJson)}`;
  }

  private hashArguments(argumentsJson: string): string {
    return createHash("sha256").update(argumentsJson).digest("hex");
  }
}
