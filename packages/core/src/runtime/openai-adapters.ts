/**
 * OpenAI 协议适配器（T07D-03 / T07D 任务卡 §6.3）。
 *
 * 分别实现 OpenAI Responses 与 Chat Completions（互不冒充），并实现
 * 通用 OpenAI-compatible 的 conformance 子集（基于 Chat Completions）。
 * 适配器只把厂商事件转换为规范事件流（NormalizedProviderEvent）；
 * 不直接执行工具、不自接受完成事件、不修改权限/Agent 身份/任务状态。
 */
import { DomainError } from "../core/errors.js";
import { SseEventStreamParser } from "./sse-event-stream-parser.js";
import type {
  NormalizedProviderEvent,
  ProviderProtocolAdapter,
} from "./provider-protocol-port.js";

/** OpenAI Responses 协议名/API 版本。 */
export const OPENAI_RESPONSES_PROTOCOL_NAME = "openai-responses";
export const OPENAI_RESPONSES_API_VERSION = "2025-03-01";

/** OpenAI Chat Completions 协议名/API 版本。 */
export const OPENAI_CHAT_COMPLETIONS_PROTOCOL_NAME = "openai-chat-completions";
export const OPENAI_CHAT_COMPLETIONS_API_VERSION = "2024-06-01";

/** 通用 OpenAI-compatible 协议名/API 版本（conformance 子集）。 */
export const GENERIC_OPENAI_COMPATIBLE_PROTOCOL_NAME = "generic-openai-compatible";
export const GENERIC_OPENAI_COMPATIBLE_API_VERSION = "2024-06-01";

interface OpenAiSseEvent {
  eventName: string;
  data: string;
}

/** 解析 SSE 事件 JSON 数据（无效 JSON 视为协议错误）。 */
function parseSseJsonData(data: string): unknown {
  if (data === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new DomainError(
      "provider-protocol-error",
      `OpenAI SSE 数据不是合法 JSON: ${data.slice(0, 80)}`,
    );
  }
}

/**
 * OpenAI Responses 适配器。
 * 事件：response.created / response.output_text.delta /
 * response.output_item.added / response.function_call_arguments.delta /
 * response.function_call_arguments.done / response.completed / response.failed。
 */
export class OpenAiResponsesAdapter implements ProviderProtocolAdapter {
  readonly protocolName = OPENAI_RESPONSES_PROTOCOL_NAME;
  readonly supportedApiVersion = OPENAI_RESPONSES_API_VERSION;

  async *parseEventStream(
    transportChunks: AsyncIterable<string>,
  ): AsyncIterable<NormalizedProviderEvent> {
    const sseParser = new SseEventStreamParser({
      cancellationSignal: new AbortController().signal,
    });
    for await (const sseEvent of sseParser.parseEventStream(transportChunks)) {
      const events = this.parseSseEvent(sseEvent);
      for (const event of events) {
        yield event;
      }
    }
  }

  private parseSseEvent(sseEvent: OpenAiSseEvent): NormalizedProviderEvent[] {
    const payload = parseSseJsonData(sseEvent.data);
    if (payload === null) {
      return [];
    }
    switch (sseEvent.eventName) {
      case "response.created":
        return [
          {
            schemaVersion: 1,
            eventType: "response-started",
            providerRequestIdentifier: String(
              (payload as { id?: unknown }).id ?? "response-unknown",
            ),
          },
        ];
      case "response.output_text.delta":
        return [
          {
            schemaVersion: 1,
            eventType: "text-delta",
            textDelta: String((payload as { delta?: unknown }).delta ?? ""),
          },
        ];
      case "response.output_item.added": {
        const item = payload as { type?: string; id?: string; name?: string };
        if (item.type === "function_call" && item.name !== undefined) {
          return [
            {
              schemaVersion: 1,
              eventType: "tool-call-started",
              toolCallIdentifier: String(item.id ?? "tool-call-unknown"),
              toolName: item.name,
            },
          ];
        }
        return [];
      }
      case "response.function_call_arguments.delta":
        return [
          {
            schemaVersion: 1,
            eventType: "tool-arguments-delta",
            toolCallIdentifier: String(
              (payload as { call_id?: unknown }).call_id ?? "tool-call-unknown",
            ),
            argumentsDelta: String(
              (payload as { delta?: unknown }).delta ?? "",
            ),
          },
        ];
      case "response.function_call_arguments.done":
        return [
          {
            schemaVersion: 1,
            eventType: "tool-call-completed",
            toolCallIdentifier: String(
              (payload as { call_id?: unknown }).call_id ?? "tool-call-unknown",
            ),
            finalArgumentsJson: String(
              (payload as { arguments?: unknown }).arguments ?? "{}",
            ),
          },
        ];
      case "response.completed":
        return [
          {
            schemaVersion: 1,
            eventType: "provider-completed",
            providerStopReason: String(
              (payload as { status?: unknown }).status ?? "completed",
            ),
          },
        ];
      case "response.failed": {
        const error = (payload as { error?: { code?: unknown } }).error;
        return [
          {
            schemaVersion: 1,
            eventType: "provider-error",
            stableErrorCode: String(error?.code ?? "unknown"),
            isRetryable: false,
          },
        ];
      }
      default:
        return []; // 未知事件：跳过
    }
  }
}

