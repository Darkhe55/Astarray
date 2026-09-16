/**
 * GUIDE-01-03：长工具检查点与协作取消的反例。
 */
import { describe, expect, it } from "vitest";

import { GuidanceControlQueue } from "../../../packages/core/src/runtime-guidance/guidance-control-queue.js";
import {
  LongToolCheckpointController,
  LongToolCoordinationError,
} from "../../../packages/core/src/runtime-guidance/long-tool-checkpoint.js";
import {
  GuidanceSourceRegistry,
  buildRuntimeGuidanceEvent,
} from "../../../packages/core/src/runtime-guidance/runtime-guidance.js";

const NOW = "2026-09-16T00:00:00.000Z";
const STARTED = "2026-09-15T23:59:00.000Z";
const TARGET = {
  missionIdentifier: "mission-1",
  taskIdentifier: "task-1",
  resourceIdentifier: null,
};

function createGuidanceQueue(): GuidanceControlQueue {
  const registry = new GuidanceSourceRegistry();
  registry.register({
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    maximumBehaviorTier: "gate-and-request-pause",
    registeredAtIso: NOW,
  });
  return new GuidanceControlQueue({ sourceRegistry: registry });
}

function buildGuidance(guidanceIdentifier: string, sequence: number) {
  return buildRuntimeGuidanceEvent({
    guidanceIdentifier,
    guidanceRevision: 1,
    sequence,
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    issuedAtIso: NOW,
    expiresAtIso: null,
    behaviorTier: "safe-point-guidance",
    scope: {
      scopeKind: "task",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      resourceIdentifier: null,
    },
    instructionText: "长工具中途修正方向",
  });
}

function beginExecution(controller: LongToolCheckpointController, toolCallId = "tool-call-1") {
  return controller.beginToolExecution({
    toolCallId,
    taskIdentifier: "task-1",
    startedAtIso: STARTED,
    isCancellableAtSafePoint: true,
  });
}

