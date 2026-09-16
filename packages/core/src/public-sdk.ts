/**
 * Astarray 公开 SDK facade（T07D-08 / T07D-R1-01）。
 *
 * 应用服务从安装包公开 exports 创建：运行时资源由应用层装配与回收，
 * 消费者不导入 MainController、TUI bootstrap 或内部存储路径。
 * 会话/任务状态迁移在此冻结；提交/查询/取消委托给同一主控制器。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentMode, AgentRuntime, TaskDependencyNode } from "./core/types.js";
import type { MainController } from "./orchestration/main-controller.js";
import type { PermissionProfileReference } from "./tools/permission-profile-store.js";
import { ProviderConfigurationError } from "./runtime/provider-runtime-registry.js";
import type {
  ProviderRuntimeCapability,
  ProviderRuntimeRegistry,
} from "./runtime/provider-runtime-registry.js";
import type { ApplicationRuntime } from "./application/application-runtime.js";
import { createApplicationRuntime } from "./application/application-runtime.js";
import { DomainError } from "./core/errors.js";
import { resolveContextBudget } from "./orchestration/context-prompt-assembler.js";
import type { RecoveryCenterController } from "./orchestration/recovery-center-controller.js";
import {
  createManifestChunkReader,
  createSummaryCursor,
  readSummaryPage,
  type SummaryChunk,
  type SummaryDetailLevel,
} from "./summarization/summary-manifest.js";
import { buildLocalExtractiveNarrative, buildWorkArchiveSummaryEntries } from "./summarization/summary-source-adapters.js";
import { measureSummaryOperation } from "./summarization/summary-resource-metrics.js";
import { advanceSummaryGeneration } from "./summarization/summary-generation-service.js";
import { SummaryIndexStore } from "./summarization/summary-index-store.js";
import { buildRuntimeGuidanceEvent } from "./runtime-guidance/runtime-guidance.js";

// ─── SUM-02：计量、请求预算、事实核验、缓存分离与质量评估的公开入口 ───
export {
  CONSERVATIVE_ESTIMATOR_VERSION,
  PROMPT_SERIALIZATION_VERSION,
  TOKEN_MEASUREMENT_SCHEMA_VERSION,
  TokenMeasurementError,
  TokenMeasurementService,
  estimateTokensConservatively,
  isMeasurementReusableFor,
  type TokenMeasurement,
  type TokenMeasurementSourceKind,
} from "./measurement/token-measurement.js";
export {
  assembleRequestBudget,
  buildMeasurementTargetKey,
  isMeasurementReusableForTarget,
  remeasureRecordsForTarget,
  type RequestBudgetAssemblyResult,
  type RequestBudgetRecord,
  type RequestMeasurementTarget,
} from "./measurement/request-budget.js";
export {
  SummaryFactVerificationError,
  assertVerifiableOriginalSources,
  extractAuthoritativeClaims,
  rebuildNarrativeFromClaims,
  verifyNarrativeAgainstClaims,
  type AuthoritativeClaim,
  type AuthoritativeRecord,
  type NarrativeVerificationReport,
} from "./measurement/summary-fact-verification.js";
export {
  MeasurementCache,
  buildMeasurementCacheKey,
  computeContentHash,
  computeMeasurementCacheMetrics,
  type MeasurementCacheMetrics,
  type MeasurementCacheSnapshot,
} from "./measurement/measurement-cache.js";
export {
  QualityEvaluationError,
  evaluateSummaryQuality,
  type QualityEvaluationMetrics,
  type QualityLabeledSample,
} from "./measurement/quality-evaluation.js";
export {
  attachProviderUsageToMeasurement,
  createJsonlProviderUsageCapture,
  describeOfflineCaptureStatus,
  isCapturedUsageReusableForRequest,
  type CapturedProviderUsage,
  type ProviderUsageCapturePort,
} from "./measurement/provider-usage-capture.js";

/** SDK 版本（与 package.json 同步语义版本）。 */
export const ASTARRAY_SDK_VERSION = "0.1.0";

export type PublicTaskStatus =
  | "accepted"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

/** 公开会话状态（公共 DTO；不含内部字段）。 */
export interface PublicSessionState {
  sessionId: string;
  mode: AgentMode;
  status: "idle" | "running" | "blocked" | "closed";
}

/** 公开任务结果（公共 DTO）。 */
export interface PublicTaskResult {
  taskIdentifier: string;
  status: PublicTaskStatus;
  /** 本地 mission 标识；accepted 后必填，用于 query/cancel。 */
  missionIdentifier: string | null;
  summaryPreview: string | null;
}

/** 公开事件（订阅用；不含凭据/内部执行细节）。 */
export type PublicAstarrayEvent = (
  | { eventType: "session-status"; sessionId: string; status: PublicSessionState["status"] }
  | { eventType: "task-status"; taskIdentifier: string; status: PublicTaskStatus }
  | { eventType: "task-finished"; taskIdentifier: string; status: PublicTaskStatus }
  | {
      eventType: "budget-policy-updated";
      budgetPolicyRevision: number;
      configuredMaximumGlobalContextTokenCount: number;
    }
) & {
  /** 权威状态 revision（任务链 revision；会话事件用会话内单调计数）。 */
  revision: number;
  /** 幂等 ID：同一事件重复投递时可用于去重。 */
  idempotencyId: string;
};

/** 状态订阅端口（不暴露 IPC 地址）。 */
export interface PublicEventSubscriptionPort {
  subscribe(
    listener: (event: PublicAstarrayEvent) => void,
  ): { unsubscribe(): void };
}

/**
 * 公共应用服务端口：CLI/TUI/外部消费者共用的应用能力视图。
 * 只暴露公共能力（任务状态、模式、权限组控制面），不暴露内部装配与存储。
 */
export type PublicApplicationService = Pick<
  MainController,
  | "getActiveMissionIds"
  | "queryMissionStatus"
  | "getMetricsSnapshot"
  | "handleUserMessage"
  | "cancelMission"
  | "sendSchedulerInstruction"
  | "grantSessionAuthorization"
  | "transitionMode"
  | "getCurrentPermissionProfileReference"
  | "listPermissionProfiles"
  | "switchPermissionProfile"
>;

/** 公开 mission 状态（SDK/CLI 共用视图）。 */
export interface PublicMissionState {
  missionIdentifier: string;
  status: PublicTaskStatus;
}

/**
 * 公开上下文预算与装配实际值（GUI-01-R-03）。
 * 只含配置值、有效值、revision 与样本数；不含状态目录、凭据或模型上下文正文。
 */
export interface PublicContextSettings {
  configuredMaximumGlobalContextTokenCount: number;
  effectiveMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  budgetReductionReason: string | null;
  /** 已记录的上下文装配事件样本数（实际值分母）。 */
  assemblySampleSize: number;
  /** 最近一次真实装配使用的预算 revision（证明"下一次请求已按新配置生效"）。 */
  lastAssemblyBudgetPolicyRevision: number | null;
}

/** 公开恢复 mission 视图（不含租约持有进程标识等内部字段）。 */
export interface PublicRecoveryMissionView {
  missionIdentifier: string;
  exists: boolean;
  reconciliationRequired: boolean;
  status: string | null;
  isCorrupted: boolean;
  pendingTaskCount: number | null;
  hasTrustedCheckpoint: boolean;
  isLeaseActive: boolean;
}

export interface PublicRecoveryOverview {
  missions: PublicRecoveryMissionView[];
  requiresDecisionMissions: string[];
}

/**
 * 公开待追认项（GUI-01-R-03b）。
 * 每个条目绑定具体 `agentInstanceId`（owner），不合并不同 Agent 的上下文。
 */
