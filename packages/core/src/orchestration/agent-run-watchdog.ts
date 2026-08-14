/**
 * Agent 运行看门狗与续跑协调器（T07A / ADR-0015 §早停检测与续跑）。
 *
 * AgentRunWatchdog：定期检查 Provider 请求、流式事件时间、运行进程、
 * 工具调用、任务 revision、完成事件与 Provider 结束原因。无进展阈值只触发
 * 本地健康探测，不单独证明早停；只有请求已结束、连接/进程已失活或硬超时
 * 在安全取消原请求后，才能创建新续跑请求。旧请求停止状态不确定时进入
 * blocked，不得并发续跑。
 *
 * ContinuationCoordinator：先原子保存检查点，再以新 completionAttemptId
 * 请求同一任务继续，提供未完成节点、已确认产物与验收缺口；保留幂等键，
 * 禁止重做无法确认的非幂等副作用。达到续跑上限后停止并反馈来源明确的失败。
 */
import { randomUUID } from "node:crypto";

import {
  MAXIMUM_AUTOMATIC_CONTINUATION_ATTEMPTS,
  MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS,
  WATCHDOG_CHECK_INTERVAL_MILLISECONDS,
} from "../core/completion-protocol.js";

export interface AgentRunWatchdogOptions {
  /** 单调时钟（毫秒）；测试注入 fake clock。 */
  nowUnixMilliseconds?: () => number;
  watchdogCheckIntervalMilliseconds?: number;
  modelNoProgressTimeoutMilliseconds?: number;
  /** 每次健康探测时检查 Provider/进程是否活跃。 */
  isProviderRequestActive?: () => boolean;
  /** 最近一次流式事件/心跳时间（毫秒，单调时钟）。 */
  latestStreamEventUnixMilliseconds?: () => number;
  /** 最近一次任务 revision 更新时间。 */
  latestTaskRevisionChangeUnixMilliseconds?: () => number;
  /** 是否有运行中的工具调用。 */
  hasRunningToolCall?: () => boolean;
}

export type WatchdogAssessment =
  | {
      status: "healthy";
      reason: string;
    }
  | {
      status: "stalled-activity-unknown";
      reason: string;
    }
  | {
      status: "stalled-inactive";
      reason: string;
    };

/**
 * 看门狗评估：
 * - 无进展但 Provider/进程仍活跃 → 仅健康探测（stalled-activity-unknown，
 *   不取消、不续跑）；
 * - 请求已结束/连接失活 → stalled-inactive（可安全续跑，需确认旧请求停止）；
 * - 正常进展 → healthy。
 */
export class AgentRunWatchdog {
  private readonly nowUnixMilliseconds: () => number;
  private readonly checkIntervalMilliseconds: number;
  private readonly noProgressTimeoutMilliseconds: number;
  private readonly isProviderRequestActive: () => boolean;
  private readonly latestStreamEventUnixMilliseconds: () => number;
  private readonly latestTaskRevisionChangeUnixMilliseconds: () => number;
  private readonly hasRunningToolCall: () => boolean;

  constructor(options: AgentRunWatchdogOptions = {}) {
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
    this.checkIntervalMilliseconds =
      options.watchdogCheckIntervalMilliseconds ??
      WATCHDOG_CHECK_INTERVAL_MILLISECONDS;
    this.noProgressTimeoutMilliseconds =
      options.modelNoProgressTimeoutMilliseconds ??
      MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS;
    this.isProviderRequestActive = options.isProviderRequestActive ?? (() => true);
    this.latestStreamEventUnixMilliseconds =
      options.latestStreamEventUnixMilliseconds ?? (() => this.nowUnixMilliseconds());
    this.latestTaskRevisionChangeUnixMilliseconds =
      options.latestTaskRevisionChangeUnixMilliseconds ?? (() => this.nowUnixMilliseconds());
    this.hasRunningToolCall = options.hasRunningToolCall ?? (() => false);
  }

  getCheckIntervalMilliseconds(): number {
    return this.checkIntervalMilliseconds;
  }

  /** 一次周期性评估（无副作用；由调用方决定是否续跑）。 */
  assess(): WatchdogAssessment {
    const now = this.nowUnixMilliseconds();
    const latestStreamEvent = this.latestStreamEventUnixMilliseconds();
    const latestRevisionChange = this.latestTaskRevisionChangeUnixMilliseconds();
    const latestProgress = Math.max(latestStreamEvent, latestRevisionChange);
    const stalledMilliseconds = now - latestProgress;
    if (stalledMilliseconds <= this.noProgressTimeoutMilliseconds) {
      return { status: "healthy", reason: "进展在无进展超时阈值内" };
    }
    if (this.hasRunningToolCall()) {
      return {
        status: "healthy",
        reason: "运行中的工具调用属于有效进展",
      };
    }
    if (this.isProviderRequestActive()) {
      // 无进展但 Provider/进程仍活跃：只做健康探测，不取消、不续跑
      return {
        status: "stalled-activity-unknown",
        reason: `无进展 ${stalledMilliseconds}ms，但 Provider 请求仍活跃；仅健康探测`,
      };
    }
    return {
      status: "stalled-inactive",
      reason: `无进展 ${stalledMilliseconds}ms 且 Provider 请求已失活；可安全续跑`,
    };
  }
}

