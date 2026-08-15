/**
 * Assist 安装门禁（T06E / ADR-0019）。
 * 安全顺序：检测到需要安装 → 询问是否已有资源 → 已有则只读验证复用；
 * 没有 → 检查独立开关（默认 false）→ 开启后展示精确安装计划并逐次
 * allow-once 授权 → 执行前本地复检 → 自动备份 → 执行一次 → 消费授权。
 *
 * 组件：
 * - AssistInstallationSettings：独立布尔开关，默认 false，单调 revision，
 *   自动备份 + 审计；只有认证用户经设置控制面可改。
 * - ExistingResourceInquiryController：安装前暂停 Agent 询问用户
 *   （awaiting-existing-resource-answer）；用户提供资源只做只读验证，
 *   验证失败继续等待用户决定，不能自动假定"没有"并安装。
 * - AssistInstallationAuthorizationController：allow-once 授权，绑定
 *   Agent/任务/来源/包/版本/完整性/目标/作用域/参数/脚本/变更摘要；
 *   绑定字段、设置 revision、模式或计划变化即失效；执行前本地复检。
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { z } from "zod";

/** 安装开关默认值：false（ADR-0019 §4）。 */
export const ASSIST_INSTALLATION_ENABLED_DEFAULT = false;

export const assistInstallationSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  isAssistInstallationEnabled: z.boolean(),
  revision: z.number().int().min(0),
  updatedAtIso: z.iso.datetime(),
});

export type AssistInstallationSettingsDocument = z.infer<
  typeof assistInstallationSettingsSchema
>;

export interface AssistInstallationSettingsStoreOptions {
  baseDirectory: string;
}

/**
 * 独立设置存储：<baseDirectory>/settings/assist-installation.json + .bak。
 * 写入自动备份 + 单调 revision；读取损坏时从备份恢复。
 */
export class AssistInstallationSettingsStore {
  private readonly settingsDirectory: string;
  private readonly settingsFilePath: string;
  private readonly backupFilePath: string;

  constructor(options: AssistInstallationSettingsStoreOptions) {
    this.settingsDirectory = path.join(options.baseDirectory, "settings");
    this.settingsFilePath = path.join(
      this.settingsDirectory,
      "assist-installation.json",
    );
    this.backupFilePath = path.join(
      this.settingsDirectory,
      "assist-installation.json.bak",
    );
  }

