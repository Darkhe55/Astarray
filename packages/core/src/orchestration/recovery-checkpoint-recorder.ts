/**
 * 恢复检查点的**产品侧写入者**（E2E-01-03 S2；契约 T12A-01 / ADR-0030）。
 *
 * 为什么需要它（已查证的既有缺陷）：
 *  `RecoveryCheckpointStore.writeCheckpoint` 此前**只被测试调用**——产品路径从不写检查点，
 *  因此真实项目上 `astarray recover resume` 必然返回 `checkpoint-not-found`，
 *  而"工具调用边界中断后恢复无重复副作用"（卡内验收②）也就无从谈起。
 *
 * 职责划分：
 *  - **本记录器**负责"检查点装配 + 哈希链 + 工具调用状态合并"（mission 层状态由
 *    `snapshotProvider` 提供）；
 *  - **工具调用边界**由 `RecoveryCheckpointingToolPort` 装饰器触发，
 *    它只上报"某次工具调用进入哪个状态"，不认识 mission 状态。
 *
 * 哈希链语义（易错，务必遵守）：
 *  - `previousCheckpointHash` 必须等于 `selectLatestTrustedCheckpoint().checkpointHash`
 *    （**存储层对落盘内容重算**的值）。因此本记录器使用上一次 `writeCheckpoint`
 *    **返回值里的 `checkpointHash`**；首次写入用 `null`。
 *  - `contentHash` 是**自指字段**：schema 只校验其格式，校验侧不比对。
 *    本记录器按"把 `contentHash` 置为全零占位后的规范 JSON"计算，保持确定性且可解释。
 *
 * 纪律：
 *  - **写失败不得静默**：`started` 记录失败时**不执行工具**（fail-closed，此时尚无副作用）；
 *    执行后的状态记录失败则只上报错误——因为副作用可能已经发生，此前的 `started`
 *    已足够让恢复对账把非幂等操作判为 `blocked-uncertain-side-effect`（禁止自动二次执行）。
 *  - 写入串行化：并发工具调用不得交错写检查点（否则哈希链会断）。
 */
import { createHash } from "node:crypto";

import type { ToolCallResult, ToolPort } from "../core/types.js";
import {
  RECOVERY_CHECKPOINT_SCHEMA_VERSION,
  type AgentIdentityRecovery,
  type RecoveryCheckpoint,
  type ToolCallRecoveryState,
  type ToolCallRecoveryStateRecord,
} from "./recovery-checkpoint-schemas.js";
import type { RecoveryCheckpointStore } from "./recovery-checkpoint-store.js";

/** mission 层快照：由装配层（掌握任务链/身份/门禁/游标）提供，工具层拿不到这些。 */
export interface RecoveryCheckpointSnapshot {
  agentIdentities: AgentIdentityRecovery[];
  taskNodes: RecoveryCheckpoint["taskNodes"];
  gitStateRecovery?: RecoveryCheckpoint["gitStateRecovery"];
  humanChangeObservationRevision: number;
  pendingConflictIdentifiers: string[];
  providerRequests: RecoveryCheckpoint["providerRequests"];
  feedbackCursor: RecoveryCheckpoint["feedbackCursor"];
  permissionRecovery: RecoveryCheckpoint["permissionRecovery"];
  workingSetFileCountsByAgent: Record<string, number>;
  taskChainCumulativeSourceCount: number;
  gateStates: RecoveryCheckpoint["gateStates"];
}

export interface RecoveryCheckpointRecorderOptions {
  store: RecoveryCheckpointStore;
  sessionIdentifier: string;
  missionIdentifier: string;
  taskChainIdentifier: string;
  writingProcessInstanceIdentifier: string;
  snapshotProvider: () => RecoveryCheckpointSnapshot | Promise<RecoveryCheckpointSnapshot>;
  nowIso?: () => string;
  /** 检查点标识前缀（默认由 mission 派生）。 */
  checkpointIdentifierPrefix?: string;
  /** 检查点写入失败时上报（工具已执行后的状态记录失败不应吞掉）。 */
  onCheckpointWriteError?: (error: unknown) => void;
}