describe("GUIDE-01-03 长工具检查点与协作取消", () => {
  it("长工具检查点消费运行中指导并生成回执", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    const queue = createGuidanceQueue();
    beginExecution(controller);
    queue.enqueueControlGuidance({
      event: buildGuidance("guide-long-tool", 1),
      target: TARGET,
      nowIso: NOW,
    });

    const receipt = controller.runCheckpoint({
      toolCallId: "tool-call-1",
      safePointKind: "before-tool-execution",
      target: TARGET,
      guidanceQueue: queue,
      nowIso: NOW,
    });
    expect(receipt.checkpointSequence).toBe(1);
    expect(receipt.appliedGuidanceIdentifiers).toEqual(["guide-long-tool"]);
    expect(receipt.elapsedMilliseconds).toBe(60_000);
    expect(receipt.executionEpoch).toBe(1);
    expect(controller.listCheckpointCount("tool-call-1")).toBe(1);
  });

  it("取消请求只在下一个检查点交付，不假定在途插入", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    const queue = createGuidanceQueue();
    beginExecution(controller);
    const request = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "用户要求换方案",
      instructionRevision: 1,
    });
    // 请求后状态仍是 requested：没有任何"已停止"的乐观声明。
    expect(request.status).toBe("requested");
    expect(request.deliveredAtCheckpointCount).toBe(0);

    const receipt = controller.runCheckpoint({
      toolCallId: "tool-call-1",
      safePointKind: "before-tool-execution",
      target: TARGET,
      guidanceQueue: queue,
      nowIso: NOW,
    });
    expect(receipt.deliveredCancellationRequestIdentifiers).toEqual([
      request.requestIdentifier,
    ]);
    expect(controller.readRequest(request.requestIdentifier).deliveredAtCheckpointCount).toBe(1);
    expect(controller.readRequest(request.requestIdentifier).status).toBe("requested");
  });

  it("工具回执停止后，完成声明无效（rejected-cancelled）", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    beginExecution(controller);
    const request = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "停止写入",
      instructionRevision: 1,
    });
    const acknowledged = controller.acknowledgeCancellation({
      requestIdentifier: request.requestIdentifier,
      outcome: "stopped",
      observedAtIso: "2026-09-16T00:00:30.000Z",
    });
    expect(acknowledged.status).toBe("acknowledged-stopped");

    const completion = controller.declareToolCompletion({
      toolCallId: "tool-call-1",
      executionEpoch: 1,
      outputSummary: "迟到的完成声明",
    });
    expect(completion.outcome).toBe("rejected-cancelled");
  });

  it("观察窗口内无回执 → 停止结果未知并按 blocked 处理", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    beginExecution(controller);
    const request = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "取消但工具无响应",
      instructionRevision: 1,
    });
    const status = controller.evaluateStopOutcome({
      requestIdentifier: request.requestIdentifier,
      nowIso: "2026-09-16T00:05:00.000Z",
      maximumWaitMilliseconds: 60_000,
    });
    expect(status).toBe("unknown-stop-outcome");

    const completion = controller.declareToolCompletion({
      toolCallId: "tool-call-1",
      executionEpoch: 1,
      outputSummary: "结果不明的输出",
    });
    expect(completion.outcome).toBe("unknown-stop-outcome");
    expect(completion.reason).toContain("blocked");
  });

  it("旧执行世的完成声明失效", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    beginExecution(controller);
    const accepted = controller.declareToolCompletion({
      toolCallId: "tool-call-1",
      executionEpoch: 1,
      outputSummary: "第一次执行完成",
    });
    expect(accepted.outcome).toBe("accepted");

    // 取消后重新发起的新执行世。
    beginExecution(controller);
    const lateDeclaration = controller.declareToolCompletion({
      toolCallId: "tool-call-1",
      executionEpoch: 1,
      outputSummary: "旧世的迟到声明",
    });
    expect(lateDeclaration.outcome).toBe("stale-epoch-invalidated");
    expect(lateDeclaration.reason).toContain("旧执行世");
  });

  it("新指导收敛旧请求，新请求承接最新指导 revision", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    beginExecution(controller);
    const oldRequest = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "第一版取消",
      instructionRevision: 1,
    });
    const convergence = controller.convergeSupersededRequests({
      taskIdentifier: "task-1",
      activeInstructionRevision: 2,
      reason: "第二版指导要求换目标",
    });
    expect(convergence.convergedRequestIdentifiers).toEqual([
      oldRequest.requestIdentifier,
    ]);
    expect(convergence.successorRequestIdentifier).not.toBeNull();
    const oldRead = controller.readRequest(oldRequest.requestIdentifier);
    expect(oldRead.status).toBe("superseded");
    expect(oldRead.supersededByRequestIdentifier).toBe(
      convergence.successorRequestIdentifier,
    );
    const successor = controller.readRequest(convergence.successorRequestIdentifier ?? "");
    expect(successor.instructionRevision).toBe(2);
    expect(successor.status).toBe("requested");
    expect(successor.deliveredAtCheckpointCount).toBe(0);
  });

  it("watchdog 不误续跑旧指令/未收敛取消", () => {
    const controller = new LongToolCheckpointController(() => NOW);
    beginExecution(controller);
    expect(
      controller.decideWatchdogResume({
        taskIdentifier: "task-1",
        instructionRevision: 1,
        maximumWaitMilliseconds: 60_000,
        nowIso: NOW,
      }),
    ).toEqual({ shouldResume: true, reason: "no-active-cancellation" });

    const request = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "取消",
      instructionRevision: 2,
    });
    controller.acknowledgeCancellation({
      requestIdentifier: request.requestIdentifier,
      outcome: "stopped",
      observedAtIso: NOW,
    });
    expect(
      controller.decideWatchdogResume({
        taskIdentifier: "task-1",
        instructionRevision: 2,
        maximumWaitMilliseconds: 60_000,
        nowIso: NOW,
      }),
    ).toEqual({ shouldResume: false, reason: "cancellation-active" });

    // 未知停止结果同样不得续跑。
    const second = controller.requestCooperativeCancellation({
      toolCallId: "tool-call-1",
      reason: "第二次取消",
      instructionRevision: 3,
    });
    expect(
      controller.decideWatchdogResume({
        taskIdentifier: "task-1",
        instructionRevision: 3,
        maximumWaitMilliseconds: 60_000,
        nowIso: "2026-09-16T00:05:00.000Z",
      }),
    ).toEqual({ shouldResume: false, reason: "unknown-stop-outcome" });
    expect(controller.readRequest(second.requestIdentifier).status).toBe(
      "unknown-stop-outcome",
    );

    expect(() =>
      controller.declareToolCompletion({
        toolCallId: "tool-call-unknown",
        executionEpoch: 1,
        outputSummary: "x",
      }),
    ).toThrow(LongToolCoordinationError);
  });
});