export interface ContinuationCheckpoint {
  checkpointId: string;
  taskExecutionId: string;
  createdAtUnixMilliseconds: number;
  incompleteTaskIdentifiers: string[];
  confirmedArtifactReferences: string[];
  verificationGaps: string[];
  /** 保留的幂等键（防止重做已确认的非幂等副作用）。 */
  preservedIdempotencyKeys: string[];
}

export interface ContinuationRequest {
  attemptNumber: number;
  completionAttemptId: string;
  checkpoint: ContinuationCheckpoint;
}

export interface ContinuationCoordinatorOptions {
  nowUnixMilliseconds?: () => number;
  maximumAutomaticContinuationAttempts?: number;
  /** 保存检查点（幂等；返回检查点 ID）。 */
  saveCheckpoint?: (checkpoint: ContinuationCheckpoint) => Promise<string>;
  /** 已使用的完成尝试 ID（防重放）。 */
  usedCompletionAttemptIds?: Set<string>;
}

export type ContinuationOutcome =
  | { decision: "continue"; request: ContinuationRequest }
  | { decision: "blocked"; reason: string }
  | { decision: "give-up"; reason: string };

export class ContinuationCoordinator {
  private readonly nowUnixMilliseconds: () => number;
  private readonly maximumAttempts: number;
  private readonly saveCheckpoint: (
    checkpoint: ContinuationCheckpoint,
  ) => Promise<string>;
  private readonly usedCompletionAttemptIds: Set<string>;

  constructor(options: ContinuationCoordinatorOptions = {}) {
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
    this.maximumAttempts =
      options.maximumAutomaticContinuationAttempts ??
      MAXIMUM_AUTOMATIC_CONTINUATION_ATTEMPTS;
    this.saveCheckpoint = options.saveCheckpoint ?? (async () => `checkpoint-${randomUUID()}`);
    this.usedCompletionAttemptIds =
      options.usedCompletionAttemptIds ?? new Set<string>();
  }

  /**
   * 疑似早停时决定续跑：先保存检查点，再生成新尝试。
   * - 尝试次数达到上限 → give-up（来源明确的失败，不机械重试）；
   * - 旧请求停止状态不确定 → blocked（不得并发续跑）；
   * - 新尝试 ID 唯一且不重放旧完成事件。
   */
  async planContinuation(input: {
    taskExecutionId: string;
    attemptNumber: number;
    incompleteTaskIdentifiers: string[];
    confirmedArtifactReferences: string[];
    verificationGaps: string[];
    preservedIdempotencyKeys: string[];
    isOldRequestConfirmedStopped: boolean;
  }): Promise<ContinuationOutcome> {
    if (!input.isOldRequestConfirmedStopped) {
      return {
        decision: "blocked",
        reason:
          "旧 Provider 请求停止状态不确定；进入 blocked，不得并发续跑",
      };
    }
    if (input.attemptNumber >= this.maximumAttempts) {
      return {
        decision: "give-up",
        reason: `自动续跑达到上限（${this.maximumAttempts}）；停止并反馈检查点`,
      };
    }
    const completionAttemptId = `attempt-${randomUUID()}`;
    this.usedCompletionAttemptIds.add(completionAttemptId);
    const checkpoint: ContinuationCheckpoint = {
      checkpointId: `checkpoint-${randomUUID()}`,
      taskExecutionId: input.taskExecutionId,
      createdAtUnixMilliseconds: this.nowUnixMilliseconds(),
      incompleteTaskIdentifiers: [...input.incompleteTaskIdentifiers],
      confirmedArtifactReferences: [...input.confirmedArtifactReferences],
      verificationGaps: [...input.verificationGaps],
      preservedIdempotencyKeys: [...input.preservedIdempotencyKeys],
    };
    const checkpointId = await this.saveCheckpoint(checkpoint);
    return {
      decision: "continue",
      request: {
        attemptNumber: input.attemptNumber + 1,
        completionAttemptId,
        checkpoint: { ...checkpoint, checkpointId },
      },
    };
  }

  getUsedAttemptCount(): number {
    return this.usedCompletionAttemptIds.size;
  }
}
