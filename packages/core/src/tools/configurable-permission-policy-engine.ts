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
import type { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";
import type { PermissionProfileStore } from "./permission-profile-store.js";
import { hashToolArguments } from "../core/permission-policy.js";
import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "./parameter-authorization.js";
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
  /**
   * MERGE-01：参数级授权（总开关 + 该工具细分 + 声明式规则）。
   *
   * 未注入时行为与既有完全一致（不改变任何现存裁决路径）。
   * 判定委托 `evaluateParameterAuthorization`（纯函数，无脚本/无正则）。
   */
  parameterAuthorization?: {
    settings: { isParameterAuthorizationEnabled: boolean; isParameterRulesEnabled: boolean };
    rules: ParameterAuthorizationRule[];
  };
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
  /** MERGE-01：参数级授权配置（未注入 ⇒ 行为与既有完全一致）。 */
  private readonly parameterAuthorization: {
    settings: { isParameterAuthorizationEnabled: boolean; isParameterRulesEnabled: boolean };
    rules: ParameterAuthorizationRule[];
  } | null;

  constructor(options: ConfigurablePermissionPolicyEngineOptions) {
    this.catalog = options.catalog;
    this.profileStore = options.profileStore;
    this.authorizations = options.authorizations ?? new Map();
    this.nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.authorizationTtlSeconds = options.authorizationTtlSeconds ?? 600;
    this.parameterAuthorization = options.parameterAuthorization ?? null;
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
    /**
     * MERGE-01：该调用的 **action**（本仓已有本地确定性事实：工具描述符的 `mutationKind`）。
     * 缺省为空串 ⇒ 参数规则不会按 action 匹配（因此不会误套用其它 action 的规则）。
     */
    action?: string;
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
    /**
     * MERGE-01：参数级授权（仅当注入配置时参与）。
     *
     * 语义（卡内 §1.3）：已匹配参数规则覆盖工具基线；未匹配回退基线；
     * 基线 deny 已是总拒绝（上面已返回）；多规则冲突 deny>ask>allow 由纯函数保证。
     * 结果仍需与会话授权等更外层上限**求交**，因此这里只把 allow/deny 定案，
     * `ask` 继续走下面的既有会话授权路径。
     */
    const parameterOutcome = this.evaluateParameterAuthorizationForCall({
      toolName: input.toolName,
      action: input.action ?? "",
      argumentsJson: input.argumentsJson,
      baselineDecision: baseDecision,
    });
    if (parameterOutcome !== null) {
      if (parameterOutcome.decision === "deny") {
        return {
          decision: "deny",
          reason: parameterOutcome.appliedRuleExplanation ?? "参数规则拒绝",
        };
      }
      if (parameterOutcome.decision === "allow") {
        return { decision: "allow" };
      }
      // 参数规则判 ask ⇒ 继续走既有 ask 路径（可被会话授权细化）。
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

  /**
   * MERGE-01：把参数级配置接到纯函数判定上；未注入配置时返回 null（不改变既有行为）。
   * 会话授权细化等更外层上限由调用方在此结果之后求交。
   */
  private evaluateParameterAuthorizationForCall(input: {
    toolName: string;
    action: string;
    argumentsJson: string;
    baselineDecision: PermissionDecision;
  }): ReturnType<typeof evaluateParameterAuthorization> | null {
    const configuration = this.parameterAuthorization;
    if (configuration === null) {
      return null;
    }
    return evaluateParameterAuthorization({
      toolName: input.toolName,
      action: input.action,
      argumentsJson: input.argumentsJson,
      baselineDecision: input.baselineDecision,
      settings: configuration.settings,
      rules: configuration.rules,
    });
  }

  private hashArguments(argumentsJson: string): string {
    // 与 SessionAuthorizationManager 同源：规范化（对象键排序）后哈希，
    // 否则语义等价的参数会失配，用户已批准的调用会被再次要求逐次裁决。
    return hashToolArguments(argumentsJson);
  }
}
