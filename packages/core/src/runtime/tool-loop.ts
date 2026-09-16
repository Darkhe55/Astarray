/**
 * 工具执行循环（T07）。
 * 驱动 runtime 的多次迭代：文本增量累积 → 工具调用经 ToolPort 执行 →
 * 结果回填 → 再次调用 runtime，直到 success/error/cancelled 或达到最大迭代数。
 */
import type { AgentEvent } from "../core/events.js";
import type {
  AgentRunInput,
  ToolCallResult,
  ToolPort,
} from "../core/types.js";
import type { AgentRuntime } from "../core/types.js";
import type {
  AppliedGuidance,
  GuidanceSafePointKind,
} from "../guidance/guidance-control-queue.js";

/**
 * GUIDE-01-02：安全点端口。运行中的任务在模型调用前与每次工具执行前消费控制队列；
 * 消费发生在循环内，**不等整链结束**。
 */
export interface GuidanceSafePointPort {
  consumeAtSafePoint(input: {
    safePointKind: GuidanceSafePointKind;
    iterationCount: number;
    toolName?: string;
  }): Promise<AppliedGuidance[]>;
}

export interface ToolLoopOptions {
  runtime: AgentRuntime;
  toolPort: ToolPort;
  maxLoopIterations: number;
  cancellationSignal: AbortSignal;
  /** 工具结果注入 provider 的格式（默认 OpenAI 风格 role=function）。 */
  buildToolResultMessage?: (
    callId: string,
    toolName: string,
    result: ToolCallResult,
  ) => unknown;
  /** GUIDE-01-02：安全点消费端口（缺省表示不接受运行中指导）。 */
  guidanceSafePointPort?: GuidanceSafePointPort;
  /** 指导应用回执（用于写工作存档/审计；不改变控制流）。 */
  onGuidanceApplied?: (application: AppliedGuidance) => void;
}

function buildGuidanceInjectionMessage(application: AppliedGuidance): unknown {
  return {
    role: "system",
    name: "runtime-guidance",
    content:
      "[运行中指导 " +
      application.guidanceIdentifier +
      "@" +
      String(application.guidanceRevision) +
      "] " +
      application.instructionText,
  };
}

export interface ToolLoopOutcome {
  reason:
    | "success"
    | "tool-failure-threshold"
    | "ambiguous"
    | "max-iterations"
    | "cancelled"
    | "error";
  detail: string;
  iterationCount: number;
}

