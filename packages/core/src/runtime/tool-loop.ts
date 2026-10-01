/**
 * 工具执行循环（T07）。
 * 驱动 runtime 的多次迭代：文本增量累积 → 工具调用经 ToolPort 执行 →
 * 结果回填 → 再次调用 runtime，直到 success/error/cancelled 或达到最大迭代数。
 */
import type { AgentEvent } from "../core/events.js";
import { TASK_COMPLETION_MARKER } from "../core/completion-protocol.js";
import type {
  AgentRunInput,
  ToolCallResult,
  ToolPort,
} from "../core/types.js";
import type { AgentRuntime } from "../core/types.js";
import type {
  AppliedGuidance,
  GuidanceSafePointKind,
} from "../runtime-guidance/guidance-control-queue.js";

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
  /**
   * 覆盖工具结果消息形态（默认已按 OpenAI Chat Completions 规范构造
   * `role="tool"` + `tool_call_id`；仅在特殊 provider 适配时覆盖）。
   */
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

/**
 * 续发消息（OpenAI Chat Completions 规范）：
 * 工具调用后必须**先**回填 assistant 的 `tool_calls`，**再**逐条给出 `role="tool"` 结果，
 * 且 `tool_call_id` 一一对应。实测（stepfun `step-3.7-flash`，2026-10-01）：
 * 只发 `role="function"` 的结果会被真实端点以
 * `400 invalid msg role: function` 拒绝。
 */
export interface AssistantToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolRoleResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** 运行中指导注入消息（本地约定：system 角色，非 OpenAI 工具协议的一部分）。 */
export interface GuidanceInjectionMessage {
  role: "system";
  name: string;
  content: string;
}

export type ProviderConversationMessage =
  | AssistantToolCallMessage
  | ToolRoleResultMessage
  | GuidanceInjectionMessage;

function buildGuidanceInjectionMessage(application: AppliedGuidance): GuidanceInjectionMessage {
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

/** 工具执行结果 → 回填文本（与既有 `role=function` 时代的内容保持一致）。 */
export function toToolResultContent(result: ToolCallResult): string {
  return result.kind === "success"
    ? result.outputText
    : `错误(${result.errorCode}): ${result.errorMessage}`;
}

/**
 * 工具执行后的本地完成协议重述（2026-10-01 真实服务实测补充）。
 *
 * 真实模型常在**发起工具调用前**就输出过完成控制事件，工具执行后只回一句简短/空结论，
 * **不再重复**该事件；而本地完成门禁按设计只认最终输出的独立末行事件，
 * 于是任务被判 `blocked`（实测 stepfun `step-3.7-flash`）。
 *
 * 该消息只做"让模型知道协议"，**不降低门禁强度**：事件仍须由模型给出、
 * 仍由本地 verifier 结案；文案中的标识直接取自协议常量，避免与 schema 漂移。
 */
export function buildCompletionProtocolRestatement(): GuidanceInjectionMessage {
  return {
    role: "system",
    name: "local-completion-protocol",
    content:
      "[本地完成协议] 你可以调用工具继续工作；但只要本轮尚未结束，你的**最终回复**必须包含版本化完成控制事件。\n" +
      `格式：最终输出的**最后一行**为独立一行 \`${TASK_COMPLETION_MARKER} <json>\`，` +
      'JSON 字段固定为 taskExecutionId、completionAttemptId（本轮一次性、不可复用）、' +
      'completedTaskIdentifiers（非空数组）、claimedStatus（固定 "complete"）、taskSequenceRevision（非负整数）。\n' +
      "工具执行成功不等于任务结案：必须先确认任务要求的产物/状态已按本地事实达成，再输出该事件；" +
      "若未达成，请不要输出完成事件，改为说明当前状态。\n" +
      "工具选择提示（本地事实）：`createProjectFile` 是**仅新建、不覆盖**的工具——目标已存在时它会自行拒绝并返回错误；" +
      "因此**无需先做\"文件是否已存在\"的预检探查**，直接调用并按返回值判断即可；" +
      "若探查工具因授权边界不可用，不要据此放弃创建，直接尝试创建并依据其返回结果决定下一步。",
  };
}


/** 一次迭代内产生的工具调用（assistant 消息需要完整回填）。 */
function buildAssistantToolCallMessage(
  toolCalls: Array<{ callId: string; toolName: string; argumentsJson: string }>,
): AssistantToolCallMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.callId,
      type: "function",
      function: {
        name: toolCall.toolName,
        arguments: toolCall.argumentsJson,
      },
    })),
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
  const conversationMessages: ProviderConversationMessage[] = [];
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
      conversationMessages.push(buildGuidanceInjectionMessage(application));
      options.onGuidanceApplied?.(application);
    }

    const iterationInput: AgentRunInput = {
      ...agentRunInput,
      toolResultMessages: [...conversationMessages],
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

    // OpenAI 规范：先把本轮全部 assistant tool_calls 回填，再逐条给出 tool 结果。
    conversationMessages.push(buildAssistantToolCallMessage(pendingToolCalls));

    for (const toolCall of pendingToolCalls) {
      // 安全点 2：工具执行前消费控制队列。
      const beforeToolGuidance =
        (await options.guidanceSafePointPort?.consumeAtSafePoint({
          safePointKind: "before-tool-execution",
          iterationCount,
          toolName: toolCall.toolName,
        })) ?? [];
      for (const application of beforeToolGuidance) {
        conversationMessages.push(buildGuidanceInjectionMessage(application));
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
      // 将工具结果作为下一轮输入的一部分（默认按 OpenAI 规范 role="tool"）。
      conversationMessages.push(
        (options.buildToolResultMessage?.(
          toolCall.callId,
          toolCall.toolName,
          toolResult,
        ) as ProviderConversationMessage | undefined) ?? {
          role: "tool",
          tool_call_id: toolCall.callId,
          content: toToolResultContent(toolResult),
        },
      );
    }
    // 本轮工具执行完毕：重申本地完成协议（真实模型常在工具执行后不再重复完成事件）。
    conversationMessages.push(buildCompletionProtocolRestatement());
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