interface ChatChunkChoice {
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

/**
 * OpenAI Chat Completions 适配器（SSE chunks）。
 * data: {choices:[{delta:{content|tool_calls}, finish_reason}]}；
 * 工具调用参数增量按 toolCallIdentifier（id 或 index）流式产出。
 */
export class OpenAiChatCompletionsAdapter implements ProviderProtocolAdapter {
  protocolName: string = OPENAI_CHAT_COMPLETIONS_PROTOCOL_NAME;
  supportedApiVersion: string = OPENAI_CHAT_COMPLETIONS_API_VERSION;

  async *parseEventStream(
    transportChunks: AsyncIterable<string>,
  ): AsyncIterable<NormalizedProviderEvent> {
    const sseParser = new SseEventStreamParser({
      cancellationSignal: new AbortController().signal,
    });
    for await (const sseEvent of sseParser.parseEventStream(transportChunks)) {
      const events = this.parseSseEvent(sseEvent);
      for (const event of events) {
        yield event;
      }
    }
  }

  private parseSseEvent(sseEvent: OpenAiSseEvent): NormalizedProviderEvent[] {
    if (sseEvent.eventName === "error") {
      const payload = parseSseJsonData(sseEvent.data);
      return [
        {
          schemaVersion: 1,
          eventType: "provider-error",
          stableErrorCode: String(
            (payload as { error?: { code?: unknown } })?.error?.code ?? "unknown",
          ),
          isRetryable: false,
        },
      ];
    }
    const payload = parseSseJsonData(sseEvent.data);
    if (payload === null) {
      return [];
    }
    const choices = (payload as { choices?: ChatChunkChoice[] }).choices ?? [];
    const events: NormalizedProviderEvent[] = [];
    for (const choice of choices) {
      const delta = choice.delta ?? {};
      if (delta.content !== undefined && delta.content !== null) {
        events.push({
          schemaVersion: 1,
          eventType: "text-delta",
          textDelta: delta.content,
        });
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const toolCallIdentifier = String(toolCall.id ?? `tool-call-${toolCall.index ?? 0}`);
        if (toolCall.function?.name !== undefined) {
          events.push({
            schemaVersion: 1,
            eventType: "tool-call-started",
            toolCallIdentifier,
            toolName: toolCall.function.name,
          });
        }
        if (
          toolCall.function?.arguments !== undefined &&
          toolCall.function.arguments.length > 0
        ) {
          events.push({
            schemaVersion: 1,
            eventType: "tool-arguments-delta",
            toolCallIdentifier,
            argumentsDelta: toolCall.function.arguments,
          });
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        events.push({
          schemaVersion: 1,
          eventType: "provider-completed",
          providerStopReason: choice.finish_reason,
        });
      }
    }
    return events;
  }
}

/**
 * 通用 OpenAI-compatible 适配器：保证经过 conformance 的 Chat Completions
 * 公共子集；逐实现/版本记录验证结果（本文件只保证子集，不做全兼容承诺）。
 */
export class GenericOpenAiCompatibleAdapter extends OpenAiChatCompletionsAdapter {
  constructor() {
    super();
    this.protocolName = GENERIC_OPENAI_COMPATIBLE_PROTOCOL_NAME;
    this.supportedApiVersion = GENERIC_OPENAI_COMPATIBLE_API_VERSION;
  }
}