export async function runToolLoop(
  agentRunInput: AgentRunInput,
  options: ToolLoopOptions,
): Promise<AsyncIterable<AgentEvent>> {
  let iterationCount = 0;
  const assistantTextBuffer: string[] = [];
  const toolResultMessages: unknown[] = [];
  let outcome: ToolLoopOutcome = {
    reason: "error",
    detail: "循环未产生结果",
    iterationCount: 0,
  };

  const eventStream: AgentEvent[] = [];
  const push = (event: AgentEvent): void => {
    eventStream.push(event);
  };

  while (iterationCount < options.maxLoopIterations) {
    iterationCount += 1;
    let iterationReason: Extract<AgentEvent, { kind: "runFinished" }>["reason"] =
      "error";
    let iterationDetail = "未知迭代结果";
    const pendingToolCalls: Array<{
      callId: string;
      toolName: string;
      argumentsJson: string;
    }> = [];

    // 安全点 1：模型调用前消费控制队列（busy 期间即时应用）。
    const beforeModelGuidance =
      (await options.guidanceSafePointPort?.consumeAtSafePoint({
        safePointKind: "before-model-call",
        iterationCount,
      })) ?? [];
    for (const application of beforeModelGuidance) {
      toolResultMessages.push(buildGuidanceInjectionMessage(application));
      options.onGuidanceApplied?.(application);
    }

    const iterationInput: AgentRunInput = {
      ...agentRunInput,
      toolResultMessages: [...toolResultMessages],
    };
    for await (const event of options.runtime.run(
      iterationInput,
      options.cancellationSignal,
    )) {
      if (event.kind === "textDelta") {
        assistantTextBuffer.push(event.deltaText);
        push(event);
        continue;
      }
      if (event.kind === "toolCallRequested") {
        pendingToolCalls.push({
          callId: event.callId,
          toolName: event.toolName,
          argumentsJson: event.argumentsJson,
        });
        push(event);
        continue;
      }
      if (event.kind === "runFinished") {
        iterationReason = event.reason;
        iterationDetail = event.detail;
        continue;
      }
      push(event);
    }

    if (iterationReason === "success") {
      outcome = {
        reason: "success",
        detail: iterationDetail,
        iterationCount,
      };
      break;
    }
    if (
      iterationReason === "error" ||
      iterationReason === "cancelled" ||
      iterationReason === "tool-failure-threshold" ||
      iterationReason === "ambiguous"
    ) {
      outcome = { reason: iterationReason, detail: iterationDetail, iterationCount };
      break;
    }
    if (pendingToolCalls.length === 0) {
      outcome = {
        reason: "error",
        detail: `迭代 ${iterationCount} 无工具调用且未完成`,
        iterationCount,
      };
      break;
    }

    for (const toolCall of pendingToolCalls) {
      // 安全点 2：工具执行前消费控制队列。
      const beforeToolGuidance =
        (await options.guidanceSafePointPort?.consumeAtSafePoint({
          safePointKind: "before-tool-execution",
          iterationCount,
          toolName: toolCall.toolName,
        })) ?? [];
      for (const application of beforeToolGuidance) {
        toolResultMessages.push(buildGuidanceInjectionMessage(application));
        options.onGuidanceApplied?.(application);
      }
      // 门禁档：立即门禁并请求暂停——不执行该工具调用，改为返回门禁回执。
      const isGated = beforeToolGuidance.some(
        (application) =>
          application.behaviorTier === "gate-and-request-pause",
      );
      const toolResult: ToolCallResult = isGated
        ? {
            kind: "error",
            callId: toolCall.callId,
            errorCode: "guidance-gate-requested-pause",
            errorMessage:
              "运行中指导要求立即门禁：已阻止本次工具执行并请求暂停以获得人工裁决",
            isIdempotencyConfirmed: true,
          }
        : await options.toolPort.execute(
            toolCall.toolName,
            toolCall.argumentsJson,
            toolCall.callId,
            options.cancellationSignal,
          );
      push({
        kind: "toolCallFinished",
        callId: toolCall.callId,
        result: toolResult.kind,
        outputSummary: truncate(toolResult.kind === "success" ? toolResult.outputText : toolResult.errorMessage),
        errorCode: toolResult.kind === "error" ? toolResult.errorCode : undefined,
      });
      // 将工具结果作为下一轮输入的一部分
      toolResultMessages.push(
        options.buildToolResultMessage?.(
          toolCall.callId,
          toolCall.toolName,
          toolResult,
        ) ?? {
          role: "function",
          tool_call_id: toolCall.callId,
          name: toolCall.toolName,
          content: toolResult.kind === "success"
            ? toolResult.outputText
            : `错误(${toolResult.errorCode}): ${toolResult.errorMessage}`,
        },
      );
    }
  }

  if (iterationCount >= options.maxLoopIterations && outcome.reason === "error") {
    outcome = {
      reason: "max-iterations",
      detail: `达到最大迭代次数 ${options.maxLoopIterations}`,
      iterationCount,
    };
  }
  push({
    kind: "runFinished",
    agentId: agentRunInput.agentId,
    reason: mapOutcomeToEventReason(outcome.reason),
    detail: outcome.detail,
  });

  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of eventStream) {
        yield event;
      }
    },
  };
}

function mapOutcomeToEventReason(
  reason: ToolLoopOutcome["reason"],
): Extract<AgentEvent, { kind: "runFinished" }>["reason"] {
  switch (reason) {
    case "success":
      return "success";
    case "tool-failure-threshold":
      return "tool-failure-threshold";
    case "ambiguous":
      return "ambiguous";
    case "max-iterations":
      return "max-iterations";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
  }
}

function truncate(text: string, maximumLength = 200): string {
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength)}…`;
}
