/**
 * GUIDE-01-03：长工具检查点与协作取消。
 *
 * 约束（见 ADR-0038 §17–23）：
 * - **不假定 Provider 支持在途插入**：取消请求只在下一个检查点交付，绝不乐观宣称已停止；
 * - 停止结果未知（未在观察窗口内回执）一律 `unknown-stop-outcome`，调用方必须按 blocked 处理；
 * - 旧执行世的完成声明失效（epoch 不匹配 → `stale-epoch-invalidated`）；
 * - 新指导收敛旧请求：被取代的请求标记 superseded，新请求承接最新指导 revision；
 * - watchdog 不得用旧指令续跑（`shouldWatchdogResume` 对已取消/已取代指令返回 false）。
 */
import { createHash } from "node:crypto";

import type {
  GuidanceControlQueue,
  GuidanceSafePointKind,
} from "./guidance-control-queue.js";
import type { GuidanceScopeTarget } from "./runtime-guidance.js";

export type CancellationStatus =
  | "requested"
  | "acknowledged-stopped"
  | "acknowledged-completed"
  | "superseded"
  | "unknown-stop-outcome";

export interface ToolExecutionRegistration {
  toolCallId: string;
  taskIdentifier: string;
  executionEpoch: number;
  startedAtIso: string;
  isCancellableAtSafePoint: boolean;
}

export interface LongToolCheckpointReceipt {
  receiptIdentifier: string;
  toolCallId: string;
  taskIdentifier: string;
  executionEpoch: number;
  checkpointSequence: number;
  elapsedMilliseconds: number;
  appliedGuidanceIdentifiers: string[];
  /** 本检查点交付的取消请求（到达检查点才算送达，不假定在途插入）。 */
  deliveredCancellationRequestIdentifiers: string[];
  recordedAtIso: string;
}

export interface CancellationRequest {
  requestIdentifier: string;
  toolCallId: string;
  taskIdentifier: string;
  executionEpoch: number;
  instructionRevision: number;
  reason: string;
  requestedAtIso: string;
  status: CancellationStatus;
  acknowledgedAtIso: string | null;
  supersededByRequestIdentifier: string | null;
  /** 是否已随某个检查点交付（0 = 尚未交付；不假定在途插入）。 */
  deliveredAtCheckpointCount: number;
  deliveredAtIso: string | null;
}

export type CompletionDeclarationOutcome =
  | "accepted"
  | "stale-epoch-invalidated"
  | "rejected-cancelled"
  | "unknown-stop-outcome";

export interface WatchdogResumeDecision {
  shouldResume: boolean;
  reason:
    | "no-active-cancellation"
    | "cancellation-active"
    | "instruction-superseded"
    | "unknown-stop-outcome";
}

export class LongToolCoordinationError extends Error {
  constructor(
    readonly errorCode:
      | "unknown-tool-call"
      | "unknown-cancellation-request"
      | "invalid-epoch",
    message: string,
  ) {
    super(message);
    this.name = "LongToolCoordinationError";
  }
}

