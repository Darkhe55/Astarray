/**
 * GUIDE-01-02：控制队列 + 安全点应用（busy 期间即时应用、普通报告不唤醒主 Agent、幂等）。
 */
import { describe, expect, it } from "vitest";

import {
  GuidanceControlQueue,
  createGuidanceFeedbackLanePublisher,
  type AppliedGuidance,
} from "../../../packages/core/src/runtime-guidance/guidance-control-queue.js";
import {
  GuidanceSourceRegistry,
  buildRuntimeGuidanceEvent,
  type GuidanceBehaviorTier,
  type RuntimeGuidanceEvent,
} from "../../../packages/core/src/runtime-guidance/runtime-guidance.js";
import { runToolLoop } from "../../../packages/core/src/runtime/tool-loop.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type {
  AgentRunInput,
  AgentRuntime,
  FeedbackMessage,
  ToolCallResult,
  ToolPort,
} from "../../../packages/core/src/core/types.js";

const NOW = "2026-09-16T00:00:00.000Z";
const TARGET = {
  missionIdentifier: "mission-1",
  taskIdentifier: "task-1",
  resourceIdentifier: null,
};

function createRegistry(): GuidanceSourceRegistry {
  const registry = new GuidanceSourceRegistry();
  registry.register({
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    maximumBehaviorTier: "gate-and-request-pause",
    registeredAtIso: NOW,
  });
  registry.register({
    sourceKind: "file-task-observation",
    sourceIdentifier: "observer-1",
    maximumBehaviorTier: "safe-point-guidance",
    registeredAtIso: NOW,
  });
  return registry;
}

function guidance(
  overrides: {
    guidanceIdentifier?: string;
    guidanceRevision?: number;
    sequence?: number;
    behaviorTier?: GuidanceBehaviorTier;
    expiresAtIso?: string | null;
    scope?: RuntimeGuidanceEvent["scope"];
    instructionText?: string;
  } = {},
): RuntimeGuidanceEvent {
  return buildRuntimeGuidanceEvent({
    guidanceIdentifier: overrides.guidanceIdentifier ?? "guide-1",
    guidanceRevision: overrides.guidanceRevision ?? 1,
    sequence: overrides.sequence ?? 1,
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    issuedAtIso: NOW,
    expiresAtIso: overrides.expiresAtIso ?? null,
    behaviorTier: overrides.behaviorTier ?? "safe-point-guidance",
    scope:
      overrides.scope ?? {
        scopeKind: "task",
        missionIdentifier: "mission-1",
        taskIdentifier: "task-1",
        resourceIdentifier: null,
      },
    instructionText: overrides.instructionText ?? "改为只读校验，不再写入",
  });
}

