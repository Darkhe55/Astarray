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

// 装配层内部使用（不是再导出）：把真实用量观测接到账目存储上（2026-10-06 接线）。
import { createProviderUsageLedgerObserver } from "./orchestration/provider-usage-ledger-observer.js";
import { UsageLedgerStore } from "./orchestration/usage-ledger-store.js";
// SMART-01-04：指令窗口与三分钟期限必须由**产品入口**真实驱动（此前只有 re-export 的独立组件）。
import { InstructionWindowStore } from "./orchestration/instruction-window-store.js";
import type { InstructionWindowSnapshot } from "./orchestration/instruction-window-store.js";
import {
  evaluateInstructionDeadline,
  type InstructionDeadlineEvaluation,
} from "./orchestration/main-agent-deadline-supervisor.js";

// ─── Provider 运行时公开入口 ───
// SDK 消费者必须能只用公开 exports 构造 Provider 运行时（不得依赖内部路径），
// 否则 runtime: "provider" 在打包产物上不可用。
// ─── OBS-01 / SMART-01 / PROJECT-01 公开入口（四入口之 SDK）───
// SDK 消费者必须能只用公开 exports 查询性能/用量/诊断概览与跨项目授权（不得依赖内部路径）。
export {
  MINIMUM_SAMPLE_SIZE_FOR_DURATION_REPORTING,
  PerfEventStore,
  aggregatePerfSamples,
  derivePerfAlerts,
  isPerfSampleEvent,
  paginatePerfSamples,
  queryPerfOverview,
  type PerfAggregateMetrics,
  type PerfAlert,
  type PerfAlertKind,
  type PerfEventEnvelope,
  type PerfIntegrityReport,
  type PerfOverflowReport,
  type PerfOverviewQuery,
  type PerfOverviewResult,
  type PerfSampleEvent,
  type PerfSamplePage,
} from "./orchestration/perf-event-store.js";
export {
  UsageLedgerStore,
  aggregateUsageEntries,
  evaluateUsageBudget,
  queryUsageOverview,
  type UsageAggregateMetrics,
  type UsageAppendOutcome,
  type UsageAppendResult,
  type UsageBudgetEvaluation,
  type UsageLedgerEntry,
  type UsageOverviewQuery,
  type UsageOverviewResult,
  type UserFacingUsageMetrics,
} from "./orchestration/usage-ledger-store.js";
export {
  DiagnosticEventStore,
  aggregateDiagnosticEvents,
  buildRedactedDiagnosticBundle,
  computeDiagnosticFingerprint,
  queryDiagnosticSummary,
  redactSensitiveText,
  type DiagnosticAggregateMetrics,
  type DiagnosticEvent,
  type DiagnosticEventClassification,
  type DiagnosticFinding,
  type DiagnosticGroup,
  type DiagnosticRetentionReport,
  type DiagnosticSummary,
  type DiagnosticSummaryQuery,
  type RedactedDiagnosticBundle,
} from "./orchestration/diagnostic-event-store.js";
export {
  InstructionWindowStore,
  type InstructionReceipt,
  type InstructionRecord,
  type InstructionState,
  type InstructionWindowSnapshot,
} from "./orchestration/instruction-window-store.js";
export {
  classifyModelStop,
  extractClarificationAnswer,
  resolveMissingReceipt,
  type ClarificationExtraction,
  type ModelStopClassification,
  type ModelStopClassificationKind,
  type MissingReceiptResolution,
} from "./orchestration/instruction-stop-recovery.js";
export {
  MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
  buildBackfillPlan,
  evaluateInstructionDeadline,
  type BackfillPlan,
  type InstructionDeadlineEvaluation,
  type InstructionDeadlineKind,
} from "./orchestration/main-agent-deadline-supervisor.js";
export {
  CrossProjectAuthorizationStore,
  CrossProjectTransferService,
  evaluateEffectiveCrossProjectPermission,
  summarizeCopyReceipts,
  type CrossProjectAuthorizationRecord,
  type CrossProjectCopyReceipt,
  type CrossProjectPermissionEvaluation,
  type CrossProjectReadResult,
} from "./orchestration/cross-project-authorization-store.js";

export {
  PROVIDER_RUNTIME_CAPABILITIES,
  ProviderConfigurationError,
  ProviderRuntimeRegistry,
  type ProviderRuntimeCapability,
  type ProviderRuntimeConfig,
  type ProviderRuntimeRegistration,
  type ResolvedProviderRuntime,
} from "./runtime/provider-runtime-registry.js";
export {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROTOCOL,
  OPENAI_COMPATIBLE_PROTOCOL_VERSION,
  createOpenAiCompatibleProviderRegistration,
} from "./runtime/openai-compatible-provider-registration.js";
// 多协议装配（2026-10-02）：Anthropic 兼容协议同样必须能从公开 exports 构造，
// 否则 SDK 消费者无法只用公开入口装配 anthropic-messages 运行时
// （此前只有 CLI 侧注册，SDK 入口漏导出 —— 真实实测时暴露）。
export {
  ANTHROPIC_MESSAGES_PROVIDER_ID,
  createAnthropicMessagesProviderRegistration,
} from "./runtime/anthropic-messages-provider-registration.js";
export {
  ANTHROPIC_API_VERSION_HEADER_VALUE,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_MESSAGES_PROTOCOL,
  ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION,
  AnthropicMessagesRuntime,
  buildMessagesRequestBody,
  convertPriorMessagesToAnthropicMessages,
} from "./runtime/anthropic-messages-runtime.js";

import type { AgentMode, AgentRuntime, TaskDependencyNode } from "./core/types.js";
import type { MainController } from "./orchestration/main-controller.js";
import type { PermissionProfileReference } from "./tools/permission-profile-store.js";
import { ProviderConfigurationError } from "./runtime/provider-runtime-registry.js";
import type {
  ProviderRuntimeCapability,
  ProviderRuntimeRegistry,
} from "./runtime/provider-runtime-registry.js";
import type { ApplicationRuntime } from "./application/application-runtime.js";
import type { BackupDeletionAuthorizationControlPort } from "./core/types.js";
import type { InstallationGateUserPort } from "./tools/installation-gate-guard.js";

export type { BackupDeletionAuthorizationControlPort, InstallationGateUserPort };
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
import {
  AccuracyCompletionGate,
  AccuracyPolicyError,
  type AccuracyPolicy,
} from "./orchestration/accuracy-policy-store.js";
import type {
  AcceptanceEntry,
  AccuracyTier,
  CompletionDeclaration,
  EvidenceReference,
} from "./orchestration/task-accuracy-verifier.js";
import type {
  LocalPreservationManifest,
  RemoteSyncFailureClass,
  RemoteSyncStatus,
} from "./orchestration/local-preservation-service.js";

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