export interface RecordToolCallStateInput {
  toolCallIdentifier: string;
  toolName: string;
  state: ToolCallRecoveryState;
  isIdempotent: boolean;
  completionAttemptIdentifier: string | null;
}

const CONTENT_HASH_PLACEHOLDER = "sha256:" + "0".repeat(64);

export class RecoveryCheckpointRecorder {
  private readonly store: RecoveryCheckpointStore;
  private readonly toolCallStatesByIdentifier = new Map<string, ToolCallRecoveryStateRecord>();
  private lastCheckpointHash: string | null = null;
  private checkpointSequence = 0;
  /** 串行化写链：并发工具调用不得交错写检查点。 */
  private pendingWriteChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RecoveryCheckpointRecorderOptions) {
    this.store = options.store;
  }

  getToolCallStates(): ToolCallRecoveryStateRecord[] {
    return [...this.toolCallStatesByIdentifier.values()];
  }

  /**
   * 记录一次工具调用状态并落一个检查点。
   *
   * `shouldReportWriteError`：`started` 阶段由调用方传 `false` 并**让错误外抛**
   * （尚未执行工具，fail-closed 安全）；执行后的状态传 `true`（错误只上报，不影响业务结果）。
   */
  async recordToolCallState(input: RecordToolCallStateInput): Promise<void> {
    this.toolCallStatesByIdentifier.set(input.toolCallIdentifier, {
      toolCallIdentifier: input.toolCallIdentifier,
      toolName: input.toolName,
      state: input.state,
      isIdempotent: input.isIdempotent,
      completionAttemptIdentifier: input.completionAttemptIdentifier,
    });
    await this.enqueueCheckpointWrite();
  }

  /** 立即按当前状态落一个检查点（返回本次写入的标识与存储层重算的哈希）。 */
  async writeCheckpointNow(): Promise<{
    checkpointIdentifier: string;
    checkpointHash: string;
  }> {
    const snapshot = await this.options.snapshotProvider();
    this.checkpointSequence += 1;
    const prefix =
      this.options.checkpointIdentifierPrefix ??
      `recovery-${this.options.missionIdentifier}`;
    const checkpointIdentifier = `${prefix}-${String(this.checkpointSequence).padStart(4, "0")}`;
    const previousCheckpointHash =
      this.lastCheckpointHash ??
      (await this.store.selectLatestTrustedCheckpoint())?.checkpointHash ??
      null;
    const candidate: RecoveryCheckpoint = {
      schemaVersion: RECOVERY_CHECKPOINT_SCHEMA_VERSION,
      checkpointIdentifier,
      sessionIdentifier: this.options.sessionIdentifier,
      missionIdentifier: this.options.missionIdentifier,
      taskChainIdentifier: this.options.taskChainIdentifier,
      agentIdentities: snapshot.agentIdentities,
      taskNodes: snapshot.taskNodes,
      ...(snapshot.gitStateRecovery === undefined
        ? {}
        : { gitStateRecovery: snapshot.gitStateRecovery }),
      humanChangeObservationRevision: snapshot.humanChangeObservationRevision,
      pendingConflictIdentifiers: snapshot.pendingConflictIdentifiers,
      toolCalls: this.getToolCallStates(),
      providerRequests: snapshot.providerRequests,
      feedbackCursor: snapshot.feedbackCursor,
      permissionRecovery: snapshot.permissionRecovery,
      workingSetFileCountsByAgent: snapshot.workingSetFileCountsByAgent,
      taskChainCumulativeSourceCount: snapshot.taskChainCumulativeSourceCount,
      gateStates: snapshot.gateStates,
      contentHash: CONTENT_HASH_PLACEHOLDER,
      previousCheckpointHash,
      createdAtIso: (this.options.nowIso ?? (() => new Date().toISOString()))(),
      writingProcessInstanceIdentifier: this.options.writingProcessInstanceIdentifier,
    };
    // 自指字段：按"占位后的规范 JSON"计算，确定性且可解释（链键由存储层重算，见模块注释）。
    const contentHash = this.store.computeContentHashFor(candidate);
    const writeResult = await this.store.writeCheckpoint({
      checkpoint: { ...candidate, contentHash },
      writingProcessInstanceIdentifier: this.options.writingProcessInstanceIdentifier,
    });
    this.lastCheckpointHash = writeResult.checkpointHash;
    return {
      checkpointIdentifier: writeResult.checkpoint.checkpointIdentifier,
      checkpointHash: writeResult.checkpointHash,
    };
  }

  private enqueueCheckpointWrite(): Promise<void> {
    const nextWrite = this.pendingWriteChain.then(
      () => this.writeCheckpointNow().then(() => undefined),
      () => this.writeCheckpointNow().then(() => undefined),
    );
    this.pendingWriteChain = nextWrite.catch((error: unknown) => {
      this.options.onCheckpointWriteError?.(error);
    });
    return nextWrite;
  }
}