describe("GUIDE-01-02 控制队列与安全点", () => {
  it("busy 期间在第二个模型调用前即时应用（不等整链结束）", async () => {
    const queue = new GuidanceControlQueue({ sourceRegistry: createRegistry() });
    const applied: AppliedGuidance[] = [];
    const runtimeInputs: AgentRunInput[] = [];
    let iteration = 0;

    const runtime: AgentRuntime = {
      async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
        runtimeInputs.push(input);
        iteration += 1;
        if (iteration === 1) {
          yield {
            kind: "toolCallRequested",
            callId: "call-1",
            toolName: "write-file",
            argumentsJson: "{}",
          };
          yield {
            kind: "runFinished",
            agentId: "agent-1",
            reason: "tool-calls",
            detail: "需要工具",
          };
          return;
        }
        yield {
          kind: "runFinished",
          agentId: "agent-1",
          reason: "success",
          detail: "完成",
        };
      },
    };

    let toolExecuteCount = 0;
    const toolPort: ToolPort = {
      async execute(): Promise<ToolCallResult> {
        toolExecuteCount += 1;
        // 工具执行期间用户下达指导（长工具场景）。
        queue.enqueueControlGuidance({
          event: guidance(),
          target: TARGET,
          nowIso: NOW,
        });
        return {
          kind: "success",
          callId: "call-1",
          outputText: "done",
          isSideEffectFree: true,
        };
      },
    };

    const events: AgentEvent[] = [];
    const stream = await runToolLoop(
      {
        missionId: "mission-1",
        agentId: "agent-1",
        systemPrompt: "system",
        userPrompt: "user",
        availableToolDescriptors: [],
        maxLoopIterations: 4,
      },
      {
        runtime,
        toolPort,
        maxLoopIterations: 4,
        cancellationSignal: new AbortController().signal,
        guidanceSafePointPort: {
          consumeAtSafePoint: async (input) =>
            queue.consumeAtSafePoint({
              safePointKind: input.safePointKind,
              target: TARGET,
              nowIso: NOW,
            }).applied,
        },
        onGuidanceApplied: (application) => applied.push(application),
      },
    );
    for await (const event of stream) {
      events.push(event);
    }

    expect(toolExecuteCount).toBe(1);
    expect(runtimeInputs).toHaveLength(2);
    // 指导在第二个模型调用前注入（整链结束之前）。
    expect(applied).toHaveLength(1);
    expect(applied[0]?.guidanceIdentifier).toBe("guide-1");
    expect(
      JSON.stringify(runtimeInputs[1]?.toolResultMessages ?? []),
    ).toContain("运行中指导 guide-1@1");
    expect(
      events.some(
        (event) =>
          event.kind === "runFinished" && event.reason === "success",
      ),
    ).toBe(true);
    expect(queue.listPendingGuidance()).toEqual([]);
    expect(queue.listAppliedGuidance()).toHaveLength(1);
  });

  it("同一条指导重复入队只应用一次（幂等）", () => {
    const queue = new GuidanceControlQueue({ sourceRegistry: createRegistry() });
    const first = queue.enqueueControlGuidance({
      event: guidance(),
      target: TARGET,
      nowIso: NOW,
    });
    expect(first.status).toBe("accepted");
    const second = queue.enqueueControlGuidance({
      event: guidance(),
      target: TARGET,
      nowIso: NOW,
    });
    expect(second.status).toBe("recorded");
    expect(first.guidanceIdentifier).toBe(second.guidanceIdentifier);

    const consumption = queue.consumeAtSafePoint({
      safePointKind: "before-model-call",
      target: TARGET,
      nowIso: NOW,
    });
    expect(consumption.applied).toHaveLength(1);
    const again = queue.consumeAtSafePoint({
      safePointKind: "before-model-call",
      target: TARGET,
      nowIso: NOW,
    });
    expect(again.applied).toHaveLength(0);
    expect(queue.listAppliedGuidance()).toHaveLength(1);
  });

  it("跨作用域/过期指导在安全点被丢弃（不套用到别的任务）", () => {
    const queue = new GuidanceControlQueue({ sourceRegistry: createRegistry() });
    queue.enqueueControlGuidance({
      event: guidance({
        guidanceIdentifier: "guide-other-task",
        scope: {
          scopeKind: "task",
          missionIdentifier: "mission-1",
          taskIdentifier: "task-2",
          resourceIdentifier: null,
        },
      }),
      target: {
        missionIdentifier: "mission-1",
        taskIdentifier: "task-2",
        resourceIdentifier: null,
      },
      nowIso: NOW,
    });
    const crossScope = queue.consumeAtSafePoint({
      safePointKind: "before-model-call",
      target: TARGET,
      nowIso: NOW,
    });
    expect(crossScope.applied).toHaveLength(0);
    expect(crossScope.dropped[0]?.reason).toBe("cross-scope-at-safe-point");

    // 入队时仍有效，但在安全点消费前过期（入队时已过期的会被控制器直接拒绝）。
    queue.enqueueControlGuidance({
      event: guidance({
        guidanceIdentifier: "guide-expired",
        sequence: 2,
        expiresAtIso: "2026-09-16T01:00:00.000Z",
      }),
      target: TARGET,
      nowIso: NOW,
    });
    const expired = queue.consumeAtSafePoint({
      safePointKind: "before-model-call",
      target: TARGET,
      nowIso: "2026-09-16T02:00:00.000Z",
    });
    expect(expired.dropped[0]?.reason).toBe("expired-at-safe-point");
  });

  it("门禁档在工具执行前阻止该次调用并给出回执", async () => {
    const queue = new GuidanceControlQueue({ sourceRegistry: createRegistry() });
    let toolExecuteCount = 0;
    let runtimeIteration = 0;
    const runtime: AgentRuntime = {
      async *run(): AsyncIterable<AgentEvent> {
        runtimeIteration += 1;
        if (runtimeIteration === 1) {
          // 模型调用后、工具执行前用户下达门禁指导。
          queue.enqueueControlGuidance({
            event: guidance({
              guidanceIdentifier: "guide-gate",
              behaviorTier: "gate-and-request-pause",
              instructionText: "立即暂停并请求人工裁决",
            }),
            target: TARGET,
            nowIso: NOW,
          });
          yield {
            kind: "toolCallRequested",
            callId: "call-1",
            toolName: "write-file",
            argumentsJson: "{}",
          };
          yield {
            kind: "runFinished",
            agentId: "agent-1",
            reason: "tool-calls",
            detail: "需要工具",
          };
          return;
        }
        yield {
          kind: "runFinished",
          agentId: "agent-1",
          reason: "success",
          detail: "完成",
        };
      },
    };
    const toolPort: ToolPort = {
      async execute(): Promise<ToolCallResult> {
        toolExecuteCount += 1;
        return {
          kind: "success",
          callId: "call-1",
          outputText: "should-not-run",
          isSideEffectFree: true,
        };
      },
    };
    const events: AgentEvent[] = [];
    const stream = await runToolLoop(
      {
        missionId: "mission-1",
        agentId: "agent-1",
        systemPrompt: "system",
        userPrompt: "user",
        availableToolDescriptors: [],
        maxLoopIterations: 4,
      },
      {
        runtime,
        toolPort,
        maxLoopIterations: 4,
        cancellationSignal: new AbortController().signal,
        guidanceSafePointPort: {
          consumeAtSafePoint: async (input) =>
            queue.consumeAtSafePoint({
              safePointKind: input.safePointKind,
              target: TARGET,
              nowIso: NOW,
            }).applied,
        },
      },
    );
    for await (const event of stream) {
      events.push(event);
    }
    expect(toolExecuteCount).toBe(0);
    const gatedEvent = events.find(
      (event) =>
        event.kind === "toolCallFinished" &&
        event.errorCode === "guidance-gate-requested-pause",
    );
    expect(gatedEvent).toBeDefined();
  });

  it("普通报告入队不唤醒主 Agent（仅排队待读）", () => {
    const queue = new GuidanceControlQueue({ sourceRegistry: createRegistry() });
    const report = queue.enqueueOrdinaryReport({
      reportIdentifier: "report-1",
      recipientId: "main-agent",
      sourceIdentifier: "agent-1",
      summary: "任务进度 50%",
    });
    expect(report.shouldWakeMainAgent).toBe(false);
    expect(queue.listPlainReports()).toHaveLength(1);
    const wakePolicy = queue.readWakePolicy();
    expect(wakePolicy.control.wakesMainAgent).toBe(false);
    expect(wakePolicy.control.isAppliedToRunningMissionAtSafePoint).toBe(true);
    expect(wakePolicy.report.wakesMainAgent).toBe(false);
    expect(wakePolicy.report.isQueuedOnly).toBe(true);
  });

  it("跨进程投递：指导走 instruction、报告走 success，均不唤醒主 Agent", async () => {
    const delivered: FeedbackMessage[] = [];
    const publisher = createGuidanceFeedbackLanePublisher({
      transport: {
        enqueue: async (message: FeedbackMessage) => {
          delivered.push(message);
        },
      },
      recipientId: "secondary-agent-1",
      source: { sourceType: "user", sourceIdentifier: "user-1" },
      nowIso: () => NOW,
    });
    await publisher.publishAppliedGuidance({
      guidanceIdentifier: "guide-1",
      guidanceRevision: 2,
      behaviorTier: "safe-point-guidance",
      instructionText: "改为只读校验",
      appliedAtSafePoint: "before-model-call",
      appliedAtIso: NOW,
    });
    await publisher.publishPlainReport({
      reportIdentifier: "report-1",
      recipientId: "main-agent",
      sourceIdentifier: "agent-1",
      summary: "任务进度 50%",
      queuedAtIso: NOW,
      shouldWakeMainAgent: false,
    });
    expect(delivered.map((message) => message.payload.kind)).toEqual([
      "instruction",
      "success",
    ]);
    expect(delivered.map((message) => message.priority)).toEqual([
      "instruction",
      "success",
    ]);
    expect(delivered[0]?.idempotencyKey).toBe("guidance:guide-1@2");
    expect(delivered[1]?.idempotencyKey).toBe("report:report-1");
    expect(delivered[0]?.source).toEqual({
      sourceType: "user",
      sourceIdentifier: "user-1",
    });
  });
});