export interface PublicPendingVerification {
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  contextNodeIdentifier: string;
  contextGraphRevision: number;
  humanSteps: string;
  risks: string[];
  artifactOrCommitReferences: string[];
  automaticTestReferences: string[];
  createdAtIso: string;
}

/** SUM-01-04a：摘要来源概要（工作台/CLI 列表用；不含本地路径）。 */
export interface PublicSummarySourceSummary {
  sourceKind: "conversation" | "work-archive" | "report" | "deferred-file";
  sourceIdentifier: string;
  manifestRevision: number;
  coveredThroughSourceRevision: number;
  chunkCount: number;
  pendingSourceRevisionCount: number;
  narrativeCharacterCount: number;
  generatorVersion: string;
}

/** 公开资源观测（磁盘索引大小、返回量、耗时、原文访问次数）。 */
export interface PublicSummaryResourceMetrics {
  manifestFileBytes: number;
  chunkCount: number;
  narrativeCharacterCount: number;
  returnedUnitCount: number;
  wallMilliseconds: number;
  sourceAccessCount: number;
  diskReadOperationCount: number;
  isReturnBounded: boolean;
}

export interface PublicSummaryEvidencePointer {
  sourceIdentifier: string;
  sourceRevision: number;
  contentHash: string;
}

export interface PublicSummaryChunkView {
  chunkIdentifier: string;
  sourceRevisionFrom: number;
  sourceRevisionTo: number;
  themeIdentifier: string;
  excerpt: string;
  isExcerptBounded: boolean;
  evidencePointers: PublicSummaryEvidencePointer[];
}

export interface PublicSummaryView {
  kind: "page";
  sourceIdentifier: string;
  detailLevel: SummaryDetailLevel;
  manifestRevision: number;
  chunks: PublicSummaryChunkView[];
  hasMore: boolean;
  nextPageIndex: number | null;
  coverage: {
    coveredThroughSourceRevision: number;
    pendingSourceRevisions: number[];
    chunkCount: number;
  };
  themeSummaries: Array<{ themeIdentifier: string; chunkCount: number }> | null;
  isReturnBounded: boolean;
  returnedUnitCount: number;
  resourceMetrics: PublicSummaryResourceMetrics;
}

export interface PublicSummarySectionView {
  kind: "section";
  sourceIdentifier: string;
  chunkIdentifier: string;
  sourceRevisionFrom: number;
  sourceRevisionTo: number;
  manifestRevision: number;
  excerpt: string;
  isExcerptBounded: boolean;
  narrativeExcerpt: string | null;
  evidencePointers: PublicSummaryEvidencePointer[];
  resourceMetrics: PublicSummaryResourceMetrics;
}

export interface PublicSummaryBuildResult {
  sourceIdentifier: string;
  manifestRevision: number;
  chunkCount: number;
  coveredThroughSourceRevision: number;
  entryCount: number;
  generatorVersion: string;
}

/** AUTH-SCOPE-03：操作范围预演结果（只读，不消费授权）。 */
export interface PublicOperationScopeEvaluation {
  scopeClass:
    | "S1-project-internal"
    | "S2-cross-project-root"
    | "S3-project-external"
    | "S4-unknown"
    | "S5-installation"
    | "S6-external-software"
    | "S7-special-flow";
  projectIdentifier: string | null;
  resolvedTargetPath: string | null;
  decision: "allow" | "deny" | "ask-superior" | "ask-user";
  adjudicator: string;
  reasons: string[];
  operationFingerprint: string;
}

/** AUTH-SCOPE-03：单次授权（重放不产生副作用）。 */
export interface PublicScopeAuthorizationGrant {
  receiptIdentifier: string;
  operationFingerprint: string;
  approvedByUserId: string;
}

/** GUIDE-01-04：运行中指导提交结果（受理 ≠ 已应用）。 */
export interface PublicGuidanceSubmissionResult {
  status: "accepted" | "recorded" | "rejected";
  guidanceIdentifier: string;
  guidanceRevision: number;
  behaviorTier: "record-only" | "safe-point-guidance" | "gate-and-request-pause";
  reasons: string[];
  isDuplicateDelivery: boolean;
  submittedAtIso: string;
}

/** GUIDE-01-04：指导接收/应用状态（含安全点应用延迟）。 */
export interface PublicGuidanceStatusEntry {
  guidanceIdentifier: string;
  guidanceRevision: number;
  behaviorTier: PublicGuidanceSubmissionResult["behaviorTier"];
  missionIdentifier: string;
  taskIdentifier: string | null;
  status: "queued" | "applied" | "dropped" | "superseded";
  submittedAtIso: string;
  appliedAtIso: string | null;
  latencyMilliseconds: number | null;
  dropReason: string | null;
  /** false 表示只有提交记录、尚无进程回写应用结果（不虚报已应用）。 */
  isApplicationStatusKnown: boolean;
}

/** 公开人工裁决结果（签收写入归属 Agent 存档；否决只重开节点不破坏性回滚）。 */
export interface PublicVerificationDecisionResult {
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  decision: "accepted" | "rejected";
  acceptanceIdentifier: string | null;
  reopenedNodeIdentifiers: string[];
}

function toPublicRecoveryMissionView(view: {
  missionIdentifier: string;
  exists: boolean;
  reconciliationRequired: boolean;
  status: string | null;
  isCorrupted: boolean;
  pendingTaskCount: number | null;
  hasTrustedCheckpoint: boolean;
  isLeaseActive: boolean;
}): PublicRecoveryMissionView {
  return {
    missionIdentifier: view.missionIdentifier,
    exists: view.exists,
    reconciliationRequired: view.reconciliationRequired,
    status: view.status,
    isCorrupted: view.isCorrupted,
    pendingTaskCount: view.pendingTaskCount,
    hasTrustedCheckpoint: view.hasTrustedCheckpoint,
    isLeaseActive: view.isLeaseActive,
  };
}

/** 应用创建选项：由消费者从公开 exports 传入，不接触内部控制器。 */
export interface PublicApplicationOptions {
  stateDirectory: string;
  mode: AgentMode;
  /** 运行时选择：mock（离线）或 provider（真实 Provider，T07D-R2）。 */
  runtime?: "mock" | "provider";
  /** Provider 配置（runtime=provider 时必填；只含受保护凭据引用）。 */
  provider?: PublicProviderConfiguration;
  /** Provider 运行时注册表（嵌入方注入；runtime=provider 且未提供则稳定失败）。 */
  providerRuntimeRegistry?: ProviderRuntimeRegistry;
  /** 可选流式输出钩子（headless 写 stderr；不暴露内部字段）。 */
  streamOutput?: (missionIdentifier: string | null, text: string) => void;
  concurrency?: number;
  failureThreshold?: number;
  maximumLoopIterations?: number;
  /** 权威状态轮询间隔（毫秒）；测试可注入更小值。 */
  statusPollIntervalMilliseconds?: number;
}

/** 公开 Provider 配置：只含受保护凭据引用与允许列表，不含秘密内容。 */
export interface PublicProviderConfiguration {
  providerId: string;
  modelIdentifier: string;
  allowedModelIdentifiers: string[];
  requiredCapabilities?: ProviderRuntimeCapability[];
  baseUrl?: string | null;
  protectedCredentialReferenceId?: string | null;
  requestTimeoutMilliseconds?: number;
}

/** 公开应用错误：稳定 errorCode，便于消费者分支处理。 */
export class PublicApplicationError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicApplicationError";
  }
}

interface TaskRecord {
  sessionId: string;
  missionIdentifier: string | null;
  status: PublicTaskStatus;
  summaryPreview: string | null;
  /** 任务链 revision（权威状态版本；未拿到时保持上一次值）。 */
  revision: number;
}