// ─── ACCURACY：档位/预算/跳过状态、完成签收校验与幂等日志的公开入口 ───
export {
  ACCURACY_POLICY_SCHEMA_VERSION,
  DEFAULT_ACCURACY_BUDGET,
  AccuracyBudgetTracker,
  AccuracyCompletionGate,
  AccuracyPolicyError,
  AccuracyPolicyStore,
  FileAccuracyAttemptJournal,
  FileAccuracyVerificationAuditLog,
  resolveAccuracyTier,
  type AccuracyBudget,
  type AccuracyBudgetState,
  type AccuracyCompletionGatePorts,
  type AccuracyCompletionVerification,
  type AccuracyPolicy,
  type AccuracyPolicyErrorCode,
  type AccuracyVerificationAuditPort,
  type AccuracyVerificationAuditRecord,
} from "./orchestration/accuracy-policy-store.js";
// ─── READ-FORMAT：读取格式策略、视图回执与注册表（打包离线可用） ───
export {
  DEFAULT_READ_FORMAT_STRATEGIES,
  ReadFormatStrategyRegistry,
  defaultReadFormatStrategyRegistry,
  type ReadFormatStrategy,
  type ReadFormatStrategyCapabilities,
  type ReadViewReceipt,
} from "./tools/read-format/read-format-strategies.js";
// ─── GIT-PRESERVE：远端同步失败后的本地保全（状态/完整性/独立恢复） ───
export {
  LOCAL_PRESERVATION_DEFAULT_EXCLUDED_PATTERNS,
  LOCAL_PRESERVATION_SCHEMA_VERSION,
  LocalPreservationService,
  evaluateRemoteSyncPreservationTrigger,
  type CreateLocalPreservationInput,
  type IncompleteSnapshotDirectory,
  type LocalPreservationCreationResult,
  type LocalPreservationIntegrityReport,
  type LocalPreservationManifest,
  type LocalPreservationRestoreResult,
  type PreserveAfterRemoteSyncOutcomeResult,
  type PreservationTriggerDecision,
  type RemoteSyncFailureClass,
  type RemoteSyncOutcome,
  type RemoteSyncStatus,
  type RestoreLocalPreservationInput,
} from "./orchestration/local-preservation-service.js";
export {
  ACCURACY_TIERS,
  InMemoryAccuracyAttemptJournal,
  TaskAccuracyVerifier,
  type AcceptanceEntry,
  type AcceptanceEvidenceRequirement,
  type AccuracyTier,
  type AccuracyVerificationResult,
  type AccuracyVerifierPorts,
  type CompletionDeclaration,
  type EvidenceKind,
  type EvidenceReference,
} from "./orchestration/task-accuracy-verifier.js";

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

/** GUIDE 增量（用户文档 §6）：指导变更意图裁决结果（复用 GUIDE 接收/应用回执）。 */
export interface PublicGuidanceChangeResult {
  status: "accepted" | "needs-clarification" | "rejected";
  guidanceIdentifier: string;
  changeIntent: "append" | "revise" | "new-task" | null;
  newTaskSequenceRevision: number | null;
  /** new-task 插入任务偏序集后的序列 revision；未插入为 null。 */
  insertedSequenceRevision: number | null;
  invalidatedArtifactIdentifiers: string[];
  invalidatedAcceptanceEntryIdentifiers: string[];
  isDuplicateDelivery: boolean;
  reasons: string[];
  clarificationQuestion: string | null;
  historyEntryCount: number;
}