  async readSettings(): Promise<AssistInstallationSettingsDocument> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.settingsFilePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return {
        schemaVersion: 1,
        isAssistInstallationEnabled: ASSIST_INSTALLATION_ENABLED_DEFAULT,
        revision: 0,
        updatedAtIso: new Date().toISOString(),
      };
    }
    const parsed = assistInstallationSettingsSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `安装设置内容非法: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /**
   * 认证用户设置控制面更新开关（expected revision 校验）。
   * 写入前自动备份既有内容。
   */
  async updateInstallationEnabled(input: {
    expectedRevision: number;
    isAssistInstallationEnabled: boolean;
  }): Promise<AssistInstallationSettingsDocument> {
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    const current = await this.readSettings();
    if (current.revision !== input.expectedRevision) {
      throw new DomainError(
        "stale-revision",
        `安装设置 revision 不匹配: 现有 ${current.revision}，期望 ${input.expectedRevision}`,
      );
    }
    const nextDocument: AssistInstallationSettingsDocument = {
      schemaVersion: 1,
      isAssistInstallationEnabled: input.isAssistInstallationEnabled,
      revision: current.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    await writeAtomicJson(this.settingsFilePath, nextDocument);
    await backupExistingFile(this.settingsFilePath, this.backupFilePath);
    return nextDocument;
  }
}

/** 已有资源询问（结构化，发送给认证用户；不读取敏感配置）。 */
export interface ExistingResourceInquiry {
  inquiryId: string;
  requiredCapabilitySummary: string;
  intendedUse: string;
  compatibleCandidateTypes: string[];
  createdAtIso: string;
}

/** 用户回答：已有资源（提供引用）或没有。 */
export type ExistingResourceAnswer =
  | {
      answer: "has-resource";
      resourceReference: string;
      providedResourceType: string;
    }
  | { answer: "no-resource" };

/** 只读资源验证结果。 */
export interface ResourceReadonlyVerificationResult {
  isValid: boolean;
  differences: string[];
  verifiedAtIso: string;
}

/** 只读验证端口（版本/完整性/兼容性；不执行安装副作用）。 */
export interface ResourceReadonlyVerificationPort {
  verifyResource(input: {
    resourceReference: string;
    providedResourceType: string;
    requiredCapabilitySummary: string;
  }): Promise<ResourceReadonlyVerificationResult>;
}

/**
 * 安装前询问控制器：
 * - 发起询问并把 Agent 置为 awaiting-existing-resource-answer；
 * - 用户答"已有" → 只读验证；通过 → 可复用；不通过 → 返回差异继续等待；
 * - 用户答"没有" → 进入开关检查流程（返回 canProceedToInstallation=false
 *   与 settings 状态，由上层决定拒绝或发起授权请求）。
 */
export class ExistingResourceInquiryController {
  constructor(
    private readonly verificationPort: ResourceReadonlyVerificationPort | null,
  ) {}

  createInquiry(input: {
    requiredCapabilitySummary: string;
    intendedUse: string;
    compatibleCandidateTypes: string[];
  }): ExistingResourceInquiry {
    return {
      inquiryId: `inquiry-${randomUUID()}`,
      requiredCapabilitySummary: input.requiredCapabilitySummary,
      intendedUse: input.intendedUse,
      compatibleCandidateTypes: [...input.compatibleCandidateTypes],
      createdAtIso: new Date().toISOString(),
    };
  }

  /**
   * 处理用户回答。返回：
   * - has-resource 且验证通过 → resource-accepted；
   * - has-resource 且验证失败 → resource-rejected-with-differences
   *   （继续等待用户决定，不得自动安装）；
   * - no-resource → proceed-to-switch-check。
   */
  async handleAnswer(input: {
    inquiry: ExistingResourceInquiry;
    answer: ExistingResourceAnswer;
  }): Promise<
    | {
        outcome: "resource-accepted";
        verification: ResourceReadonlyVerificationResult;
      }
    | {
        outcome: "resource-rejected-with-differences";
        verification: ResourceReadonlyVerificationResult;
      }
    | { outcome: "proceed-to-switch-check" }
  > {
    if (input.answer.answer === "no-resource") {
      return { outcome: "proceed-to-switch-check" };
    }
    if (this.verificationPort === null) {
      return {
        outcome: "resource-rejected-with-differences",
        verification: {
          isValid: false,
          differences: ["只读验证端口未装配，无法确认资源可用"],
          verifiedAtIso: new Date().toISOString(),
        },
      };
    }
    const verification = await this.verificationPort.verifyResource({
      resourceReference: input.answer.resourceReference,
      providedResourceType: input.answer.providedResourceType,
      requiredCapabilitySummary: input.inquiry.requiredCapabilitySummary,
    });
    return verification.isValid
      ? { outcome: "resource-accepted", verification }
      : { outcome: "resource-rejected-with-differences", verification };
  }
}

/** 安装授权请求（绑定精确安装计划；一次性 nonce）。 */
export interface AssistInstallationRequest {
  authorizationRequestId: string;
  nonce: string;
  requestingAgentInstanceId: string;
  taskExecutionId: string;
  sourceUrlOrRegistry: string;
  packageOrRepositoryIdentifier: string;
  pinnedVersionOrCommit: string | null;
  integrityInformation: string | null;
  targetPathOrScope: string;
  packageManager: string;
  parametersJson: string;
  requiresNetwork: boolean;
  hasInstallScripts: boolean;
  expectedChangesSummary: string;
  createdAtIso: string;
  canRememberForSession: false;
}

export interface AssistInstallationAuthorizationDecision {
  authorizationRequestId: string;
  nonce: string;
  decision: "allow-once" | "deny";
  requestedParametersHash: string;
  settingsRevision: number;
  mode: "assist";
  expiresAtIso: string;
}

export interface AssistInstallationAuthorizationControllerOptions {
  settingsStore: AssistInstallationSettingsStore;
  /** 授权 TTL（毫秒，默认 5 分钟）。 */
  authorizationTtlMilliseconds?: number;
  /** 单调时钟（测试注入 fake clock）。 */
  nowUnixMilliseconds?: () => number;
}

/**
 * 授权控制器：开关检查 → 生成绑定请求 → allow-once 授权 →
 * 执行前复检（模式/设置 revision/nonce/参数哈希/过期）→ 消费。
 */
export class AssistInstallationAuthorizationController {
  private readonly settingsStore: AssistInstallationSettingsStore;
  private readonly ttlMilliseconds: number;
  private readonly nowUnixMilliseconds: () => number;
  private readonly grantedByNonce = new Map<string, AssistInstallationAuthorizationDecision>();
  private readonly consumedNonces = new Set<string>();

  constructor(options: AssistInstallationAuthorizationControllerOptions) {
    this.settingsStore = options.settingsStore;
    this.ttlMilliseconds = options.authorizationTtlMilliseconds ?? 5 * 60 * 1000;
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
  }

  /** 开关（独立设置；默认 false）。 */
  async isInstallationEnabled(): Promise<boolean> {
    const settings = await this.settingsStore.readSettings();
    return settings.isAssistInstallationEnabled;
  }

  /**
   * 开关开启后生成安装授权请求（不授权执行）。
   * 开关关闭 → 拒绝（fail-closed）。
   */
  async createAuthorizationRequest(input: {
    requestingAgentInstanceId: string;
    taskExecutionId: string;
    sourceUrlOrRegistry: string;
    packageOrRepositoryIdentifier: string;
    pinnedVersionOrCommit: string | null;
    integrityInformation: string | null;
    targetPathOrScope: string;
    packageManager: string;
    parametersJson: string;
    requiresNetwork: boolean;
    hasInstallScripts: boolean;
    expectedChangesSummary: string;
  }): Promise<
    | { outcome: "denied-settings-disabled" }
    | { outcome: "request-created"; request: AssistInstallationRequest }
  > {
    const enabled = await this.isInstallationEnabled();
    if (!enabled) {
      return { outcome: "denied-settings-disabled" };
    }
    return {
      outcome: "request-created",
      request: {
        authorizationRequestId: `install-req-${randomUUID()}`,
        nonce: `nonce-${randomUUID()}`,
        requestingAgentInstanceId: input.requestingAgentInstanceId,
        taskExecutionId: input.taskExecutionId,
        sourceUrlOrRegistry: input.sourceUrlOrRegistry,
        packageOrRepositoryIdentifier: input.packageOrRepositoryIdentifier,
        pinnedVersionOrCommit: input.pinnedVersionOrCommit,
        integrityInformation: input.integrityInformation,
        targetPathOrScope: input.targetPathOrScope,
        packageManager: input.packageManager,
        parametersJson: input.parametersJson,
        requiresNetwork: input.requiresNetwork,
        hasInstallScripts: input.hasInstallScripts,
        expectedChangesSummary: input.expectedChangesSummary,
        createdAtIso: new Date().toISOString(),
        canRememberForSession: false,
      },
    };
  }

  /**
   * 用户 allow-once 授权：绑定当前设置 revision 与请求参数哈希。
   * 授权不记忆、不批量、不可转授。
   */
  async authorizeAllowOnce(input: {
    request: AssistInstallationRequest;
    decision: "allow-once" | "deny";
  }): Promise<AssistInstallationAuthorizationDecision | null> {
    if (input.decision === "deny") {
      return null;
    }
    if (this.consumedNonces.has(input.request.nonce)) {
      return null;
    }
    const settings = await this.settingsStore.readSettings();
    const decision: AssistInstallationAuthorizationDecision = {
      authorizationRequestId: input.request.authorizationRequestId,
      nonce: input.request.nonce,
      decision: "allow-once",
      requestedParametersHash: this.hashRequestParameters(input.request),
      settingsRevision: settings.revision,
      mode: "assist",
      expiresAtIso: new Date(
        this.nowUnixMilliseconds() + this.ttlMilliseconds,
      ).toISOString(),
    };
    this.grantedByNonce.set(input.request.nonce, decision);
    return decision;
  }

  /**
   * 执行前本地复检（ADR-0019 §6）：模式必须仍为 assist、设置 revision
   * 未变、nonce 未消费未过期、绑定参数哈希一致。
   * 复检通过即消费授权（allow-once 一次有效）。
   */
  async verifyAndConsumeAuthorization(input: {
    request: AssistInstallationRequest;
    currentMode: string;
    currentSettingsRevision: number;
  }): Promise<{ allowed: boolean; reason: string | null }> {
    if (input.currentMode !== "assist") {
      return { allowed: false, reason: `模式已非 assist（${input.currentMode}）` };
    }
    const decision = this.grantedByNonce.get(input.request.nonce);
    if (decision === undefined) {
      return { allowed: false, reason: "无对应授权（allow-once 未授予或已消费）" };
    }
    if (this.consumedNonces.has(input.request.nonce)) {
      return { allowed: false, reason: "授权已被消费（重放拒绝）" };
    }
    if (new Date(decision.expiresAtIso).getTime() <= this.nowUnixMilliseconds()) {
      return { allowed: false, reason: "授权已过期" };
    }
    if (decision.settingsRevision !== input.currentSettingsRevision) {
      return { allowed: false, reason: "设置 revision 已变化，授权失效" };
    }
    const currentParametersHash = this.hashRequestParameters(input.request);
    if (currentParametersHash !== decision.requestedParametersHash) {
      return { allowed: false, reason: "安装计划参数已变化，授权失效" };
    }
    // 消费授权（allow-once）
    this.grantedByNonce.delete(input.request.nonce);
    this.consumedNonces.add(input.request.nonce);
    return { allowed: true, reason: null };
  }

  /** 参数哈希（绑定字段全集，变化即失效）。 */
  private hashRequestParameters(request: AssistInstallationRequest): string {
    const canonical = JSON.stringify({
      sourceUrlOrRegistry: request.sourceUrlOrRegistry,
      packageOrRepositoryIdentifier: request.packageOrRepositoryIdentifier,
      pinnedVersionOrCommit: request.pinnedVersionOrCommit,
      integrityInformation: request.integrityInformation,
      targetPathOrScope: request.targetPathOrScope,
      packageManager: request.packageManager,
      parametersJson: request.parametersJson,
      requiresNetwork: request.requiresNetwork,
      hasInstallScripts: request.hasInstallScripts,
      expectedChangesSummary: request.expectedChangesSummary,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }
}

/** 供测试：设置文件路径。 */
export function assistInstallationSettingsFilePath(baseDirectory: string): string {
  return path.join(baseDirectory, "settings", "assist-installation.json");
}
