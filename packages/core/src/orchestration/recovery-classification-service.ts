/**
 * 恢复分类服务（T12A-04 / ADR-0030 §5）。
 *
 * - 工具副作用分类：已确认成功且幂等 → 复用结果不重复调用；
 *   非幂等结果未知 → blocked-uncertain-side-effect（用户裁决，
 *   禁止自动重试；项目文字/模型声明不能改成成功）；已确认失败可重试 →
 *   按原任务预算有界重试；
 * - Provider 请求停止状态不确定 → blocked-provider-state-unknown；
 * - 反馈 journal 按 enqueue/deliver/ack 幂等重放（已 ack 不重复注入）；
 * - 一次性授权（allow-once/会话提升/备份删除 nonce）恢复后失效 →
 *   reauthorize-required（不能凭旧日志恢复权限；基础 profile 不变）。
 */
import { recoveryCheckpointSchema } from "./recovery-checkpoint-schemas.js";
import type {
  RecoveryCheckpoint,
  RecoveryDecisionType,
  ToolCallRecoveryStateRecord,
} from "./recovery-checkpoint-schemas.js";

export type ToolCallClassification =
  | { category: "reuse-confirmed-result" }
  | { category: "bounded-retry"; remainingRetryBudget: number }
  | { category: "blocked-uncertain-side-effect"; reason: string };

export interface RecoveryClassificationInput {
  checkpoint: RecoveryCheckpoint;
  /** 当前任务的失败重试剩余预算。 */
  remainingRetryBudget: number;
}

export interface RecoveryClassificationOutput {
  toolCallClassifications: Array<{
    toolCallIdentifier: string;
    classification: ToolCallClassification;
  }>;
  /** Provider 停止状态不确定的请求（需确认停止后才能继续）。 */
  blockedProviderRequestIdentifiers: string[];
  /** 反馈重放消息范围（ack 之后；已 ack 不重复）。 */
  feedbackReplayEnqueueRange: { fromEnqueueCursor: number; toEnqueueCursor: number } | null;
  /** 恢复后失效的一次性授权类型（需重新授权）。 */
  reauthorizationRequiredTypes: string[];
  /** 存在阻塞项 → 恢复不自动继续。 */
  hasBlockingItems: boolean;
}

export class RecoveryClassificationService {
  /**
   * 分类检查点中所有待恢复项；项目文字/模型声明不能改变分类
   * （本服务是本地确定性规则）。
   */
  classifyRecovery(input: RecoveryClassificationInput): RecoveryClassificationOutput {
    const parsedCheckpoint = recoveryCheckpointSchema.safeParse(input.checkpoint);
    if (!parsedCheckpoint.success) {
      throw new Error(`检查点非法: ${parsedCheckpoint.error.message}`);
    }
    const checkpoint = parsedCheckpoint.data;

    const toolCallClassifications: RecoveryClassificationOutput["toolCallClassifications"] = [];
    const blockedProviderRequestIdentifiers: string[] = [];

    // 1) 工具副作用分类
    for (const toolCall of checkpoint.toolCalls) {
      toolCallClassifications.push({
        toolCallIdentifier: toolCall.toolCallIdentifier,
        classification: this.classifyToolCall(toolCall, input.remainingRetryBudget),
      });
    }

    // 2) Provider 请求：停止状态不确定 → blocked
    for (const providerRequest of checkpoint.providerRequests) {
      if (!providerRequest.isStopConfirmed) {
        blockedProviderRequestIdentifiers.push(
          providerRequest.providerRequestPublicIdentifier,
        );
      }
    }

    // 3) 反馈 ack 幂等重放：ack 之后 enqueue 范围才重放
    const feedbackReplayEnqueueRange: RecoveryClassificationOutput["feedbackReplayEnqueueRange"] =
      checkpoint.feedbackCursor.enqueueCursor > checkpoint.feedbackCursor.ackCursor
        ? {
            fromEnqueueCursor: checkpoint.feedbackCursor.ackCursor + 1,
            toEnqueueCursor: checkpoint.feedbackCursor.enqueueCursor,
          }
        : null;

    // 4) 权限失效：检查点只记录公开引用；一次性授权恢复后失效
    const reauthorizationRequiredTypes = [
      "session-elevation",
      "installation-allow-once",
      "backup-deletion",
    ];
    if (checkpoint.permissionRecovery.length === 0) {
      // 无权限引用时仍要求重新授权（不能凭旧日志恢复权限能力）
      reauthorizationRequiredTypes.push("session-authorization");
    }

    const hasBlockingItems =
      blockedProviderRequestIdentifiers.length > 0 ||
      toolCallClassifications.some(
        (item) => item.classification.category === "blocked-uncertain-side-effect",
      );

    return {
      toolCallClassifications,
      blockedProviderRequestIdentifiers,
      feedbackReplayEnqueueRange,
      reauthorizationRequiredTypes,
      hasBlockingItems,
    };
  }

  /** 单工具调用分类（本地确定性规则）。 */
  private classifyToolCall(
    toolCall: ToolCallRecoveryStateRecord,
    remainingRetryBudget: number,
  ): ToolCallClassification {
    if (toolCall.state === "confirmed-success" && toolCall.isIdempotent) {
      return { category: "reuse-confirmed-result" };
    }
    if (toolCall.state === "confirmed-failure" && remainingRetryBudget > 0) {
      return { category: "bounded-retry", remainingRetryBudget };
    }
    if (
      toolCall.state === "result-unknown" &&
      !toolCall.isIdempotent
    ) {
      return {
        category: "blocked-uncertain-side-effect",
        reason: `非幂等工具调用 ${toolCall.toolName}（${toolCall.toolCallIdentifier}）结果未知；禁止自动重试，需用户裁决`,
      };
    }
    // planned/started/result-unknown 且幂等：可重新调度
    return { category: "bounded-retry", remainingRetryBudget };
  }

  /** 校验分类结果稳定（恢复决定类型集合不变）。 */
  static assertDecisionTypesStable(decisionTypes: RecoveryDecisionType[]): void {
    for (const decisionType of decisionTypes) {
      if (
        ![
          "safe-recoverable",
          "blocked-uncertain-side-effect",
          "blocked-provider-state-unknown",
          "new-handoff-identity",
          "rejected-stale-contribution",
          "reauthorize-required",
        ].includes(decisionType)
      ) {
        throw new Error(`未知恢复决定类型: ${decisionType}`);
      }
    }
  }
}