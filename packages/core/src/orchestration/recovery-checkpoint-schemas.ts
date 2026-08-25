/**
 * 统一会话恢复契约（T12A-01 / ADR-0030）。
 *
 * - RecoveryCheckpointV1：统一检查点（身份/任务/Git/人工/工具调用/
 *   Provider/反馈/权限公开引用/工作集/门禁/哈希链）；
 * - ToolCallRecoveryState：调用状态五态（planned/started/confirmed-success/
 *   confirmed-failure/result-unknown）；
 * - RecoveryReconciliationResult：对账分类结果（安全/阻塞/新 handoff）；
 * - 旧授权（nonce/一次性许可）不在检查点中（秘密字段反例）。
 */
import { z } from "zod";

/** 检查点 schema 版本（T12A-01 冻结）。 */
export const RECOVERY_CHECKPOINT_SCHEMA_VERSION = 1;
/** 对账结果 schema 版本（T12A-01 冻结）。 */
export const RECOVERY_RECONCILIATION_SCHEMA_VERSION = 1;

/** 工具调用恢复状态（冻结五态）。 */
export const TOOL_CALL_RECOVERY_STATES = [
  "planned",
  "started",
  "confirmed-success",
  "confirmed-failure",
  "result-unknown",
] as const;
export type ToolCallRecoveryState =
  (typeof TOOL_CALL_RECOVERY_STATES)[number];

/** 恢复分类（ADR-0030 §3；冻结）。 */
export const RECOVERY_DECISION_TYPES = [
  "safe-recoverable",
  "blocked-uncertain-side-effect",
  "blocked-provider-state-unknown",
  "new-handoff-identity",
  "rejected-stale-contribution",
  "reauthorize-required",
] as const;
export type RecoveryDecisionType = (typeof RECOVERY_DECISION_TYPES)[number];

/** Agent 身份恢复信息（沿用原身份或新身份 + handoff）。 */
export const agentIdentityRecoverySchema = z.object({
  agentInstanceId: z.string().min(1),
  agentRole: z.enum(["main", "secondary", "tertiary", "quaternary"]),
  lifecycleState: z.enum(["active", "paused", "closed", "reclaimed"]),
  /** 已回收时创建新身份并显式 handoff（不复用旧身份）。 */
  handoffReference: z.string().min(1).nullable(),
  parentAgentInstanceId: z.string().min(1).nullable(),
});
export type AgentIdentityRecovery = z.infer<
  typeof agentIdentityRecoverySchema
>;

/** 工具调用恢复状态记录（副作用分类依据）。 */
export const toolCallRecoveryStateSchema = z.object({
  toolCallIdentifier: z.string().min(1),
  toolName: z.string().min(1),
  state: z.enum(TOOL_CALL_RECOVERY_STATES),
  /** 非幂等副作用结果未知 → 分类为 blocked-uncertain-side-effect。 */
  isIdempotent: z.boolean(),
  completionAttemptIdentifier: z.string().nullable(),
});
export type ToolCallRecoveryStateRecord = z.infer<
  typeof toolCallRecoveryStateSchema
>;

/** Provider 请求恢复信息（公开 ID；不含凭据/prompt）。 */
export const providerRequestRecoverySchema = z.object({
  providerRequestPublicIdentifier: z.string().min(1),
  /** 最后事件时间；停止确认状态。 */
  lastEventAtIso: z.iso.datetime().nullable(),
  isStopConfirmed: z.boolean(),
  completionEventState: z.enum(["none", "received", "committed"]),
});
export type ProviderRequestRecovery = z.infer<
  typeof providerRequestRecoverySchema
>;

/** 权限恢复（只记录公开配置引用；不保存授权 nonce/凭据/一次性许可）。 */
export const permissionRecoveryReferenceSchema = z.object({
  permissionProfileReference: z.string().min(1),
  profileRevision: z.number().int().min(1),
});
export type PermissionRecoveryReference = z.infer<
  typeof permissionRecoveryReferenceSchema
>;