/** GUIDE 增量：任务变更历史条目（历史指导保留）。 */
export interface PublicGuidanceChangeHistoryEntry {
  taskIdentifier: string;
  taskSequenceRevision: number;
  guidanceIdentifier: string;
  guidanceRevision: number;
  changeIntent: "append" | "revise" | "new-task";
  instructionText: string;
  appliedAtIso: string;
  invalidatedArtifactIdentifiers: string[];
  invalidatedAcceptanceEntryIdentifiers: string[];
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

/** ACCURACY-03：公开准确性策略（revision 用于并发配置校验）。 */
export interface PublicAccuracyPolicy {
  isEnabled: boolean;
  tier: AccuracyTier;
  budget: {
    maximumModelCallCount: number;
    maximumWallClockMilliseconds: number;
  };
  taskTierOverrides: Record<string, AccuracyTier>;
  revision: number;
  updatedByUserId: string;
  updatedAtIso: string;
}

/** ACCURACY-03：公开验收条目（完成声明必须覆盖全部必需条目）。 */
export interface PublicAcceptanceEntry {
  entryIdentifier: string;
  description: string;
  isRequired: boolean;
  evidenceRequirement: AcceptanceEntry["evidenceRequirement"];
}

/** ACCURACY-03：公开证据引用（真实指纹 + 产生时 revision）。 */
export interface PublicEvidenceReference {
  evidenceIdentifier: string;
  entryIdentifier: string;
  evidenceKind: EvidenceReference["evidenceKind"];
  contentHash: string | null;
  producedAtRevision: number;
  producedByAgentInstanceId: string | null;
  observedAtIso: string;
}

/** ACCURACY-03：完成校验结果；跳过状态独立于通过/拒绝。 */
export interface PublicAccuracyVerificationResult {
  verdict: "accepted" | "rejected" | "quality-check-skipped";
  tier: AccuracyTier;
  isSkipped: boolean;
  skipReason: "accuracy-disabled" | "tier-fast" | null;
  budgetStatus: "within-budget" | "quality-check-budget-exhausted";
  reasons: string[];
  isIdempotentReplay: boolean;
}

/** ACCURACY-03：逐次校验审计；`isVerificationLayerInvoked=false` 证明未发起校验层。 */
export interface PublicAccuracyVerificationAuditRecord {
  taskIdentifier: string;
  completionAttemptId: string;
  tier: AccuracyTier;
  verdict: "accepted" | "rejected" | "quality-check-skipped";
  skipReason: "accuracy-disabled" | "tier-fast" | null;
  budgetStatus: "within-budget" | "quality-check-budget-exhausted";
  isVerificationLayerInvoked: boolean;
  observedAtIso: string;
}

/** 单次完成校验的调用上下文（由公共入口输入装配，不驻留于运行时）。 */
interface AccuracyInvocationContext {
  acceptanceEntries: AcceptanceEntry[];
  currentTaskSequenceRevision: number;
  expectedRecipientIdentifier: string;
  currentArtifactRevisions: Record<string, number>;
  isClarificationRequired: boolean;
}

/** GIT-PRESERVE-03：公开保全点状态（不含物理路径与文件内容）。 */
export interface PublicLocalPreservationPoint {
  preservationPointId: string;
  missionId: string;
  status: "ready" | "incomplete" | "failed";
  remoteSyncStatus: RemoteSyncStatus;
  createdAtIso: string;
  restoredAtIso: string | null;
  referenceNames: string[];
  untrackedFileCount: number;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasObjectArchive: boolean;
  integrityFailures: string[];
}

/** GIT-PRESERVE-03：同步结果接线结果（触发判定 + 是否复用快照）。 */
export interface PublicLocalPreservationRecordResult {
  shouldPreserve: boolean;
  isReused: boolean;
  point: PublicLocalPreservationPoint | null;
}

/** GIT-PRESERVE-03：独立恢复结果（恢复到新目录，不依赖原仓库）。 */
export interface PublicLocalPreservationRestoreResult {
  preservationPointId: string;
  restoreDirectoryPath: string;
  restoredUntrackedFilePaths: string[];
  restoredIndexTreeOid: string | null;
  restoredAtIso: string;
  isOriginalRepositoryRequired: boolean;
}

/** GIT-PRESERVE-03：快照完整性报告（缺对象/哈希不一致如实报告）。 */
export interface PublicLocalPreservationIntegrityReport {
  isIntact: boolean;
  missingFilePaths: string[];
  mismatchedFilePaths: string[];
  failures: string[];
  checkedItemCount: number;
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
  /**
   * 工作区根（2026-10-02）：工具写入与**产物对账**共同使用的工作区目录。
   * 缺省为进程 cwd；嵌入方（含测试）应显式指定，避免写入宿主仓库。
   */
  workspaceRootPath?: string;
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
  /**
   * T04：是否启用独立反馈进程。缺省 false（嵌入方自担进程拓扑；mock 测试保持离线）；
   * 产品入口（CLI run / GUI）应在真实 Provider 运行时显式开启，禁止退化为进程内定时器。
   */
  useFeedbackProcess?: boolean;
  /** T04：反馈进程入口模块路径；缺省按包内 dist 入口自动解析。 */
  feedbackProcessModulePath?: string | null;
  /**
   * 检查点 B：可信认证用户标识。缺省取宿主用户上下文；两者都不可用时为 null，
   * 此时需要人工授权的操作一律 fail-closed（不再伪造固定 "sdk-user"）。
   */
  authenticatedUserId?: string | null;
  /** 检查点 B：主 Agent 实例 ID；缺省逐运行时唯一生成。 */
  mainAgentInstanceId?: string;
  /** 检查点 B：删除备份的交互授权端口（协同模式逐次授权；缺端口即拒绝且不等待）。 */
  backupDeletionControlPort?: BackupDeletionAuthorizationControlPort | null;
  /** 检查点 B：安装交互端口（询问已有资源 + 精确计划逐次授权；缺端口即拒绝且不等待）。 */
  installationUserPort?: InstallationGateUserPort | null;
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

/**
 * 任务提交幂等账目（RELIABILITY-01-02 · R4，2026-10-02）。
 *
 * 语义：同一 `(sessionId, idempotencyKey)` 绑定**规范化完整参数哈希**；
 *  - 同键同参 → 复用已受理结果（含重启后）；
 *  - **同键异参 → 拒绝**（`idempotency-key-conflict`）；
 *  - 同键并发 → 只有第一个取得 claim，其余按 `idempotency-claim-pending` 拒绝
 *    （**不**双执行，也**不**假定成功）；
 *  - claim 在**任何 await 之前**建立并落盘，消除"检查-登记"之间的并发窗口。
 */
interface TaskIdempotencyLedgerEntry {
  sessionIdentifier: string;
  idempotencyKey: string;
  /** 规范化完整参数哈希（同键异参据此拒绝）。 */
  inputHash: string;
  taskIdentifier: string;
  missionIdentifier: string | null;
  claimedAtIso: string;
  settledAtIso: string | null;
}

/** 解析幂等账目文件（容错：结构非法视为空账目，不伪造历史）。 */
export function parseTaskIdempotencyLedger(rawText: string): TaskIdempotencyLedgerEntry[] {
  try {
    const parsed = JSON.parse(rawText) as {
      schemaVersion?: unknown;
      entries?: unknown;
    };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }
    const entries: TaskIdempotencyLedgerEntry[] = [];
    for (const rawEntry of parsed.entries) {
      if (rawEntry === null || typeof rawEntry !== "object") {
        continue;
      }
      const record = rawEntry as Record<string, unknown>;
      if (
        typeof record.sessionIdentifier !== "string" ||
        typeof record.idempotencyKey !== "string" ||
        typeof record.inputHash !== "string" ||
        typeof record.taskIdentifier !== "string" ||
        typeof record.claimedAtIso !== "string"
      ) {
        continue;
      }
      entries.push({
        sessionIdentifier: record.sessionIdentifier,
        idempotencyKey: record.idempotencyKey,
        inputHash: record.inputHash,
        taskIdentifier: record.taskIdentifier,
        missionIdentifier:
          typeof record.missionIdentifier === "string" ? record.missionIdentifier : null,
        claimedAtIso: record.claimedAtIso,
        settledAtIso: typeof record.settledAtIso === "string" ? record.settledAtIso : null,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/** 从状态目录加载幂等账目（缺文件/损坏 → 空账目，绝不伪造历史）。 */
export async function loadTaskIdempotencyLedger(
  stateDirectory: string | undefined,
): Promise<TaskIdempotencyLedgerEntry[]> {
  if (stateDirectory === undefined || stateDirectory === "") {
    return [];
  }
  const filePath = path.join(stateDirectory, "task-idempotency-ledger.json");
  try {
    const rawText = await fs.readFile(filePath, "utf8");
    return parseTaskIdempotencyLedger(rawText);
  } catch {
    return [];
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
        /**
         * 真实用量观测（2026-10-06 接线）：装配层掌握状态目录，因此由这里构造
         * "账目观测者"并交给运行时；运行时只上报事实。
         * 此前该端口无人提供，`usage/entries.json` 在生产路径上永远为空。
         */
        const providerUsageObserver = createProviderUsageLedgerObserver({
          store: new UsageLedgerStore({ baseDirectory: options.stateDirectory }),
        });
        const resolved = await registry.resolveRuntime({
          providerId: provider.providerId,
          modelIdentifier: provider.modelIdentifier,
          allowedModelIdentifiers: provider.allowedModelIdentifiers,
          requiredCapabilities: provider.requiredCapabilities,
          baseUrl: provider.baseUrl ?? null,
          protectedCredentialReferenceId:
            provider.protectedCredentialReferenceId ?? null,
          requestTimeoutMilliseconds: provider.requestTimeoutMilliseconds,
          providerRequestUsageObserver: providerUsageObserver,
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
      // T04：正式任务运行路径（真实 Provider）默认启用独立反馈进程；
      // mock 离线路径保持进程内，嵌入方可用 useFeedbackProcess 显式覆盖。
      runtimeKind,
      useFeedbackProcess: options.useFeedbackProcess ?? runtimeKind === "provider",
      streamOutput: options.streamOutput ?? (() => {}),
      backupDeletionControlPort: options.backupDeletionControlPort ?? null,
      installationUserPort: options.installationUserPort ?? null,
      authenticatedUserId: options.authenticatedUserId,
      mainAgentInstanceId: options.mainAgentInstanceId,
      feedbackProcessModulePath: options.feedbackProcessModulePath ?? null,
      mainRuntimeFactory,
      workerRuntimeFactory,
      requireCompletionControlEvent: runtimeKind === "provider",
      // 产物对账使用与工具写入一致的工作区根（缺省仓库/进程 cwd）。
      ...(options.workspaceRootPath === undefined
        ? {}
        : { artifactWorkspaceRootPath: options.workspaceRootPath }),
      ...(options.workspaceRootPath === undefined
        ? {}
        : { workspaceRootPath: options.workspaceRootPath }),
    });
    return new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: options.statusPollIntervalMilliseconds ?? 25,
      stateDirectory: options.stateDirectory,
      // 幂等账目跨进程持久化（R4）：重启后同键同参复用，不重复执行。
      idempotencyLedgerEntries: await loadTaskIdempotencyLedger(
        options.stateDirectory,
      ),
    });
  }

  constructor(
    private readonly runtime: ApplicationRuntime,
    options: {
      statusPollIntervalMilliseconds?: number;
      stateDirectory?: string;
      idempotencyLedgerEntries?: TaskIdempotencyLedgerEntry[];
    } = {},
  ) {
    this.statusPollIntervalMilliseconds =
      options.statusPollIntervalMilliseconds ?? 25;
    this.stateDirectory = options.stateDirectory ?? null;
    this.idempotencyLedgerFilePath =
      this.stateDirectory === null
        ? null
        : path.join(this.stateDirectory, "task-idempotency-ledger.json");
    for (const entry of options.idempotencyLedgerEntries ?? []) {
      this.taskIdempotencyLedger.set(
        entry.sessionIdentifier + "|" + entry.idempotencyKey,
        entry,
      );
    }
  }

  /** 幂等账目是否已持久化（无状态目录时为 false，调用方须按未持久化处理）。 */
  private async persistTaskIdempotencyLedger(): Promise<void> {
    const filePath = this.idempotencyLedgerFilePath;
    if (filePath === null) {
      return;
    }
    const { writeAtomicJson } = await import("./infra/atomic-json.js");
    await writeAtomicJson(filePath, {
      schemaVersion: 1,
      entries: [...this.taskIdempotencyLedger.values()],
    });
  }

  /**
   * 规范化**任务内容**哈希（同键异参据此拒绝）。
   *
   * 只纳入任务内容（prompt）：`taskIdentifier` 是本地受理标识，不同标识但同内容
   * 属同一逻辑请求；改内容则是不同参数 → 拒绝（RELIABILITY-01-02 · R4）。
   */
  private computeTaskSubmissionInputHash(input: { prompt: string }): string {
    return createHash("sha256").update(input.prompt).digest("hex");
  }

  /**
   * T04/T07：公开诊断面（只读、无秘密）。
   * 供产品入口与测试确认反馈传输是否为独立进程、以及是否强制完成控制事件。
   */
  getRuntimeDiagnostics(): {
    runtimeKind: "mock" | "provider";
    isFeedbackProcessIndependent: boolean;
    requiresCompletionControlEvent: boolean;
    hasBackupDeletionControlPort: boolean;
    hasInstallationUserPort: boolean;
    authenticatedUserSource: "explicit" | "host" | "absent";
    authenticatedUserId: string | null;
    mainAgentInstanceId: string;
  } {
    return {
      runtimeKind: this.runtime.runtimeKind,
      isFeedbackProcessIndependent: this.runtime.isFeedbackProcessIndependent,
      requiresCompletionControlEvent: this.runtime.requiresCompletionControlEvent,
      hasBackupDeletionControlPort: this.runtime.hasBackupDeletionControlPort,
      hasInstallationUserPort: this.runtime.hasInstallationUserPort,
      authenticatedUserSource: this.runtime.authenticatedUserSource,
      authenticatedUserId: this.runtime.authenticatedUserId,
      mainAgentInstanceId: this.runtime.mainAgentInstanceId,
    };
  }

  /** 检查点 B：需要人工授权/归属的公共操作必须先取得可信身份，否则立即拒绝（不等待）。 */
  private requireAuthenticatedUserId(): string {
    const identifier = this.runtime.authenticatedUserId;
    if (identifier === null) {
      throw new PublicApplicationError(
        "authenticated-user-required",
        "缺少可信认证身份，拒绝需要人工授权的操作",
      );
    }
    return identifier;
  }

  private readonly stateDirectory: string | null;
  private recoveryCenterController: RecoveryCenterController | null = null;

  private readonly sessionStates = new Map<string, PublicSessionState>();
  private readonly tasksByTaskIdentifier = new Map<string, TaskRecord>();
  /** 幂等账目（内存镜像；键 = `sessionId|idempotencyKey`）。 */
  private readonly taskIdempotencyLedger = new Map<string, TaskIdempotencyLedgerEntry>();
  private readonly idempotencyLedgerFilePath: string | null;
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

  /**
   * 用户 `allow-once` 后重新登记作用域一次性授权（修复 2026-10-01）：
   * 被权限询问拦下的那次尝试会消耗该操作指纹的授权，重跑需要重新登记一次，
   * 否则重跑命中 `auth-scope-replay-rejected`（内层工具不执行）。
   * 重放保护不变（同一指纹第二次重放仍被拒）。
   */
  async grantScopeAuthorizationForToolCall(input: {
    toolName: string;
    argumentsJson: string;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string } | null> {
    return this.runtime.controller.grantScopeAuthorizationForToolCall(input);
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
        ? this.requireAuthenticatedUserId()
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

  // ─── ACCURACY-03：档位/预算/跳过状态的产品入口（默认标准档；仅认证用户可配置） ───

  private accuracyCompletionGate: AccuracyCompletionGate | null = null;
  private accuracyInvocationContext: AccuracyInvocationContext | null = null;

  private toPublicAccuracyPolicy(policy: AccuracyPolicy): PublicAccuracyPolicy {
    return {
      isEnabled: policy.isEnabled,
      tier: policy.tier,
      budget: { ...policy.budget },
      taskTierOverrides: { ...policy.taskTierOverrides },
      revision: policy.revision,
      updatedByUserId: policy.updatedByUserId,
      updatedAtIso: policy.updatedAtIso,
    };
  }

  private requireAccuracyInvocationContext(): AccuracyInvocationContext {
    if (this.accuracyInvocationContext === null) {
      throw new PublicApplicationError(
        "accuracy-invocation-missing",
        "完成校验缺少本次调用的验收上下文",
      );
    }
    return this.accuracyInvocationContext;
  }

  /** 复用同一门实例：预算与幂等在同一进程内累计，不因多次调用重置。 */
  private createAccuracyCompletionGate(): AccuracyCompletionGate {
    if (this.accuracyCompletionGate === null) {
      this.accuracyCompletionGate = new AccuracyCompletionGate({
        policyStore: this.runtime.accuracyPolicyStore,
        journal: this.runtime.accuracyAttemptJournal,
        auditLog: this.runtime.accuracyVerificationAuditLog,
        ports: {
          getAcceptanceEntries: async () =>
            this.requireAccuracyInvocationContext().acceptanceEntries,
          getCurrentTaskSequenceRevision: async () =>
            this.requireAccuracyInvocationContext().currentTaskSequenceRevision,
          getExpectedRecipientIdentifier: async () =>
            this.requireAccuracyInvocationContext().expectedRecipientIdentifier,
          getArtifactRevision: async (evidence) =>
            this.requireAccuracyInvocationContext().currentArtifactRevisions[
              evidence.evidenceIdentifier
            ] ?? null,
          isClarificationRequired: async () =>
            this.requireAccuracyInvocationContext().isClarificationRequired,
        },
      });
    }
    return this.accuracyCompletionGate;
  }

  /** 读取当前准确性策略（默认标准档 + 预算上界；关闭状态如实返回）。 */
  async queryAccuracyPolicy(): Promise<PublicAccuracyPolicy> {
    this.assertOpen();
    return this.toPublicAccuracyPolicy(
      await this.runtime.accuracyPolicyStore.readPolicy(),
    );
  }

  /**
   * 配置准确性策略：仅认证用户可调用；`requestingAgentInstanceId` 非空表示 Agent 请求，
   * 降级或关闭会被拒绝（`accuracy-tier-downgrade-rejected`）。
   */
  async configureAccuracyPolicy(input: {
    tier?: AccuracyTier;
    isEnabled?: boolean;
    maximumModelCallCount?: number;
    maximumWallClockMilliseconds?: number;
    taskTierOverrides?: Record<string, AccuracyTier>;
    expectedRevision: number;
    updatedByUserId?: string;
    requestingAgentInstanceId?: string | null;
  }): Promise<PublicAccuracyPolicy> {
    this.assertOpen();
    try {
      const policy = await this.runtime.accuracyPolicyStore.configurePolicy({
        tier: input.tier,
        isEnabled: input.isEnabled,
        budget: {
          ...(input.maximumModelCallCount === undefined
            ? {}
            : { maximumModelCallCount: input.maximumModelCallCount }),
          ...(input.maximumWallClockMilliseconds === undefined
            ? {}
            : { maximumWallClockMilliseconds: input.maximumWallClockMilliseconds }),
        },
        taskTierOverrides: input.taskTierOverrides,
        expectedRevision: input.expectedRevision,
        updatedByUserId: input.updatedByUserId ?? this.requireAuthenticatedUserId(),
        requestingAgentInstanceId: input.requestingAgentInstanceId ?? null,
      });
      return this.toPublicAccuracyPolicy(policy);
    } catch (error) {
      if (error instanceof AccuracyPolicyError) {
        throw new PublicApplicationError(error.errorCode, error.message);
      }
      throw error;
    }
  }

  /**
   * 校验完成声明：关闭时返回 `quality-check-skipped(accuracy-disabled)` 且不发起校验层；
   * 标准/严格档受预算约束；同一 `completionAttemptId` 重放返回既有结论。
   */
  async verifyTaskCompletion(input: {
    taskIdentifier: string;
    completionAttemptId: string;
    taskSequenceRevision: number;
    completedEntryIdentifiers: string[];
    evidenceReferences: PublicEvidenceReference[];
    deliveredToRecipientIdentifier: string;
    understandingConfirmation?: { restatedGoal: string; confirmedAtIso: string } | null;
    acceptanceEntries: PublicAcceptanceEntry[];
    currentArtifactRevisions?: Record<string, number>;
    currentTaskSequenceRevision?: number;
    expectedRecipientIdentifier?: string;
    isClarificationRequired?: boolean;
  }): Promise<PublicAccuracyVerificationResult> {
    this.assertOpen();
    const declaration: CompletionDeclaration = {
      taskIdentifier: input.taskIdentifier,
      completionAttemptId: input.completionAttemptId,
      taskSequenceRevision: input.taskSequenceRevision,
      completedEntryIdentifiers: [...input.completedEntryIdentifiers],
      evidenceReferences: input.evidenceReferences.map((evidence) => ({ ...evidence })),
      understandingConfirmation: input.understandingConfirmation ?? null,
      deliveredToRecipientIdentifier: input.deliveredToRecipientIdentifier,
    };
    this.accuracyInvocationContext = {
      acceptanceEntries: input.acceptanceEntries.map((entry) => ({ ...entry })),
      currentTaskSequenceRevision:
        input.currentTaskSequenceRevision ?? input.taskSequenceRevision,
      expectedRecipientIdentifier:
        input.expectedRecipientIdentifier ?? this.requireAuthenticatedUserId(),
      currentArtifactRevisions: { ...(input.currentArtifactRevisions ?? {}) },
      isClarificationRequired: input.isClarificationRequired ?? false,
    };
    try {
      const result = await this.createAccuracyCompletionGate().verifyCompletion({
        declaration,
      });
      return {
        verdict: result.verdict,
        tier: result.tier,
        isSkipped: result.isSkipped,
        skipReason: result.skipReason,
        budgetStatus: result.budgetStatus,
        reasons: [...result.reasons],
        isIdempotentReplay: result.verification?.isIdempotentReplay ?? false,
      };
    } finally {
      this.accuracyInvocationContext = null;
    }
  }

  /** 读取逐次校验审计（跨进程）；用于证明关闭/跳过时未发起校验层。 */
  async queryAccuracyVerificationAudit(input?: {
    taskIdentifier?: string;
  }): Promise<PublicAccuracyVerificationAuditRecord[]> {
    this.assertOpen();
    const records = await this.createAccuracyCompletionGate().readVerificationAudit();
    const selected =
      input?.taskIdentifier === undefined
        ? records
        : records.filter(
            (record) => record.taskIdentifier === input.taskIdentifier,
          );
    return selected.map((record) => ({ ...record }));
  }

  // ─── GIT-PRESERVE-03：本地保全产品入口（状态/完整性/独立恢复） ───

  private toPublicLocalPreservationPoint(
    manifest: LocalPreservationManifest,
  ): PublicLocalPreservationPoint {
    return {
      preservationPointId: manifest.preservationPointId,
      missionId: manifest.missionId,
      status: manifest.localPreservation.status,
      remoteSyncStatus: manifest.remoteSync.status,
      createdAtIso: manifest.createdAtIso,
      restoredAtIso: manifest.restoredAtIso,
      referenceNames: manifest.repository.referenceOids.map(
        (reference) => reference.referenceName,
      ),
      untrackedFileCount: manifest.untrackedFiles.length,
      hasStagedChanges: manifest.index.cachedPatchPath !== null,
      hasUnstagedChanges: manifest.worktreeChanges.unstagedPatchPath !== null,
      hasObjectArchive: manifest.objectArchive.filePath !== null,
      integrityFailures: [...manifest.localPreservation.integrityResult.failures],
    };
  }

  /**
   * 上报远端同步结果：失败（网络/缺远端/认证/拒绝/未知）立即生成或复用本地保全点；
   * 成功或未失败不保全。触发判定与快照都在本地确定性代码中完成。
   */
  async recordRemoteSyncOutcome(input: {
    missionId: string;
    repositoryPath: string;
    worktreePath?: string | null;
    reason: string;
    syncStatus: RemoteSyncStatus;
    remoteName?: string | null;
    branchName?: string | null;
    attemptCount?: number;
    observedFailureMessage?: string | null;
  }): Promise<PublicLocalPreservationRecordResult> {
    this.assertOpen();
    const result =
      await this.runtime.localPreservationService.preserveAfterRemoteSyncOutcome({
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        worktreePath: input.worktreePath ?? null,
        reason: input.reason,
        remoteSyncOutcome: {
          status: input.syncStatus,
          remoteName: input.remoteName ?? null,
          branchName: input.branchName ?? null,
          attemptCount: input.attemptCount ?? 1,
          lastFailureClass: input.syncStatus.startsWith("failed-")
            ? (input.syncStatus as RemoteSyncFailureClass)
            : null,
          observedAtIso: new Date().toISOString(),
          observedFailureMessage: input.observedFailureMessage ?? null,
        },
      });
    return {
      shouldPreserve: result.shouldPreserve,
      isReused: result.isReused,
      point:
        result.manifest === null
          ? null
          : this.toPublicLocalPreservationPoint(result.manifest),
    };
  }

  async listLocalPreservationPoints(
    missionId: string,
  ): Promise<PublicLocalPreservationPoint[]> {
    this.assertOpen();
    const manifests =
      await this.runtime.localPreservationService.listPreservationPoints(missionId);
    return manifests.map((manifest) =>
      this.toPublicLocalPreservationPoint(manifest),
    );
  }

  async readLocalPreservationPoint(input: {
    missionId: string;
    preservationPointId: string;
  }): Promise<PublicLocalPreservationPoint> {
    this.assertOpen();
    return this.toPublicLocalPreservationPoint(
      await this.callPreservationOperation(() =>
        this.runtime.localPreservationService.readPreservationPoint(
          input.missionId,
          input.preservationPointId,
        ),
      ),
    );
  }

  async verifyLocalPreservationIntegrity(input: {
    missionId: string;
    preservationPointId: string;
  }): Promise<PublicLocalPreservationIntegrityReport> {
    this.assertOpen();
    const report = await this.callPreservationOperation(() =>
      this.runtime.localPreservationService.verifyPreservationPointIntegrity(
        input,
      ),
    );
    return {
      isIntact: report.isIntact,
      missingFilePaths: [...report.missingFilePaths],
      mismatchedFilePaths: [...report.mismatchedFilePaths],
      failures: [...report.failures],
      checkedItemCount: report.checkedItemCount,
    };
  }

  /** 独立恢复到新目录（拒绝覆盖非空目标；不依赖原仓库）。 */
  async restoreLocalPreservationPoint(input: {
    missionId: string;
    preservationPointId: string;
    restoreDirectoryPath: string;
  }): Promise<PublicLocalPreservationRestoreResult> {
    this.assertOpen();
    const result = await this.callPreservationOperation(() =>
      this.runtime.localPreservationService.restorePreservationPoint(input),
    );
    return {
      preservationPointId: result.preservationPointId,
      restoreDirectoryPath: result.restoreDirectoryPath,
      restoredUntrackedFilePaths: [...result.restoredUntrackedFilePaths],
      restoredIndexTreeOid: result.restoredIndexTreeOid,
      restoredAtIso: result.restoredAtIso,
      isOriginalRepositoryRequired: result.isOriginalRepositoryRequired,
    };
  }

  private async callPreservationOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) {
        throw new PublicApplicationError(error.errorCode, error.message);
      }
      throw error;
    }
  }

  // ─── GUIDE 增量：追加/修订/新建任务的变更意图（复用 GUIDE-01 接收/应用回执） ───

  /**
   * 提交指导变更：必须显式 changeIntent；未明确且可能改变目标/范围 → 澄清，
   * 不静默替换旧目标。接受时复用 GUIDE-01 控制队列（受理 ≠ 已应用）。
   */
  async submitGuidanceChange(input: {
    missionIdentifier: string;
    taskIdentifier: string | null;
    instructionText: string;
    changeIntent: "append" | "revise" | "new-task" | null;
    requestedTaskSequenceRevision: number;
    newTaskIdentifier?: string | null;
    derivedTaskPriorityTier?: number;
    invalidatedArtifactIdentifiers?: string[];
    invalidatedAcceptanceEntryIdentifiers?: string[];
    behaviorTier?: PublicGuidanceSubmissionResult["behaviorTier"];
    /** new-task 必填：插入目标（次级 agentInstanceId + 序列 + 观察 revision + 锚点）。 */
    insertionTarget?: {
      ownerAgentInstanceId: string;
      sequenceId: string;
      expectedSequenceRevision: number;
      predecessorTaskIds?: string[];
      successorTaskIds?: string[];
    } | null;
    insertionTaskTitle?: string | null;
  }): Promise<PublicGuidanceChangeResult> {
    this.assertOpen();
    const guidanceIdentifier =
      "guide-change-" +
      createHash("sha256")
        .update(
          [
            input.missionIdentifier,
            input.taskIdentifier ?? "",
            input.changeIntent ?? "unclear",
            input.instructionText,
            String(input.requestedTaskSequenceRevision),
            input.newTaskIdentifier ?? "",
          ].join("|"),
          "utf8",
        )
        .digest("hex")
        .slice(0, 12);
    let insertedSequenceRevision: number | null = null;
    if (input.changeIntent === "new-task") {
      if (input.insertionTarget === null || input.insertionTarget === undefined) {
        return {
          status: "needs-clarification",
          guidanceIdentifier,
          changeIntent: "new-task",
          newTaskSequenceRevision: null,
          invalidatedArtifactIdentifiers: [],
          invalidatedAcceptanceEntryIdentifiers: [],
          isDuplicateDelivery: false,
          reasons: [
            "needs-clarification: 新建任务必须指定所属次级与任务序列（插入偏序集）",
          ],
          clarificationQuestion:
            "新任务应插入哪个次级 agentInstanceId 的哪个任务序列？观察到的序列 revision 是多少？",
          historyEntryCount: 0,
          insertedSequenceRevision: null,
        };
      }
      if (
        input.newTaskIdentifier !== null &&
        input.newTaskIdentifier !== undefined &&
        input.newTaskIdentifier.trim() !== ""
      ) {
        try {
          const insertedDocument =
            await this.runtime.taskSequenceManageController.insertTask({
              ownerAgentInstanceId: input.insertionTarget.ownerAgentInstanceId,
              actor: {
                sourceKind: "user",
                actorId: this.requireAuthenticatedUserId(),
              },
              sequenceId: input.insertionTarget.sequenceId,
              expectedRevision: input.insertionTarget.expectedSequenceRevision,
              task: {
                taskId: input.newTaskIdentifier,
                title:
                  input.insertionTaskTitle ??
                  input.instructionText.slice(0, 120),
                priorityTier: input.derivedTaskPriorityTier ?? 0,
                externalReference: guidanceIdentifier,
              },
              anchor: {
                predecessorTaskIds:
                  input.insertionTarget.predecessorTaskIds ?? [],
                successorTaskIds:
                  input.insertionTarget.successorTaskIds ?? [],
              },
            });
          insertedSequenceRevision = insertedDocument.revision;
        } catch (error) {
          return {
            status: "rejected",
            guidanceIdentifier,
            changeIntent: "new-task",
            newTaskSequenceRevision: null,
            invalidatedArtifactIdentifiers: [],
            invalidatedAcceptanceEntryIdentifiers: [],
            isDuplicateDelivery: false,
            reasons: ["task-insertion-failed: " + (error as Error).message],
            clarificationQuestion: null,
            historyEntryCount: 0,
            insertedSequenceRevision: null,
          };
        }
      }
    }

    const decision = this.runtime.guidanceChangeIntentController.applyChange({
      guidanceIdentifier,
      guidanceRevision: 1,
      changeIntent: input.changeIntent,
      targetTaskIdentifier: input.taskIdentifier,
      newTaskIdentifier: input.newTaskIdentifier ?? null,
      instructionText: input.instructionText,
      requestedTaskSequenceRevision: input.requestedTaskSequenceRevision,
      derivedTaskPriorityTier: input.derivedTaskPriorityTier ?? 1,
      invalidatedArtifactIdentifiers: input.invalidatedArtifactIdentifiers,
      invalidatedAcceptanceEntryIdentifiers:
        input.invalidatedAcceptanceEntryIdentifiers,
      sourceKind: "authenticated-user",
      sourceIdentifier: this.requireAuthenticatedUserId(),
    });
    await this.runtime.guidanceChangeIntentJournal.write(
      this.runtime.guidanceChangeIntentController.snapshot(),
    );
    if (decision.status === "accepted" && input.taskIdentifier !== null) {
      await this.submitRuntimeGuidance({
        missionIdentifier: input.missionIdentifier,
        taskIdentifier: input.taskIdentifier,
        instructionText: input.instructionText,
        behaviorTier: input.behaviorTier ?? "safe-point-guidance",
      });
    }
    return {
      status: decision.status,
      guidanceIdentifier: decision.guidanceIdentifier,
      changeIntent: decision.changeIntent,
      newTaskSequenceRevision: decision.newTaskSequenceRevision,
      insertedSequenceRevision,
      invalidatedArtifactIdentifiers: [...decision.invalidatedArtifactIdentifiers],
      invalidatedAcceptanceEntryIdentifiers: [
        ...decision.invalidatedAcceptanceEntryIdentifiers,
      ],
      isDuplicateDelivery: decision.isDuplicateDelivery,
      reasons: [...decision.reasons],
      clarificationQuestion: decision.clarificationQuestion,
      historyEntryCount: decision.historyEntryCount,
    };
  }

  /** 任务变更历史（追加/修订保留历史，供审计与旧声明核对）。 */
  async queryGuidanceChangeHistory(
    taskIdentifier: string,
  ): Promise<PublicGuidanceChangeHistoryEntry[]> {
    this.assertOpen();
    return this.runtime.guidanceChangeIntentController
      .readHistory(taskIdentifier)
      .map((entry) => ({
        taskIdentifier: entry.taskIdentifier,
        taskSequenceRevision: entry.taskSequenceRevision,
        guidanceIdentifier: entry.guidanceIdentifier,
        guidanceRevision: entry.guidanceRevision,
        changeIntent: entry.changeIntent,
        instructionText: entry.instructionText,
        appliedAtIso: entry.appliedAtIso,
        invalidatedArtifactIdentifiers: [
          ...entry.invalidatedArtifactIdentifiers,
        ],
        invalidatedAcceptanceEntryIdentifiers: [
          ...entry.invalidatedAcceptanceEntryIdentifiers,
        ],
      }));
  }

  /** 旧完成声明（revision 落后于当前）在指导变更使 revision 变化后失效。 */
  async isTaskCompletionDeclarationStillValid(input: {
    taskIdentifier: string;
    declaredTaskSequenceRevision: number;
  }): Promise<boolean> {
    this.assertOpen();
    return this.runtime.guidanceChangeIntentController.isCompletionDeclarationStillValid(
      input,
    );
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
    /**
     * 幂等 claim（R4，2026-10-02）：**在任何 await 之前**完成
     * "查账目 → 判同键异参 → 登记 pending claim"，消除检查-登记之间的并发窗口。
     */
    const ledgerKey =
      input.idempotencyKey === undefined
        ? null
        : input.sessionId + "|" + input.idempotencyKey;
    const submissionInputHash = this.computeTaskSubmissionInputHash({
      prompt: input.prompt,
    });
    if (ledgerKey !== null && input.idempotencyKey !== undefined) {
      const existingEntry = this.taskIdempotencyLedger.get(ledgerKey);
      if (existingEntry !== undefined) {
        if (existingEntry.inputHash !== submissionInputHash) {
          throw new PublicApplicationError(
            "idempotency-key-conflict",
            "同一 idempotencyKey 绑定了不同参数，拒绝复用: " + String(input.idempotencyKey),
          );
        }
        if (existingEntry.missionIdentifier === null) {
          // 已 claim 未结算：不重复执行，也不假定成功。
          throw new PublicApplicationError(
            "idempotency-claim-pending",
            "同一 idempotencyKey 的提交仍在进行中，未重复执行: " + String(input.idempotencyKey),
          );
        }
        const settledRecord = this.tasksByTaskIdentifier.get(existingEntry.taskIdentifier);
        if (settledRecord !== undefined) {
          return this.toTaskResult(existingEntry.taskIdentifier, settledRecord);
        }
        return {
          taskIdentifier: existingEntry.taskIdentifier,
          missionIdentifier: existingEntry.missionIdentifier,
          status: "accepted" as PublicTaskStatus,
          summaryPreview: null,
        };
      }
      this.taskIdempotencyLedger.set(ledgerKey, {
        sessionIdentifier: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        inputHash: submissionInputHash,
        taskIdentifier: input.taskIdentifier,
        missionIdentifier: null,
        claimedAtIso: new Date().toISOString(),
        settledAtIso: null,
      });
      await this.persistTaskIdempotencyLedger();
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
    // Ponder 是本地只读问答（ADR-0014）：不产生 mission。此前这里把 handleUserMessage
    // 返回的字面量 "ponder" 当成 missionIdentifier 并回 accepted，导致调用方随后
    // queryTask 抛 mission-not-found——属虚报受理，改为明确拒绝并指向直接问答入口。
    if (this.runtime.controller.getCurrentMode() === "ponder") {
      throw new PublicApplicationError(
        "invalid-mode-transition",
        "Ponder 模式为本地只读问答，不产生 mission；请使用 handleUserMessage 获取直接回答",
      );
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
    if (ledgerKey !== null) {
      // 结算 claim：绑定 mission，使重启后可复用（同键同参不再执行）。
      const claimedEntry = this.taskIdempotencyLedger.get(ledgerKey);
      if (claimedEntry !== undefined) {
        this.taskIdempotencyLedger.set(ledgerKey, {
          ...claimedEntry,
          missionIdentifier,
          settledAtIso: new Date().toISOString(),
        });
        await this.persistTaskIdempotencyLedger();
      }
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

  /**
   * SMART-01-04：接收一条用户指令进入**指令窗口**（智能模式计数 / 队列 / 准入）。
   *
   * - 窗口上限由 `InstructionWindowStore`（默认 3）决定；超出即**排队**，绝不静默丢弃；
   * - 同 `idempotencyKey` 同参幂等复用、异参拒绝（不覆盖既有指令）；
   * - 准入是**原子**的（同步段内判容量并占位），故连发不会超容；
   * - 期限自**本地接收**（admittedAtIso）起计，排队等待**不得**在取出队列时重新计时。
   *
   * 本入口只登记与判定窗口，不代替任务派发：派发仍走 `submitTask`（本地控制面）。
   */
  async acceptUserInstruction(input: {
    sessionId: string;
    instructionText: string;
    idempotencyKey: string;
    /** 指令 revision（修订绑定原指令；缺省 1）。 */
    instructionRevision?: number;
    /** 显式接收时间（缺省当前时间；供确定性判定与恢复对账使用）。 */
    nowIso?: string;
    /** 指令来源；默认 `user`。Agent 派生节点只能传 `agent`（层级 1 或以下，不能规避窗口计数）。 */
    sourceKind?: "user" | "agent";
  }): Promise<{
    instructionIdentifier: string;
    instructionRevision: number;
    admissionOutcome: "admitted" | "queued" | "duplicate-idempotent" | "idempotency-conflict";
    admittedAtIso: string;
    windowCapacity: number;
    activeInstructionCount: number;
    detail: string;
  }> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const instructionText = input.instructionText.trim();
    if (instructionText === "") {
      throw new PublicApplicationError("invalid-arguments", "指令文本为空，拒绝接收");
    }
    if (input.idempotencyKey.trim() === "") {
      throw new PublicApplicationError("invalid-arguments", "指令幂等键为空，拒绝接收");
    }
    const instructionRevision = input.instructionRevision ?? 1;
    const nowIso = input.nowIso ?? new Date().toISOString();
    this.userInstructionCounter += 1;
    const defaultIdentifier =
      "user-instruction-" + nowIso + "-" + String(this.userInstructionCounter);
    const store = await this.getInstructionWindowStore();
    const result = await store.admitInstruction({
      instructionIdentifier: defaultIdentifier,
      instructionRevision,
      sourceKind: input.sourceKind ?? "user",
      instructionText,
      idempotencyKey: input.idempotencyKey,
      nowIso,
    });
    const snapshot = await store.snapshot();
    const admittedRecord = [...snapshot.activeInstructions, ...snapshot.queuedInstructions].find(
      (record) => record.instructionIdentifier === result.instructionIdentifier,
    );
    return {
      instructionIdentifier: result.instructionIdentifier,
      instructionRevision,
      admissionOutcome: result.outcome,
      admittedAtIso: admittedRecord?.admittedAtIso ?? nowIso,
      windowCapacity: snapshot.windowCapacity,
      activeInstructionCount: snapshot.activeInstructions.length,
      detail: result.detail,
    };
  }

  /** SMART-01-04：指令窗口快照（窗口内 / 排队 / 终态；UI 据此区分"已派发"与"工作成果完成"）。 */
  async queryInstructionWindow(input: {
    sessionId: string;
  }): Promise<InstructionWindowSnapshot> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    return (await this.getInstructionWindowStore()).snapshot();
  }

  /**
   * SMART-01-04：评估一条已接收指令的**三分钟处理期限**（含队列等待）。
   *
   * 语义全部委托 `evaluateInstructionDeadline`（既有冻结契约），本入口只负责
   * 取出**接收时间**并如实回传：超期 ⇒ `isTruthfulTimeout=true` 且**不得**伪报已派发；
   * 等待澄清 ⇒ `isWorkCompleted=false`；门禁（权限等待/休息/显式停止）优先，不被补位绕过。
   */
  async evaluateInstructionHandlingDeadline(input: {
    sessionId: string;
    idempotencyKey: string;
    nowIso?: string;
    dispatchedAtIso?: string | null;
    isAwaitingClarification?: boolean;
    isAwaitingPermissionDecision?: boolean;
    isResting?: boolean;
    isExplicitUserStop?: boolean;
    hasLongRunningSubordinateTask?: boolean;
  }): Promise<InstructionDeadlineEvaluation & { admittedAtIso: string }> {
    this.assertOpen();
    this.requireSession(input.sessionId);
    const snapshot = await (await this.getInstructionWindowStore()).snapshot();
    const allRecords = [
      ...snapshot.activeInstructions,
      ...snapshot.queuedInstructions,
      ...snapshot.terminalInstructions,
    ];
    const record = allRecords.find(
      (candidate) => candidate.idempotencyKey === input.idempotencyKey,
    );
    if (record === undefined) {
      throw new PublicApplicationError(
        "unknown-instruction",
        "未知指令幂等键：拒绝评估（不得伪造一条指令）",
      );
    }
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: record.instructionIdentifier,
      acceptedAtIso: record.admittedAtIso,
      nowIso: input.nowIso ?? new Date().toISOString(),
      ...(input.dispatchedAtIso === undefined ? {} : { dispatchedAtIso: input.dispatchedAtIso }),
      ...(input.isAwaitingClarification === undefined
        ? {}
        : { isAwaitingClarification: input.isAwaitingClarification }),
      ...(input.isAwaitingPermissionDecision === undefined
        ? {}
        : { isAwaitingPermissionDecision: input.isAwaitingPermissionDecision }),
      ...(input.isResting === undefined ? {} : { isResting: input.isResting }),
      ...(input.isExplicitUserStop === undefined
        ? {}
        : { isExplicitUserStop: input.isExplicitUserStop }),
      ...(input.hasLongRunningSubordinateTask === undefined
        ? {}
        : { hasLongRunningSubordinateTask: input.hasLongRunningSubordinateTask }),
    });
    return { ...evaluation, admittedAtIso: record.admittedAtIso };
  }

  /** 指令窗口存储（单一状态目录；无状态目录时响亮失败，不静默降级）。 */
  private async getInstructionWindowStore(): Promise<InstructionWindowStore> {
    if (this.instructionWindowStore !== null) {
      return this.instructionWindowStore;
    }
    if (this.stateDirectory === null) {
      throw new PublicApplicationError(
        "missing-state-directory",
        "未配置状态目录：无法驱动指令窗口（拒绝隐式落盘到当前目录）",
      );
    }
    this.instructionWindowStore = new InstructionWindowStore({
      baseDirectory: this.stateDirectory,
    });
    return this.instructionWindowStore;
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
    this.taskIdempotencyLedger.clear();
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

  /** SMART-01-04：指令窗口存储（按会话共享同一状态目录；懒构造，避免无谓落盘）。 */
  private instructionWindowStore: InstructionWindowStore | null = null;
  /** 用户指令标识序号（本地受理标识；不用模型文本合成）。 */
  private userInstructionCounter = 0;

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