/**
 * 稳定应用 facade：CLI/TUI/外部消费者共用同一主控制器。
 * 本 facade 不实现第二套权限/任务/Provider 逻辑。
 */
export class AstarrayApplicationFacade implements PublicApplicationService {
  /** 从公开 exports 创建应用；运行资源由应用层创建。 */
  static async create(
    options: PublicApplicationOptions,
  ): Promise<AstarrayApplicationFacade> {
    const runtimeKind = options.runtime ?? "mock";
    let mainRuntimeFactory:
      | ((agentInstanceId: string) => AgentRuntime)
      | undefined;
    let workerRuntimeFactory:
      | ((agentInstanceId: string, task: TaskDependencyNode) => AgentRuntime)
      | undefined;
    if (runtimeKind === "provider") {
      const registry = options.providerRuntimeRegistry;
      if (registry === undefined) {
        throw new PublicApplicationError(
          "runtime-unsupported",
          "选择 provider 运行时需要已注册的 Provider 运行时（不静默回退 mock）",
        );
      }
      const provider = options.provider;
      if (provider === undefined) {
        throw new PublicApplicationError(
          "provider-config-missing",
          "缺少 Provider 配置（providerId/modelIdentifier）",
        );
      }
      try {
        const resolved = await registry.resolveRuntime({
          providerId: provider.providerId,
          modelIdentifier: provider.modelIdentifier,
          allowedModelIdentifiers: provider.allowedModelIdentifiers,
          requiredCapabilities: provider.requiredCapabilities,
          baseUrl: provider.baseUrl ?? null,
          protectedCredentialReferenceId:
            provider.protectedCredentialReferenceId ?? null,
          requestTimeoutMilliseconds: provider.requestTimeoutMilliseconds,
        });
        mainRuntimeFactory = () => resolved.createRuntime();
        workerRuntimeFactory = () => resolved.createRuntime();
      } catch (error) {
        if (error instanceof ProviderConfigurationError) {
          throw new PublicApplicationError(error.errorCode, error.message);
        }
        throw error;
      }
    } else if (runtimeKind !== "mock") {
      throw new PublicApplicationError(
        "runtime-unsupported",
        "不支持的运行时: " + String(runtimeKind),
      );
    }
    const runtime = await createApplicationRuntime({
      mode: options.mode,
      stateDirectory: options.stateDirectory,
      concurrency: options.concurrency ?? 1,
      failureThreshold: options.failureThreshold ?? 1,
      maxLoopIterations: options.maximumLoopIterations ?? 8,
      useFeedbackProcess: false,
      streamOutput: options.streamOutput ?? (() => {}),
      backupDeletionControlPort: null,
      installationUserPort: null,
      authenticatedUserId: "sdk-user",
      mainAgentInstanceId: "main-agent-sdk",
      feedbackProcessModulePath: null,
      mainRuntimeFactory,
      workerRuntimeFactory,
      requireCompletionControlEvent: runtimeKind === "provider",
    });
    return new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: options.statusPollIntervalMilliseconds ?? 25,
      stateDirectory: options.stateDirectory,
    });
  }

  constructor(
    private readonly runtime: ApplicationRuntime,
    options: {
      statusPollIntervalMilliseconds?: number;
      stateDirectory?: string;
    } = {},
  ) {
    this.statusPollIntervalMilliseconds =
      options.statusPollIntervalMilliseconds ?? 25;
    this.stateDirectory = options.stateDirectory ?? null;
  }

  private readonly stateDirectory: string | null;
  private recoveryCenterController: RecoveryCenterController | null = null;

  private readonly sessionStates = new Map<string, PublicSessionState>();
  private readonly tasksByTaskIdentifier = new Map<string, TaskRecord>();
  private readonly taskIdentifierByIdempotencyKey = new Map<string, string>();
  private readonly taskMonitors = new Map<string, NodeJS.Timeout>();
  private readonly inFlightPolls = new Set<Promise<void>>();
  private readonly listeners = new Set<(event: PublicAstarrayEvent) => void>();
  private readonly statusPollIntervalMilliseconds: number;
  private isClosedFlag = false;

  get isClosed(): boolean {
    return this.isClosedFlag;
  }

  /** 创建会话（冻结状态迁移：idle → closed）。 */
  createSession(input: { sessionId: string; mode: AgentMode }): PublicSessionState {
    this.assertOpen();
    if (this.sessionStates.has(input.sessionId)) {
      throw new PublicApplicationError(
        "session-already-exists",
        "会话已存在: " + input.sessionId,
      );
    }
    if (input.mode !== this.runtime.controller.getCurrentMode()) {
      throw new PublicApplicationError(
        "mode-mismatch",
        "会话模式与应用模式不一致: " + input.mode,
      );
    }
    const state: PublicSessionState = {
      sessionId: input.sessionId,
      mode: input.mode,
      status: "idle",
    };
    this.sessionStates.set(input.sessionId, state);
    this.emit({
      eventType: "session-status",
      sessionId: input.sessionId,
      status: "idle",
      revision: this.nextSessionEventRevision(input.sessionId),
      idempotencyId: this.nextEventIdempotencyId(),
    });
    return { ...state };
  }

  /** 打开既有会话；不存在或应用已关闭时抛出公开错误。 */
  openSession(sessionId: string): PublicSessionState {
    this.assertOpen();
    const state = this.sessionStates.get(sessionId);
    if (state === undefined) {
      throw new PublicApplicationError("session-not-found", "会话不存在: " + sessionId);
    }
    return { ...state };
  }

  listSessions(): PublicSessionState[] {
    return [...this.sessionStates.values()].map((state) => ({ ...state }));
  }

  /** 公共应用服务端口：CLI/TUI 通过本 facade 访问应用能力（不接触内部装配）。 */
  getActiveMissionIds(): string[] {
    return this.runtime.controller.getActiveMissionIds();
  }

  async queryMissionStatus(missionId: string) {
    return this.runtime.controller.queryMissionStatus(missionId);
  }

  getMetricsSnapshot() {
    return this.runtime.controller.getMetricsSnapshot();
  }

  async handleUserMessage(message: string): Promise<string> {
    return this.runtime.controller.handleUserMessage(message);
  }

  async cancelMission(missionId: string): Promise<void> {
    return this.runtime.controller.cancelMission(missionId);
  }

  sendSchedulerInstruction(missionId: string, instructionText: string): void {
    this.runtime.controller.sendSchedulerInstruction(missionId, instructionText);
  }

  async grantSessionAuthorization(
    toolName: string,
    argumentsJson: string,
    nowUnixSeconds: number,
  ): Promise<void> {
    return this.runtime.controller.grantSessionAuthorization(
      toolName,
      argumentsJson,
      nowUnixSeconds,
    );
  }

  transitionMode(mode: AgentMode): void {
    this.runtime.controller.transitionMode(mode);
  }

  async getCurrentPermissionProfileReference() {
    return this.runtime.controller.getCurrentPermissionProfileReference();
  }

  async listPermissionProfiles(input: { page: number; pageSize: number }) {
    return this.runtime.controller.listPermissionProfiles(input);
  }

  async switchPermissionProfile(reference: PermissionProfileReference): Promise<void> {
    return this.runtime.controller.switchPermissionProfile(reference);
  }

  /**
   * GUI-01-R-03：读取上下文预算配置与真实装配实际值。
   * 数据来自全局预算权威存储与真实装配事件，不复制状态机、不引入前端缓存。
   */
  async queryContextSettings(): Promise<PublicContextSettings> {
    this.assertOpen();
    const policy = await this.runtime.globalContextBudgetStore.readPolicy();
    const resolution = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount:
        policy.configuredMaximumGlobalContextTokenCount,
      budgetPolicyRevision: policy.globalContextBudgetPolicyRevision,
    });
    const assemblyEvents = await this.runtime.contextRuntimeEventStore.readAll();
    const lastAssembly = assemblyEvents.at(-1) ?? null;
    return {
      configuredMaximumGlobalContextTokenCount:
        resolution.configuredMaximumGlobalContextTokenCount,
      effectiveMaximumGlobalContextTokenCount:
        resolution.effectiveMaximumGlobalContextTokenCount,
      budgetPolicyRevision: resolution.budgetPolicyRevision,
      budgetReductionReason: resolution.budgetReductionReason,
      assemblySampleSize: assemblyEvents.length,
      lastAssemblyBudgetPolicyRevision: lastAssembly?.budgetPolicyRevision ?? null,
    };
  }

  /**
   * GUI-01-R-03：以 CAS 写入预算策略；下一模型请求的装配按新 revision 生效
   * （装配提供者从同一存储读取，revision 变化使选择缓存失效）。
   */
  async updateContextBudget(input: {
    expectedRevision: number;
    configuredMaximumGlobalContextTokenCount: number;
  }): Promise<PublicContextSettings> {
    this.assertOpen();
    try {
      await this.runtime.globalContextBudgetStore.updatePolicy({
        expectedRevision: input.expectedRevision,
        configuredMaximumGlobalContextTokenCount:
          input.configuredMaximumGlobalContextTokenCount,
        updatedByUserId: "authenticated-user",
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw new PublicApplicationError(error.errorCode, error.message);
      }
      throw error;
    }
    const settings = await this.queryContextSettings();
    this.emit({
      eventType: "budget-policy-updated",
      budgetPolicyRevision: settings.budgetPolicyRevision,
      configuredMaximumGlobalContextTokenCount:
        settings.configuredMaximumGlobalContextTokenCount,
      revision: settings.budgetPolicyRevision,
      idempotencyId: this.nextEventIdempotencyId(),
    });
    return settings;
  }

  /** GUI-01-R-03：恢复中心只读概览（真实 RecoveryCenterController）。 */
  async queryRecoveryOverview(): Promise<PublicRecoveryOverview> {
    this.assertOpen();
    const controller = await this.createRecoveryCenterController();
    const { missions, requiresDecisionMissions } = await controller.listMissions();
    return {
      missions: missions.map((mission) =>
        toPublicRecoveryMissionView(mission),
      ),
      requiresDecisionMissions: [...requiresDecisionMissions],
    };
  }

  /** GUI-01-R-03：单个 mission 的磁盘状态/损坏/检查点/租约视图。 */
  async inspectRecoveryMission(
    missionIdentifier: string,
  ): Promise<PublicRecoveryMissionView | null> {
    this.assertOpen();
    const controller = await this.createRecoveryCenterController();
    const { view } = await controller.inspectMission(missionIdentifier);
    return view.exists ? toPublicRecoveryMissionView(view) : null;
  }

  /**
   * GUI-01-R-03b：列出本地存档中所有 Agent 的待追认项。
   * 按 owner（`agentInstanceId`）分组返回，不做跨 Agent 合并或推断。
   */
  async listPendingVerifications(): Promise<PublicPendingVerification[]> {
    this.assertOpen();
    const pending: PublicPendingVerification[] = [];
    for (const ownerAgentInstanceId of await this.listAgentMemoryOwners()) {
      const tasks =
        await this.runtime.humanVerificationController.listDeferredVerificationTasks(
          ownerAgentInstanceId,
        );
      for (const task of tasks) {
        pending.push({
          ownerAgentInstanceId,
          taskIdentifier: task.taskIdentifier,
          contextNodeIdentifier: task.contextNodeIdentifier,
          contextGraphRevision: task.contextGraphRevision,
          humanSteps: task.humanSteps,
          risks: [...task.risks],
          artifactOrCommitReferences: [...task.artifactOrCommitReferences],
          automaticTestReferences: [...task.automaticTestReferences],
          createdAtIso: task.createdAtIso,
        });
      }
    }
    return pending.sort((left, right) => {
      if (left.ownerAgentInstanceId !== right.ownerAgentInstanceId) {
        return left.ownerAgentInstanceId.localeCompare(right.ownerAgentInstanceId);
      }
      return left.taskIdentifier.localeCompare(right.taskIdentifier);
    });
  }

  /**
   * GUI-01-R-03b：人工裁决（签收/否决）。
   * 任务必须属于给定 owner（跨 Agent 访问一律拒绝）；签收绑定上下文图 revision，
   * 图已前进时以 `stale-revision` 失败而不是覆盖。
   */
  async recordVerificationDecision(input: {
    ownerAgentInstanceId: string;
    taskIdentifier: string;
    decision: "accepted" | "rejected";
    reason?: string;
  }): Promise<PublicVerificationDecisionResult> {
    this.assertOpen();
    if (this.stateDirectory === null) {
      throw new PublicApplicationError(
        "verification-unavailable",
        "应用未绑定状态目录，无法裁决核验任务",
      );
    }
    const task =
      await this.runtime.humanVerificationController.readDeferredVerificationTask(
        input.ownerAgentInstanceId,
        input.taskIdentifier,
      );
    if (task === null) {
      throw new PublicApplicationError(
        "verification-not-found",
        "待追认任务不存在或不属于该 Agent: " + input.taskIdentifier,
      );
    }
    const capsules =
      await this.runtime.contextClosureCapsuleStore.listCapsules(
        input.ownerAgentInstanceId,
      );
    const capsule = capsules.find(
      (candidate) => candidate.contentHash === task.closureCapsuleHash,
    );
    if (capsule === undefined) {
      throw new PublicApplicationError(
        "verification-context-missing",
        "未找到待追认任务对应的关闭胶囊: " + input.taskIdentifier,
      );
    }
    const graph = await this.runtime.contextGraphStore.readGraph(
      input.ownerAgentInstanceId,
      capsule.missionId,
    );
    if (graph === null) {
      throw new PublicApplicationError(
        "context-graph-not-found",
        "上下文图不存在，拒绝裁决: " + capsule.missionId,
      );
    }
    try {
      if (input.decision === "accepted") {
        const acceptance =
          await this.runtime.humanVerificationController.recordUserAcceptance({
            ownerAgentInstanceId: input.ownerAgentInstanceId,
            contextGraphRevision: task.contextGraphRevision,
            currentContextGraphRevision: graph.revision,
            nodeIdentifiers: [task.contextNodeIdentifier],
            summaryHash: task.closureCapsuleHash,
            userId: "authenticated-user",
          });
        return {
          ownerAgentInstanceId: input.ownerAgentInstanceId,
          taskIdentifier: input.taskIdentifier,
          decision: "accepted",
          acceptanceIdentifier: acceptance.acceptanceIdentifier,
          reopenedNodeIdentifiers: [],
        };
      }
      const rejection =
        await this.runtime.humanVerificationController.recordUserRejection({
          ownerAgentInstanceId: input.ownerAgentInstanceId,
          graphIdentifier: capsule.missionId,
          allNodeIdentifiers: [task.contextNodeIdentifier],
          reason: input.reason ?? "认证用户否决",
        });
      return {
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        taskIdentifier: input.taskIdentifier,
        decision: "rejected",
        acceptanceIdentifier: null,
        reopenedNodeIdentifiers: [...rejection.reopenedNodeIdentifiers],
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw new PublicApplicationError(error.errorCode, error.message);
      }
      throw error;
    }
  }

  /** 本地存档中的 Agent 目录名（每 Agent 独立存档域；失败即空，不猜测）。 */
  private async listAgentMemoryOwners(): Promise<string[]> {
    if (this.stateDirectory === null) {
      return [];
    }
    try {
      const entries = await fs.readdir(
        path.join(this.stateDirectory, "agent-memory"),
        { withFileTypes: true },
      );
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  // ─── SUM-01-04a：摘要读取的产品入口（工作台/CLI 共用；只读已发布索引） ───

  private async createSummaryIndexStore(): Promise<SummaryIndexStore> {
    if (this.stateDirectory === null) {
      throw new PublicApplicationError(
        "summary-unavailable",
        "应用未绑定状态目录，无法读取摘要索引",
      );
    }
    return new SummaryIndexStore({ baseDirectory: this.stateDirectory });
  }

  private toPublicSummaryChunk(
    chunk: SummaryChunk,
    maximumExcerptCharacters: number,
  ): PublicSummaryChunkView {
    return {
      chunkIdentifier: chunk.chunkIdentifier,
      sourceRevisionFrom: chunk.sourceRevisionFrom,
      sourceRevisionTo: chunk.sourceRevisionTo,
      themeIdentifier: chunk.themeIdentifier,
      excerpt: chunk.summaryText.slice(0, maximumExcerptCharacters),
      isExcerptBounded: chunk.summaryText.length > maximumExcerptCharacters,
      evidencePointers: chunk.evidencePointers.map((pointer) => ({
        sourceIdentifier: pointer.sourceIdentifier,
        sourceRevision: pointer.sourceRevision,
        contentHash: pointer.contentHash,
      })),
    };
  }

  /**
   * 把一个 mission 的真实工作存档（多个 Agent 个体存档）汇总为摘要来源并原子发布。
   * 生成器默认是本地抽取式（`local-extractive-1`，不调用模型）；真实模型生成器由 SUM-02 接入。
   */
  async summarizeArchivedMission(input: {
    missionId: string;
  }): Promise<PublicSummaryBuildResult> {
    this.assertOpen();
    const store = await this.createSummaryIndexStore();
    const { AgentWorkArchiveStore } = await import(
      "./orchestration/work-archive-store.js"
    );
    const archiveStore = new AgentWorkArchiveStore({
      baseDirectory: this.stateDirectory ?? "",
    });
    const agentInstanceIds = await archiveStore.listAgentIdsWithArchive(
      input.missionId,
    );
    const sources: Array<{
      missionId: string;
      agentInstanceId: string;
      entries: Array<{
        archiveEntryId: string;
        recordedAtIso: string;
        taskId: string | null;
        entryType:
          | "assignment"
          | "progress"
          | "decision"
          | "result"
          | "failure"
          | "handoff";
        summary: string;
        artifactReferences: string[];
      }>;
    }> = [];
    for (const agentInstanceId of agentInstanceIds) {
      const archive = await archiveStore.readArchive(
        input.missionId,
        agentInstanceId,
      );
      if (archive === null || archive.entries.length === 0) {
        continue;
      }
      sources.push({
        missionId: input.missionId,
        agentInstanceId,
        entries: archive.entries,
      });
    }
    const entries = buildWorkArchiveSummaryEntries(sources);
    const ownerAgentInstanceId = this.runtime.mainAgentInstanceId;
    const generatorVersion = "local-extractive-1";
    const generation = await advanceSummaryGeneration({
      store,
      agentInstanceId: ownerAgentInstanceId,
      sourceKind: "work-archive",
      sourceIdentifier: input.missionId,
      entries,
      narrativeGenerator: {
        generateNarrative: async (generationInput) =>
          buildLocalExtractiveNarrative(generationInput.facts),
      },
      generatorVersion,
    });
    if (generation.manifest === null) {
      return {
        sourceIdentifier: input.missionId,
        manifestRevision: 0,
        chunkCount: 0,
        coveredThroughSourceRevision: 0,
        entryCount: entries.length,
        generatorVersion,
      };
    }
    return {
      sourceIdentifier: input.missionId,
      manifestRevision: generation.manifest.manifestRevision,
      chunkCount: generation.manifest.chunks.length,
      coveredThroughSourceRevision:
        generation.manifest.coveredThroughSourceRevision,
      entryCount: entries.length,
      generatorVersion,
    };
  }

  /** 列出当前会话 Agent 已发布的摘要来源（不含路径与正文）。 */
  async listSummarySources(): Promise<PublicSummarySourceSummary[]> {
    this.assertOpen();
    const store = await this.createSummaryIndexStore();
    const views = await store.listSourceKeys(this.runtime.mainAgentInstanceId);
    return views.map((view) => ({ ...view }));
  }

  /**
   * 默认摘要读取（四级详细度）。`expectedManifestRevision` 用于翻页一致性：
   * 清单已前进时拒绝，避免把跨 revision 的页拼在一起。
   */
  async readSummaryView(input: {
    sourceIdentifier: string;
    sourceKind?: PublicSummarySourceSummary["sourceKind"];
    detailLevel?: SummaryDetailLevel;
    pageSize?: number;
    pageIndex?: number;
    expectedManifestRevision?: number;
    maximumExcerptCharacters?: number;
    maximumReturnUnitCount?: number;
  }): Promise<PublicSummaryView> {
    this.assertOpen();
    const store = await this.createSummaryIndexStore();
    const key = {
      agentInstanceId: this.runtime.mainAgentInstanceId,
      sourceKind: input.sourceKind ?? ("work-archive" as const),
      sourceIdentifier: input.sourceIdentifier,
    };
    const manifest = await store.readManifest(key);
    if (manifest === null) {
      throw new PublicApplicationError(
        "summary-not-found",
        "没有已发布的摘要来源: " + input.sourceIdentifier,
      );
    }
    if (
      input.expectedManifestRevision !== undefined &&
      input.expectedManifestRevision !== manifest.manifestRevision
    ) {
      throw new PublicApplicationError(
        "stale-cursor",
        "摘要清单已前进（期望 r" +
          String(input.expectedManifestRevision) +
          "，现有 r" +
          String(manifest.manifestRevision) +
          "），请重新取页",
      );
    }
    const detailLevel = input.detailLevel ?? "summary";
    const cursor = createSummaryCursor({
      manifest,
      detailLevel,
      nextChunkIndex: input.pageIndex ?? 0,
    });
    const page = readSummaryPage({
      manifest,
      cursor,
      pageSize: input.pageSize ?? 10,
      chunkReader: createManifestChunkReader(manifest),
      ...(input.maximumReturnUnitCount !== undefined
        ? { maximumReturnUnitCount: input.maximumReturnUnitCount }
        : {}),
    });
    const maximumExcerptCharacters = input.maximumExcerptCharacters ?? 400;
    const { metrics } = await measureSummaryOperation({
      operation: async () => page,
      readManifestFileBytes: async () => store.manifestFileSizeBytes(key),
      extract: (measured) => ({
        chunkCount: manifest.chunks.length,
        narrativeCharacterCount: manifest.narrativeText?.length ?? 0,
        returnedUnitCount: measured.returnedUnitCount,
        sourceAccessCount: 0,
        isReturnBounded: measured.isReturnBounded,
        diskReadOperationCount: 1,
      }),
    });
    return {
      kind: "page",
      sourceIdentifier: input.sourceIdentifier,
      detailLevel,
      manifestRevision: manifest.manifestRevision,
      chunks: page.chunks.map((chunk) =>
        this.toPublicSummaryChunk(chunk, maximumExcerptCharacters),
      ),
      hasMore: page.nextCursor !== null,
      nextPageIndex: page.nextCursor?.nextChunkIndex ?? null,
      coverage: {
        coveredThroughSourceRevision:
          page.coverage.coveredThroughSourceRevision,
        pendingSourceRevisions: [...page.coverage.pendingSourceRevisions],
        chunkCount: page.coverage.chunkCount,
      },
      themeSummaries: page.themeSummaries,
      isReturnBounded: page.isReturnBounded,
      returnedUnitCount: page.returnedUnitCount,
      resourceMetrics: { ...metrics },
    };
  }

  /** 章节展开：定点取一节（有界节选 + 证据指针）。 */
  async expandSummarySectionView(input: {
    sourceIdentifier: string;
    chunkIdentifier: string;
    sourceKind?: PublicSummarySourceSummary["sourceKind"];
    maximumExcerptCharacters?: number;
  }): Promise<PublicSummarySectionView> {
    this.assertOpen();
    const store = await this.createSummaryIndexStore();
    const key = {
      agentInstanceId: this.runtime.mainAgentInstanceId,
      sourceKind: input.sourceKind ?? ("work-archive" as const),
      sourceIdentifier: input.sourceIdentifier,
    };
    const manifest = await store.readManifest(key);
    if (manifest === null) {
      throw new PublicApplicationError(
        "summary-not-found",
        "没有已发布的摘要来源: " + input.sourceIdentifier,
      );
    }
    const chunk = manifest.chunks.find(
      (candidate) => candidate.chunkIdentifier === input.chunkIdentifier,
    );
    if (chunk === undefined) {
      throw new PublicApplicationError(
        "chunk-not-found",
        "摘要清单中不存在该章节: " + input.chunkIdentifier,
      );
    }
    const maximumExcerptCharacters = input.maximumExcerptCharacters ?? 800;
    const { metrics } = await measureSummaryOperation({
      operation: async () => chunk,
      readManifestFileBytes: async () => store.manifestFileSizeBytes(key),
      extract: () => ({
        chunkCount: manifest.chunks.length,
        narrativeCharacterCount: manifest.narrativeText?.length ?? 0,
        returnedUnitCount: chunk.estimatedUnitCount,
        sourceAccessCount: 0,
        isReturnBounded: chunk.summaryText.length > maximumExcerptCharacters,
        diskReadOperationCount: 1,
      }),
    });
    return {
      kind: "section",
      sourceIdentifier: input.sourceIdentifier,
      chunkIdentifier: chunk.chunkIdentifier,
      sourceRevisionFrom: chunk.sourceRevisionFrom,
      sourceRevisionTo: chunk.sourceRevisionTo,
      manifestRevision: manifest.manifestRevision,
      excerpt: chunk.summaryText.slice(0, maximumExcerptCharacters),
      isExcerptBounded: chunk.summaryText.length > maximumExcerptCharacters,
      narrativeExcerpt:
        manifest.narrativeText === null
          ? null
          : manifest.narrativeText.slice(0, maximumExcerptCharacters),
      evidencePointers: chunk.evidencePointers.map((pointer) => ({
        sourceIdentifier: pointer.sourceIdentifier,
        sourceRevision: pointer.sourceRevision,
        contentHash: pointer.contentHash,
      })),
      resourceMetrics: { ...metrics },
    };
  }

  // ─── AUTH-SCOPE-03：范围授权公共入口（预演/单次授权/登记工程根） ───

  /** 列出显式登记的工程根（范围判定唯一依据，不使用 cwd）。 */
  listRegisteredProjectRoots(): Array<{
    projectIdentifier: string;
    rootPath: string;
  }> {
    this.assertOpen();
    return this.runtime.registeredProjectRoots.map((root) => ({ ...root }));
  }

  /** 只读预演：某操作会落到哪个范围、由谁裁决（不消费授权）。 */
  async evaluateOperationScope(input: {
    operationKind:
      | "project-file-write"
      | "project-file-read"
      | "project-build-tool"
      | "dependency-install"
      | "external-software-control"
      | "process-execution"
      | "remote-publish"
      | "backup-deletion"
      | "unknown";
    targetPath?: string | null;
    touchesAdditionalProjectRoots?: boolean;
    hasExternalSideEffects?: boolean;
  }): Promise<PublicOperationScopeEvaluation> {
    this.assertOpen();
    return this.runtime.scopeAuthorizationGate.previewDecision({
      operationKind: input.operationKind,
      targetPath: input.targetPath ?? null,
      ...(input.touchesAdditionalProjectRoots !== undefined
        ? { touchesAdditionalProjectRoots: input.touchesAdditionalProjectRoots }
        : {}),
      ...(input.hasExternalSideEffects !== undefined
        ? { hasExternalSideEffects: input.hasExternalSideEffects }
        : {}),
    });
  }

  /** 认证用户对精确操作授予**单次**范围授权（重放会被拒绝且无副作用）。 */
  async grantScopeAuthorization(input: {
    operationKind:
      | "project-file-write"
      | "project-file-read"
      | "project-build-tool"
      | "dependency-install"
      | "external-software-control"
      | "process-execution"
      | "remote-publish"
      | "backup-deletion"
      | "unknown";
    targetPath?: string | null;
    approvedByUserId: string;
    expiresAtIso?: string | null;
  }): Promise<PublicScopeAuthorizationGrant> {
    this.assertOpen();
    const grant = await this.runtime.scopeAuthorizationGate.grantUserAuthorization({
      operation: {
        operationKind: input.operationKind,
        targetPath: input.targetPath ?? null,
      },
      approvedByUserId: input.approvedByUserId,
      expiresAtIso: input.expiresAtIso ?? null,
    });
    return {
      receiptIdentifier: grant.receiptIdentifier,
      operationFingerprint: grant.operationFingerprint,
      approvedByUserId: input.approvedByUserId,
    };
  }

  /** 查看已产生的范围授权/裁决记录（含消费时间，便于审计重放）。 */
  queryScopeAuthorizations(): Array<{
    receiptIdentifier: string;
    operationFingerprint: string;
    scopeClass: string;
    decision: string;
    adjudicator: string;
    decidedAtIso: string;
    consumedAtIso: string | null;
    approvedByUserId: string | null;
    approvedByAgentInstanceId: string | null;
  }> {
    this.assertOpen();
    return this.runtime.scopeAuthorizationGate
      .listDecisionRecords()
      .map((record) => ({ ...record }));
  }

  // ─── GUIDE-01-04：运行中指导的公共入口（受理 ≠ 已应用；安全点应用） ───

  private readonly guidanceSequenceBySource = new Map<string, number>();

  /**
   * 提交运行中指导：经 GUIDE-01-01 契约校验后进入控制队列。
   * 是否真正改变行为取决于运行中的任务是否在安全点消费（单进程 CLI 调用只会排队）。
   */
  async submitRuntimeGuidance(input: {
    missionIdentifier: string;
    taskIdentifier: string;
    instructionText: string;
    behaviorTier?: PublicGuidanceSubmissionResult["behaviorTier"];
    expiresAtIso?: string | null;
    sourceKind?: "authenticated-user" | "file-task-observation";
  }): Promise<PublicGuidanceSubmissionResult> {
    this.assertOpen();
    const instructionText = input.instructionText.trim();
    if (instructionText === "") {
      throw new PublicApplicationError(
        "invalid-arguments",
        "指导文本为空，拒绝提交",
      );
    }
    const sourceKind = input.sourceKind ?? "authenticated-user";
    const sourceIdentifier =
      sourceKind === "authenticated-user"
        ? this.runtime.authenticatedUserId
        : "local-observation";
    const sequenceKey = sourceKind + "|" + sourceIdentifier;
    const sequence = (this.guidanceSequenceBySource.get(sequenceKey) ?? 0) + 1;
    this.guidanceSequenceBySource.set(sequenceKey, sequence);
    const submittedAtIso = new Date().toISOString();
    const event = buildRuntimeGuidanceEvent({
      guidanceIdentifier:
        "guide-" +
        createHash("sha256")
          .update(
            [input.missionIdentifier, input.taskIdentifier, instructionText, String(sequence)].join("|"),
            "utf8",
          )
          .digest("hex")
          .slice(0, 12),
      guidanceRevision: 1,
      sequence,
      sourceKind,
      sourceIdentifier,
      issuedAtIso: submittedAtIso,
      expiresAtIso: input.expiresAtIso ?? null,
      behaviorTier: input.behaviorTier ?? "safe-point-guidance",
      scope: {
        scopeKind: "task",
        missionIdentifier: input.missionIdentifier,
        taskIdentifier: input.taskIdentifier,
        resourceIdentifier: null,
      },
      instructionText,
    });
    const result = this.runtime.guidanceControlQueue.enqueueControlGuidance({
      event,
      target: {
        missionIdentifier: input.missionIdentifier,
        taskIdentifier: input.taskIdentifier,
        resourceIdentifier: null,
      },
      nowIso: submittedAtIso,
    });
    if (result.status !== "rejected") {
      // 提交必须落盘后才算受理：保证另一个进程/CLI 能查到接收状态。
      await this.runtime.guidanceSubmissionJournal.recordSubmission({
        guidanceIdentifier: event.guidanceIdentifier,
        guidanceRevision: event.guidanceRevision,
        behaviorTier: event.behaviorTier,
        missionIdentifier: input.missionIdentifier,
        taskIdentifier: input.taskIdentifier,
        status: event.behaviorTier === "record-only" ? "applied" : "queued",
        submittedAtIso,
        appliedAtIso: event.behaviorTier === "record-only" ? submittedAtIso : null,
        latencyMilliseconds: event.behaviorTier === "record-only" ? 0 : null,
        dropReason: null,
        isApplicationStatusKnown: event.behaviorTier === "record-only",
      });
    }
    return {
      status: result.status,
      guidanceIdentifier: event.guidanceIdentifier,
      guidanceRevision: event.guidanceRevision,
      behaviorTier: result.behaviorTier,
      reasons: [...result.reasons],
      isDuplicateDelivery: result.isDuplicateDelivery,
      submittedAtIso,
    };
  }

  /**
   * 查看指导接收/应用状态（含安全点应用延迟）。
   * 内存队列（本进程）优先；其余来自跨进程状态日志，未回写时如实标注未知。
   */
  async queryGuidanceStatus(input?: {
    guidanceIdentifier?: string;
  }): Promise<PublicGuidanceStatusEntry[]> {
    this.assertOpen();
    const keyOf = (entry: {
      guidanceIdentifier: string;
      guidanceRevision: number;
    }): string => entry.guidanceIdentifier + "@" + String(entry.guidanceRevision);
    const merged = new Map<string, PublicGuidanceStatusEntry>();
    for (const journalEntry of await this.runtime.guidanceSubmissionJournal.readAll()) {
      merged.set(keyOf(journalEntry), { ...journalEntry });
    }
    for (const memoryEntry of this.runtime.guidanceControlQueue.listGuidanceStatus()) {
      merged.set(keyOf(memoryEntry), {
        ...memoryEntry,
        isApplicationStatusKnown: true,
      });
    }
    const entries = [...merged.values()].sort((left, right) =>
      left.submittedAtIso.localeCompare(right.submittedAtIso),
    );
    if (input?.guidanceIdentifier === undefined) {
      return entries.map((entry) => ({ ...entry }));
    }
    return entries
      .filter((entry) => entry.guidanceIdentifier === input.guidanceIdentifier)
      .map((entry) => ({ ...entry }));
  }

  private async createRecoveryCenterController(): Promise<RecoveryCenterController> {
    if (this.stateDirectory === null) {
      throw new PublicApplicationError(
        "recovery-unavailable",
        "应用未绑定状态目录，无法读取恢复中心",
      );
    }
    if (this.recoveryCenterController === null) {
      const { RecoveryCenterController } = await import(
        "./orchestration/recovery-center-controller.js"
      );
      this.recoveryCenterController = new RecoveryCenterController({
        baseDirectory: this.stateDirectory,
        currentProcessInstanceId: this.runtime.processInstanceId,
      });
    }
    return this.recoveryCenterController;
  }

  /** 按 mission 标识查询权威状态（CLI 与 SDK 共用同一状态源）。 */
  async queryMission(missionIdentifier: string): Promise<PublicMissionState> {
    this.assertOpen();
    const missionStatus = (await this.runtime.controller.queryMissionStatus(
      missionIdentifier,
    )) as {
      summary?: { status?: string } | null;
      taskChain?: { tasks: Array<{ status: string }> } | null;
    };
    return {
      missionIdentifier,
      status: this.mapMissionStatus(missionStatus),
    };
  }

  /**
   * 提交任务：委托调度并返回 accepted + mission 标识；不提前发 task-finished。
   * 同一会话内相同 idempotencyKey 不重复执行；不同会话相互隔离。
   */
  async submitTask(input: {
    sessionId: string;
    taskIdentifier: string;
    prompt: string;
    idempotencyKey?: string;
  }): Promise<PublicTaskResult> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    if (input.idempotencyKey !== undefined) {
      const existingTaskIdentifier = this.taskIdentifierByIdempotencyKey.get(
        input.sessionId + "|" + input.idempotencyKey,
      );
      if (existingTaskIdentifier !== undefined) {
        const existingRecord = this.tasksByTaskIdentifier.get(existingTaskIdentifier);
        if (existingRecord !== undefined) {
          return this.toTaskResult(existingTaskIdentifier, existingRecord);
        }
      }
    }
    const existing = this.tasksByTaskIdentifier.get(input.taskIdentifier);
    if (existing !== undefined) {
      if (existing.sessionId !== input.sessionId) {
        throw new PublicApplicationError(
          "session-mismatch",
          "任务不属于该会话: " + input.taskIdentifier,
        );
      }
      return this.toTaskResult(input.taskIdentifier, existing);
    }
    let missionIdentifier: string;
    try {
      missionIdentifier = await this.runtime.controller.handleUserMessage(input.prompt);
    } catch (error) {
      throw new PublicApplicationError(
        "submit-failed",
        "任务提交失败: " + (error as Error).message,
      );
    }
    this.assertOpen();
    const record: TaskRecord = {
      sessionId: input.sessionId,
      missionIdentifier,
      status: "accepted",
      summaryPreview: null,
      revision: 0,
    };
    this.tasksByTaskIdentifier.set(input.taskIdentifier, record);
    if (input.idempotencyKey !== undefined) {
      this.taskIdentifierByIdempotencyKey.set(
        input.sessionId + "|" + input.idempotencyKey,
        input.taskIdentifier,
      );
    }
    this.emit({
      eventType: "task-status",
      taskIdentifier: input.taskIdentifier,
      status: "accepted",
      revision: record.revision,
      idempotencyId: this.nextEventIdempotencyId(),
    });
    this.startTaskMonitor(input.taskIdentifier);
    return this.toTaskResult(input.taskIdentifier, record);
  }

  /** 查询任务：以本地权威 mission 状态为准（非字符串占位）。 */
  async queryTask(input: {
    sessionId: string;
    taskIdentifier: string;
  }): Promise<PublicTaskResult> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const record = this.requireTask(input.taskIdentifier, input.sessionId);
    if (this.isTerminalStatus(record.status) || record.missionIdentifier === null) {
      return this.toTaskResult(input.taskIdentifier, record);
    }
    const missionStatus = (await this.runtime.controller.queryMissionStatus(
      record.missionIdentifier,
    )) as {
      summary?: { status?: string } | null;
      taskChain?: { tasks: Array<{ status: string }> } | null;
    };
    record.status = this.mapMissionStatus(missionStatus);
    if (this.isTerminalStatus(record.status) && record.summaryPreview === null) {
      await this.captureAuthoritativeResult(record);
    }
    return this.toTaskResult(input.taskIdentifier, record);
  }

  /** 取消任务：委托控制器取消并记录终态。 */
  async cancelTask(input: { sessionId: string; taskIdentifier: string }): Promise<void> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const record = this.requireTask(input.taskIdentifier, input.sessionId);
    if (this.isTerminalStatus(record.status)) {
      return;
    }
    this.stopTaskMonitor(input.taskIdentifier);
    if (record.missionIdentifier !== null) {
      await this.runtime.controller.cancelMission(record.missionIdentifier);
    }
    record.status = "cancelled";
    this.emit({
      eventType: "task-finished",
      taskIdentifier: input.taskIdentifier,
      status: "cancelled",
      revision: record.revision,
      idempotencyId: this.nextEventIdempotencyId(),
    });
  }

  subscribe(listener: (event: PublicAstarrayEvent) => void): { unsubscribe(): void } {
    this.assertOpen();
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** 安全关闭：会话转 closed、订阅释放、运行资源回收。 */
  async shutdown(): Promise<void> {
    if (this.isClosedFlag) {
      return;
    }
    this.isClosedFlag = true;
    for (const [sessionId, state] of this.sessionStates) {
      state.status = "closed";
      this.emit({
        eventType: "session-status",
        sessionId,
        status: "closed",
        revision: this.nextSessionEventRevision(sessionId),
        idempotencyId: this.nextEventIdempotencyId(),
      });
    }
    for (const taskIdentifier of [...this.taskMonitors.keys()]) {
      this.stopTaskMonitor(taskIdentifier);
    }
    await Promise.allSettled([...this.inFlightPolls]);
    this.sessionStates.clear();
    this.tasksByTaskIdentifier.clear();
    this.taskIdentifierByIdempotencyKey.clear();
    this.listeners.clear();
    await this.runtime.shutdown();
  }

  /** 权威状态监视器：只有终态发 task-finished，其余状态发 task-status。 */
  private startTaskMonitor(taskIdentifier: string): void {
    if (this.taskMonitors.has(taskIdentifier)) {
      return;
    }
    const timer = setInterval(() => {
      this.trackPoll(this.pollTaskStatus(taskIdentifier));
    }, this.statusPollIntervalMilliseconds);
    timer.unref?.();
    this.taskMonitors.set(taskIdentifier, timer);
    this.trackPoll(this.pollTaskStatus(taskIdentifier));
  }

  private stopTaskMonitor(taskIdentifier: string): void {
    const timer = this.taskMonitors.get(taskIdentifier);
    if (timer !== undefined) {
      clearInterval(timer);
      this.taskMonitors.delete(taskIdentifier);
    }
  }

  private trackPoll(promise: Promise<void>): void {
    this.inFlightPolls.add(promise);
    void promise.finally(() => {
      this.inFlightPolls.delete(promise);
    });
  }

  private isTerminalStatus(status: PublicTaskStatus): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }

  /** 权威结果存储：终态时从 Agent 工作存档读取 result 条目摘要。 */
  private async captureAuthoritativeResult(record: TaskRecord): Promise<void> {
    if (record.missionIdentifier === null) {
      return;
    }
    try {
      // mission 终态可能先于 Worker 存档写入到达：有界重试，避免结果预览偶发为空。
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const summaries = await this.runtime.readMissionResultSummaries(
          record.missionIdentifier,
        );
        const lastSummary = summaries.at(-1);
        if (lastSummary !== undefined && lastSummary.summary.length > 0) {
          record.summaryPreview = lastSummary.summary;
          return;
        }
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } catch {
      // 结果读取失败不改变已确认的权威状态
    }
  }

  private async pollTaskStatus(taskIdentifier: string): Promise<void> {
    const record = this.tasksByTaskIdentifier.get(taskIdentifier);
    if (record === undefined || record.missionIdentifier === null || this.isClosedFlag) {
      return;
    }
    if (this.isTerminalStatus(record.status)) {
      return;
    }
    let status: PublicTaskStatus;
    try {
      const missionStatus = (await this.runtime.controller.queryMissionStatus(
        record.missionIdentifier,
      )) as {
        summary?: { status?: string } | null;
        taskChain?: { revision?: number; tasks: Array<{ status: string }> } | null;
      };
      const taskChainRevision = missionStatus.taskChain?.revision;
      if (
        typeof taskChainRevision === "number" &&
        Number.isFinite(taskChainRevision) &&
        taskChainRevision > record.revision
      ) {
        record.revision = taskChainRevision;
      }
      status = this.mapMissionStatus(missionStatus);
    } catch {
      status = "blocked";
    }
    if (this.isClosedFlag || status === record.status) {
      return;
    }
    record.status = status;
    if (this.isTerminalStatus(status)) {
      this.stopTaskMonitor(taskIdentifier);
      await this.captureAuthoritativeResult(record);
      if (this.isClosedFlag) {
        return;
      }
      this.emit({
      eventType: "task-finished",
      taskIdentifier,
      status,
      revision: record.revision,
      idempotencyId: this.nextEventIdempotencyId(),
    });
      return;
    }
    this.emit({
      eventType: "task-status",
      taskIdentifier,
      status,
      revision: record.revision,
      idempotencyId: this.nextEventIdempotencyId(),
    });
  }

  private assertOpen(): void {
    if (this.isClosedFlag) {
      throw new PublicApplicationError("application-closed", "应用已关闭");
    }
  }

  private requireSession(sessionId: string): PublicSessionState {
    const state = this.sessionStates.get(sessionId);
    if (state === undefined) {
      throw new PublicApplicationError("session-not-found", "会话不存在: " + sessionId);
    }
    return state;
  }

  private requireTask(taskIdentifier: string, sessionId: string): TaskRecord {
    const record = this.tasksByTaskIdentifier.get(taskIdentifier);
    if (record === undefined) {
      throw new PublicApplicationError("task-not-found", "任务不存在: " + taskIdentifier);
    }
    if (record.sessionId !== sessionId) {
      throw new PublicApplicationError(
        "session-mismatch",
        "任务不属于该会话: " + taskIdentifier,
      );
    }
    return record;
  }

  private mapMissionStatus(missionStatus: {
    summary?: { status?: string } | null;
    taskChain?: { tasks: Array<{ status: string }> } | null;
  }): PublicTaskStatus {
    const summaryStatus = missionStatus.summary?.status ?? "running";
    if (summaryStatus === "done") {
      return "done";
    }
    if (summaryStatus === "cancelled") {
      return "cancelled";
    }
    if (summaryStatus === "failed") {
      return "failed";
    }
    const tasks = missionStatus.taskChain?.tasks ?? [];
    if (tasks.some((task) => task.status === "blocked" || task.status === "failed")) {
      return "blocked";
    }
    return "running";
  }

  private toTaskResult(taskIdentifier: string, record: TaskRecord): PublicTaskResult {
    return {
      taskIdentifier,
      status: record.status,
      missionIdentifier: record.missionIdentifier,
      summaryPreview: record.summaryPreview,
    };
  }

  private eventCounter = 0;
  private readonly sessionEventRevisionBySessionId = new Map<string, number>();

  private nextEventIdempotencyId(): string {
    this.eventCounter += 1;
    return `event-${Date.now().toString(36)}-${this.eventCounter.toString(36)}`;
  }

  private nextSessionEventRevision(sessionId: string): number {
    const nextRevision = (this.sessionEventRevisionBySessionId.get(sessionId) ?? 0) + 1;
    this.sessionEventRevisionBySessionId.set(sessionId, nextRevision);
    return nextRevision;
  }

  private emit(event: PublicAstarrayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不得影响其他订阅者
      }
    }
  }
}