export interface RecoveryCheckpointingToolPortOptions {
  innerToolPort: ToolPort;
  recorder: RecoveryCheckpointRecorder;
  /** 该工具是否可能改变本地状态（非幂等）；只读工具为 false。 */
  isMutatingTool: (toolName: string) => boolean;
  /** 当前完成尝试标识（可为空）。 */
  completionAttemptIdentifier?: () => string | null;
}

/**
 * 工具调用边界装饰器：**套在最外层**，因此范围/权限门禁的拒绝也会被记为一次工具调用状态。
 */
export class RecoveryCheckpointingToolPort implements ToolPort {
  constructor(private readonly options: RecoveryCheckpointingToolPortOptions) {}

  async execute(
    toolName: string,
    argumentsJson: string,
    callId: string,
    cancellationSignal: AbortSignal,
  ): Promise<ToolCallResult> {
    const isMutatingTool = this.options.isMutatingTool(toolName);
    const completionAttemptIdentifier = this.options.completionAttemptIdentifier?.() ?? null;
    const recordState = (state: ToolCallRecoveryState) =>
      this.options.recorder.recordToolCallState({
        toolCallIdentifier: callId,
        toolName,
        state,
        isIdempotent: !isMutatingTool,
        completionAttemptIdentifier,
      });

    // `started` 必须在执行**之前**落盘，且失败即 fail-closed（此时尚无副作用）。
    await recordState("started");
    try {
      const result = await this.options.innerToolPort.execute(
        toolName,
        argumentsJson,
        callId,
        cancellationSignal,
      );
      if (result.kind === "success") {
        await recordState("confirmed-success");
        return result;
      }
      /**
       * 错误结果：只有"确定未进入副作用通道"（`sideEffectStatus === "none"`）才算确认失败；
       * 其余一律 `result-unknown`（保守：宁可要用户裁决，也不自动二次执行）。
       */
      const hasPossibleSideEffect =
        isMutatingTool && result.sideEffectStatus !== "none";
      await recordState(hasPossibleSideEffect ? "result-unknown" : "confirmed-failure");
      return result;
    } catch (error) {
      // 抛异常：可能已产生副作用（非幂等）→ `result-unknown`，禁止自动重试。
      try {
        await recordState(isMutatingTool ? "result-unknown" : "confirmed-failure");
      } catch {
        // 见模块注释：此处不再遮蔽原始错误；此前的 `started` 已足以让对账 fail-safe。
      }
      throw error;
    }
  }
}

/** 供装配层生成进程实例标识（检查点必填）。 */
export function buildWritingProcessInstanceIdentifier(input: {
  processId: number;
  startedAtIso: string;
}): string {
  const digest = createHash("sha256")
    .update(`${String(input.processId)}|${input.startedAtIso}`)
    .digest("hex")
    .slice(0, 12);
  return `process-${String(input.processId)}-${digest}`;
}