/** 统一检查点（RecoveryCheckpointV1；原子写入 + 哈希链）。 */
export const recoveryCheckpointSchema = z.object({
  schemaVersion: z.literal(RECOVERY_CHECKPOINT_SCHEMA_VERSION),
  checkpointIdentifier: z.string().min(1),
  sessionIdentifier: z.string().min(1),
  missionIdentifier: z.string().min(1),
  taskChainIdentifier: z.string().min(1),
  /** 各级 Agent 身份恢复信息。 */
  agentIdentities: z.array(agentIdentityRecoverySchema),
  /** 任务节点状态（前驱/优先级/执行者/检查点/完成尝试 ID）。 */
  taskNodes: z.array(
    z.object({
      taskNodeIdentifier: z.string().min(1),
      status: z.enum(["pending", "running", "blocked", "done", "failed"]),
      predecessorTaskNodeIdentifiers: z.array(z.string().min(1)),
      priorityTier: z.number().int().min(0),
      assignedAgentInstanceId: z.string().nullable(),
      checkpointIdentifier: z.string().nullable(),
      completionAttemptIdentifier: z.string().nullable(),
    }),
  ),
  /** 人工变化观察 revision/编辑意图/未决冲突（T05D 对账输入）。 */
  humanChangeObservationRevision: z.number().int().min(0),
  pendingConflictIdentifiers: z.array(z.string().min(1)),
  /** 工具调用状态。 */
  toolCalls: z.array(toolCallRecoveryStateSchema),
  /** Provider 请求恢复信息。 */
  providerRequests: z.array(providerRequestRecoverySchema),
  /** feedback enqueue/delivery/ack 游标（不复制其他 Agent 私有消息视图）。 */
  feedbackCursor: z.object({
    enqueueCursor: z.number().int().min(0),
    deliveryCursor: z.number().int().min(0),
    ackCursor: z.number().int().min(0),
  }),
  /** 权限恢复（公开引用；无 nonce/凭据）。 */
  permissionRecovery: z.array(permissionRecoveryReferenceSchema),
  /** 每 Agent 工作集/任务链累计预算（T07E 恢复；不清零）。 */
  workingSetFileCountsByAgent: z.record(z.string(), z.number().int().min(0)),
  taskChainCumulativeSourceCount: z.number().int().min(0),
  /** 门禁状态。 */
  gateStates: z.object({
    testingGate: z.enum(["pending", "passed", "failed"]),
    acceptanceGate: z.enum(["pending", "passed", "failed"]),
    humanReviewGate: z.enum(["pending", "passed", "blocked-human-review"]),
    installationGate: z.enum(["pending", "passed", "denied"]),
    backupDeletionGate: z.enum(["pending", "passed", "denied"]),
  }),
  /** 内容哈希 + 前一检查点哈希（哈希链）。 */
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  previousCheckpointHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  createdAtIso: z.iso.datetime(),
  writingProcessInstanceIdentifier: z.string().min(1),
});
export type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;

/** 对账结果（启动只读对账后分类；按中断状态 → 恢复行为）。 */
export const recoveryReconciliationResultSchema = z.object({
  schemaVersion: z.literal(RECOVERY_RECONCILIATION_SCHEMA_VERSION),
  reconciliationIdentifier: z.string().min(1),
  decision: z.enum(RECOVERY_DECISION_TYPES),
  checkpointIdentifier: z.string().min(1),
  /** 非幂等副作用结果未知/Provider 仍可能活跃时的理由。 */
  blockedReason: z.string().nullable(),
  /** 新 handoff 身份（new-handoff-identity 时非空）。 */
  handoffReference: z.string().nullable(),
  reauthorizationRequired: z.boolean(),
  createdAtIso: z.iso.datetime(),
});
export type RecoveryReconciliationResult = z.infer<
  typeof recoveryReconciliationResultSchema
>;

/** 旧授权 nonce/一次性许可不得出现在检查点（秘密字段反例防护）。 */
export function assertCheckpointHasNoSecretFields(
  checkpoint: RecoveryCheckpoint,
): void {
  const serialized = JSON.stringify(checkpoint);
  const forbiddenPatterns = [
    /nonce/i,
    /api[_-]?key/i,
    /authorization-secret/i,
    /one-time-permission/i,
  ];
  const leaked = forbiddenPatterns.some((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error("检查点不得包含授权 nonce/凭据/一次性许可（秘密字段反例）");
  }
}