interface ExecutionState {
  registration: ToolExecutionRegistration;
  checkpointSequence: number;
  isCompletionDeclared: boolean;
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export class LongToolCheckpointController {
  private readonly executionsByToolCallId = new Map<string, ExecutionState>();
  private readonly requestsByIdentifier = new Map<string, CancellationRequest>();

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  beginToolExecution(input: {
    toolCallId: string;
    taskIdentifier: string;
    startedAtIso: string;
    isCancellableAtSafePoint: boolean;
    executionEpoch?: number;
  }): ToolExecutionRegistration {
    const previous = this.executionsByToolCallId.get(input.toolCallId);
    const executionEpoch = input.executionEpoch ?? (previous?.registration.executionEpoch ?? 0) + 1;
    if (previous !== undefined && executionEpoch <= previous.registration.executionEpoch) {
      throw new LongToolCoordinationError(
        "invalid-epoch",
        "新的执行世必须大于既有世: " + input.toolCallId,
      );
    }
    const registration: ToolExecutionRegistration = {
      toolCallId: input.toolCallId,
      taskIdentifier: input.taskIdentifier,
      executionEpoch,
      startedAtIso: input.startedAtIso,
      isCancellableAtSafePoint: input.isCancellableAtSafePoint,
    };
    this.executionsByToolCallId.set(input.toolCallId, {
      registration,
      checkpointSequence: 0,
      isCompletionDeclared: false,
    });
    return { ...registration };
  }

  /** 长工具检查点：在工具运行中消费控制队列，并生成回执。 */
  runCheckpoint(input: {
    toolCallId: string;
    safePointKind: GuidanceSafePointKind;
    target: GuidanceScopeTarget;
    guidanceQueue: GuidanceControlQueue;
    nowIso?: string;
  }): LongToolCheckpointReceipt {
    const state = this.requireExecution(input.toolCallId);
    const nowIso = input.nowIso ?? this.nowIso();
    const consumption = input.guidanceQueue.consumeAtSafePoint({
      safePointKind: input.safePointKind,
      target: input.target,
      nowIso,
    });
    state.checkpointSequence += 1;
    const deliveredRequestIdentifiers = this.deliverPendingCancellations(
      input.toolCallId,
      nowIso,
    );
    return {
      receiptIdentifier:
        "checkpoint-" + sha256Short(input.toolCallId + ":" + String(state.checkpointSequence) + ":" + nowIso),
      toolCallId: input.toolCallId,
      taskIdentifier: state.registration.taskIdentifier,
      executionEpoch: state.registration.executionEpoch,
      checkpointSequence: state.checkpointSequence,
      elapsedMilliseconds: Math.max(
        0,
        Date.parse(nowIso) - Date.parse(state.registration.startedAtIso),
      ),
      appliedGuidanceIdentifiers: consumption.applied.map(
        (application) => application.guidanceIdentifier,
      ),
      deliveredCancellationRequestIdentifiers: deliveredRequestIdentifiers,
      recordedAtIso: nowIso,
    };
  }

  private deliverPendingCancellations(toolCallId: string, nowIso: string): string[] {
    const delivered: string[] = [];
    for (const request of this.requestsByIdentifier.values()) {
      if (
        request.toolCallId === toolCallId &&
        request.status === "requested" &&
        request.acknowledgedAtIso === null &&
        request.deliveredAtCheckpointCount === 0
      ) {
        request.deliveredAtCheckpointCount = 1;
        request.deliveredAtIso = nowIso;
        delivered.push(request.requestIdentifier);
      }
    }
    return delivered;
  }

  /** 协作取消请求：入队等待下一个检查点（不假定 Provider 允许在途插入）。 */
  requestCooperativeCancellation(input: {
    toolCallId: string;
    reason: string;
    instructionRevision: number;
    requestedAtIso?: string;
  }): CancellationRequest {
    const state = this.requireExecution(input.toolCallId);
    const requestedAtIso = input.requestedAtIso ?? this.nowIso();
    const request: CancellationRequest = {
      requestIdentifier:
        "cancel-" + sha256Short(input.toolCallId + ":" + requestedAtIso + ":" + input.reason),
      toolCallId: input.toolCallId,
      taskIdentifier: state.registration.taskIdentifier,
      executionEpoch: state.registration.executionEpoch,
      instructionRevision: input.instructionRevision,
      reason: input.reason,
      requestedAtIso,
      status: "requested",
      acknowledgedAtIso: null,
      supersededByRequestIdentifier: null,
      deliveredAtCheckpointCount: 0,
      deliveredAtIso: null,
    };
    this.requestsByIdentifier.set(request.requestIdentifier, request);
    return { ...request };
  }

  /** 工具侧回执：只有回执才能把状态推进到终态（绝不乐观宣称停止）。 */
  acknowledgeCancellation(input: {
    requestIdentifier: string;
    outcome: "stopped" | "completed";
    observedAtIso?: string;
  }): CancellationRequest {
    const request = this.requestsByIdentifier.get(input.requestIdentifier);
    if (request === undefined) {
      throw new LongToolCoordinationError(
        "unknown-cancellation-request",
        "取消请求不存在: " + input.requestIdentifier,
      );
    }
    request.status =
      input.outcome === "stopped" ? "acknowledged-stopped" : "acknowledged-completed";
    request.acknowledgedAtIso = input.observedAtIso ?? this.nowIso();
    return { ...request };
  }

  /**
   * 观察窗口内没有任何回执 → 停止结果未知（必须按 blocked 处理，不得当成成功停止）。
   */
  evaluateStopOutcome(input: {
    requestIdentifier: string;
    nowIso: string;
    maximumWaitMilliseconds: number;
  }): CancellationStatus {
    const request = this.requestsByIdentifier.get(input.requestIdentifier);
    if (request === undefined) {
      throw new LongToolCoordinationError(
        "unknown-cancellation-request",
        "取消请求不存在: " + input.requestIdentifier,
      );
    }
    if (
      request.status === "requested" &&
      Date.parse(input.nowIso) - Date.parse(request.requestedAtIso) >
        input.maximumWaitMilliseconds
    ) {
      request.status = "unknown-stop-outcome";
    }
    return request.status;
  }

  /** 完成声明：旧执行世或已取消的执行不得计为成功。 */
  declareToolCompletion(input: {
    toolCallId: string;
    executionEpoch: number;
    outputSummary: string;
    declaredAtIso?: string;
  }): { outcome: CompletionDeclarationOutcome; reason: string } {
    const state = this.requireExecution(input.toolCallId);
    const declaredAtIso = input.declaredAtIso ?? this.nowIso();
    if (input.executionEpoch !== state.registration.executionEpoch) {
      return {
        outcome: "stale-epoch-invalidated",
        reason:
          "完成声明属于旧执行世 " +
          String(input.executionEpoch) +
          "，当前为 " +
          String(state.registration.executionEpoch),
      };
    }
    const unknownStop = [...this.requestsByIdentifier.values()].find(
      (request) =>
        request.toolCallId === input.toolCallId &&
        request.status === "unknown-stop-outcome",
    );
    if (unknownStop !== undefined) {
      return {
        outcome: "unknown-stop-outcome",
        reason: "取消请求 " + unknownStop.requestIdentifier + " 的停止结果未知，按 blocked 处理",
      };
    }
    const stoppedRequest = [...this.requestsByIdentifier.values()].find(
      (request) =>
        request.toolCallId === input.toolCallId &&
        request.status === "acknowledged-stopped",
    );
    if (stoppedRequest !== undefined) {
      return {
        outcome: "rejected-cancelled",
        reason: "该执行已在 " + (stoppedRequest.acknowledgedAtIso ?? declaredAtIso) + " 停止，完成声明无效",
      };
    }
    state.isCompletionDeclared = true;
    return { outcome: "accepted", reason: "完成声明有效（执行世与状态一致）" };
  }

  /** 新指导收敛旧请求：被取代的请求标记 superseded；新请求承接最新指导 revision。 */
  convergeSupersededRequests(input: {
    taskIdentifier: string;
    activeInstructionRevision: number;
    reason: string;
  }): {
    convergedRequestIdentifiers: string[];
    successorRequestIdentifier: string | null;
  } {
    const convergedRequestIdentifiers: string[] = [];
    const activeRequests = [...this.requestsByIdentifier.values()].filter(
      (request) =>
        request.taskIdentifier === input.taskIdentifier &&
        request.status !== "superseded" &&
        request.instructionRevision < input.activeInstructionRevision,
    );
    for (const request of activeRequests) {
      request.status = "superseded";
      convergedRequestIdentifiers.push(request.requestIdentifier);
    }
    if (convergedRequestIdentifiers.length === 0) {
      return { convergedRequestIdentifiers, successorRequestIdentifier: null };
    }
    const latestRequest = [...this.requestsByIdentifier.values()]
      .filter((request) => request.taskIdentifier === input.taskIdentifier)
      .sort((left, right) => right.instructionRevision - left.instructionRevision)[0];
    if (latestRequest === undefined) {
      return { convergedRequestIdentifiers, successorRequestIdentifier: null };
    }
    const successor: CancellationRequest = {
      ...latestRequest,
      requestIdentifier:
        "cancel-" + sha256Short(latestRequest.requestIdentifier + ":" + String(input.activeInstructionRevision)),
      instructionRevision: input.activeInstructionRevision,
      reason: input.reason,
      requestedAtIso: this.nowIso(),
      status: "requested",
      acknowledgedAtIso: null,
      supersededByRequestIdentifier: null,
      deliveredAtCheckpointCount: 0,
      deliveredAtIso: null,
    };
    this.requestsByIdentifier.set(successor.requestIdentifier, successor);
    for (const identifier of convergedRequestIdentifiers) {
      const request = this.requestsByIdentifier.get(identifier);
      if (request !== undefined) {
        request.supersededByRequestIdentifier = successor.requestIdentifier;
      }
    }
    return {
      convergedRequestIdentifiers,
      successorRequestIdentifier: successor.requestIdentifier,
    };
  }

  /** watchdog 决策：不得用旧指令续跑，也不得在取消未收敛时续跑。 */
  decideWatchdogResume(input: {
    taskIdentifier: string;
    instructionRevision: number;
    maximumWaitMilliseconds: number;
    nowIso: string;
  }): WatchdogResumeDecision {
    const requests = [...this.requestsByIdentifier.values()].filter(
      (request) => request.taskIdentifier === input.taskIdentifier,
    );
    const unknownStop = requests.find((request) => {
      if (request.status !== "requested") {
        return request.status === "unknown-stop-outcome";
      }
      return (
        Date.parse(input.nowIso) - Date.parse(request.requestedAtIso) >
        input.maximumWaitMilliseconds
      );
    });
    if (unknownStop !== undefined) {
      if (unknownStop.status === "requested") {
        unknownStop.status = "unknown-stop-outcome";
      }
      return { shouldResume: false, reason: "unknown-stop-outcome" };
    }
    const activeCancellation = requests.find(
      (request) =>
        request.status === "requested" || request.status === "acknowledged-stopped",
    );
    if (activeCancellation !== undefined) {
      return { shouldResume: false, reason: "cancellation-active" };
    }
    const supersededRequest = requests.find(
      (request) =>
        request.status === "superseded" &&
        request.instructionRevision > input.instructionRevision,
    );
    if (supersededRequest !== undefined) {
      return { shouldResume: false, reason: "instruction-superseded" };
    }
    return { shouldResume: true, reason: "no-active-cancellation" };
  }

  listCheckpointCount(toolCallId: string): number {
    return this.requireExecution(toolCallId).checkpointSequence;
  }

  readRequest(requestIdentifier: string): CancellationRequest {
    const request = this.requestsByIdentifier.get(requestIdentifier);
    if (request === undefined) {
      throw new LongToolCoordinationError(
        "unknown-cancellation-request",
        "取消请求不存在: " + requestIdentifier,
      );
    }
    return { ...request };
  }

  private requireExecution(toolCallId: string): ExecutionState {
    const state = this.executionsByToolCallId.get(toolCallId);
    if (state === undefined) {
      throw new LongToolCoordinationError(
        "unknown-tool-call",
        "未登记的工具执行: " + toolCallId,
      );
    }
    return state;
  }
}
