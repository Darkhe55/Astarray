/**
 * Anthropic Messages 与 Gemini 原生适配器（T07D-04 / T07D 任务卡 §6.3）。
 *
 * - Anthropic：Messages content blocks / tool_use / input_json_delta 流内累积 /
 *   stop reason / 版本 header（anthropic-version 显式记录）；
 * - Gemini：generateContent 原生 API（v1beta）流事件 / functionCall /
 *   usageMetadata；API 版本在目录显式记录；
 * - 适配器只转换事件，不执行工具、不自接受完成、不改权限/身份/任务状态。
 */
import { DomainError } from "../core/errors.js";
import { SseEventStreamParser } from "./sse-event-stream-parser.js";
import type {
  NormalizedProviderEvent,
  ProviderProtocolAdapter,
} from "./provider-protocol-port.js";

/** Anthropic 协议标识/版本。 */
export const ANTHROPIC_MESSAGES_PROTOCOL_NAME = "anthropic-messages";
export const ANTHROPIC_MESSAGES_API_VERSION = "2023-06-01";

/** Gemini 协议标识/版本（原生 Interactions 对应 generateContent v1beta）。 */
export const GEMINI_INTERACTIONS_PROTOCOL_NAME = "gemini-interactions";
export const GEMINI_INTERACTIONS_API_VERSION = "v1beta";

/**
 * Anthropic Messages 适配器。
 * 事件：message_start / content_block_start / content_block_delta
 * （text_delta | input_json_delta）/ content_block_stop / message_delta / error。
 * input_json_delta 按 block 累积，content_block_stop 时产出完整工具参数。
 */
export class AnthropicMessagesAdapter implements ProviderProtocolAdapter {
  readonly protocolName = ANTHROPIC_MESSAGES_PROTOCOL_NAME;
  readonly supportedApiVersion = ANTHROPIC_MESSAGES_API_VERSION;

  /** block index → 累积的工具参数 JSON。 */
  private accumulatedToolArgumentsByBlock = new Map<number, string>();

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

  private parseSseEvent(sseEvent: {
    eventName: string;
    data: string;
  }): NormalizedProviderEvent[] {
    if (sseEvent.eventName === "error") {
      try {
        const payload = JSON.parse(sseEvent.data) as { error?: { type?: string } };
        return [
          {
            schemaVersion: 1,
            eventType: "provider-error",
            stableErrorCode: String(payload.error?.type ?? "unknown"),
            isRetryable: false,
          },
        ];
      } catch {
        return [
          {
            schemaVersion: 1,
            eventType: "provider-error",
            stableErrorCode: "protocol-error",
            isRetryable: false,
          },
        ];
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(sseEvent.data) as unknown;
    } catch {
      throw new DomainError(
        "provider-protocol-error",
        `Anthropic SSE 数据不是合法 JSON: ${sseEvent.data.slice(0, 80)}`,
      );
    }
    switch (sseEvent.eventName) {
      case "message_start":
        return [
          {
            schemaVersion: 1,
            eventType: "response-started",
            providerRequestIdentifier: String(
              (payload as { message?: { id?: unknown } }).message?.id ??
                "anthropic-message-unknown",
            ),
          },
        ];
      case "content_block_start": {
        const block = payload as { index?: number; content_block?: { type?: string; name?: string } };
        if (block.content_block?.type === "tool_use" && block.content_block.name !== undefined) {
          const blockIndex = block.index ?? 0;
          this.accumulatedToolArgumentsByBlock.set(blockIndex, "");
          return [
            {
              schemaVersion: 1,
              eventType: "tool-call-started",
              toolCallIdentifier: `anthropic-block-${blockIndex}`,
              toolName: block.content_block.name,
            },
          ];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = payload as { index?: number; delta?: { type?: string; text?: string; partial_json?: string } };
        const blockIndex = delta.index ?? 0;
        if (delta.delta?.type === "text_delta" && delta.delta.text !== undefined) {
          return [
            {
              schemaVersion: 1,
              eventType: "text-delta",
              textDelta: delta.delta.text,
            },
          ];
        }
        if (delta.delta?.type === "input_json_delta" && delta.delta.partial_json !== undefined) {
          const accumulated =
            this.accumulatedToolArgumentsByBlock.get(blockIndex) ?? "";
          this.accumulatedToolArgumentsByBlock.set(blockIndex, accumulated + delta.delta.partial_json);
          return [
            {
              schemaVersion: 1,
              eventType: "tool-arguments-delta",
              toolCallIdentifier: `anthropic-block-${blockIndex}`,
              argumentsDelta: delta.delta.partial_json,
            },
          ];
        }
        return [];
      }
      case "content_block_stop": {
        const block = payload as { index?: number };
        const blockIndex = block.index ?? 0;
        const accumulated =
          this.accumulatedToolArgumentsByBlock.get(blockIndex);
        if (accumulated !== undefined) {
          this.accumulatedToolArgumentsByBlock.delete(blockIndex);
          return [
            {
              schemaVersion: 1,
              eventType: "tool-call-completed",
              toolCallIdentifier: `anthropic-block-${blockIndex}`,
              finalArgumentsJson: accumulated || "{}",
            },
          ];
        }
        return [];
      }
      case "message_delta": {
        const delta = payload as { delta?: { stop_reason?: string } };
        if (delta.delta?.stop_reason !== undefined) {
          return [
            {
              schemaVersion: 1,
              eventType: "provider-completed",
              providerStopReason: delta.delta.stop_reason,
            },
          ];
        }
        return [];
      }
      default:
        return []; // 未知事件：跳过
    }
  }
}

interface GeminiCandidatePart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

/**
 * Gemini generateContent（v1beta）适配器。
 * 流 chunk：data: {"candidates":[{"content":{"parts":[{text|functionCall}]}}],
 * "usageMetadata":{...}}。parts 增量逐块产出；functionCall 参数一次性给出。
 */
export class GeminiInteractionsAdapter implements ProviderProtocolAdapter {
  readonly protocolName = GEMINI_INTERACTIONS_PROTOCOL_NAME;
  readonly supportedApiVersion = GEMINI_INTERACTIONS_API_VERSION;

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

  private parseSseEvent(sseEvent: { eventName: string; data: string }): NormalizedProviderEvent[] {
    let payload: unknown;
    try {
      payload = JSON.parse(sseEvent.data) as unknown;
    } catch {
      throw new DomainError(
        "provider-protocol-error",
        `Gemini SSE 数据不是合法 JSON: ${sseEvent.data.slice(0, 80)}`,
      );
    }
    const data = payload as {
      candidates?: Array<{ content?: { parts?: GeminiCandidatePart[] } }>;
      error?: { code?: number; message?: string };
    };
    if (data.error !== undefined) {
      return [
        {
          schemaVersion: 1,
          eventType: "provider-error",
          stableErrorCode: String(data.error.code ?? "unknown"),
          isRetryable: false,
        },
      ];
    }
    const events: NormalizedProviderEvent[] = [];
    for (const candidate of data.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.text !== undefined) {
          events.push({
            schemaVersion: 1,
            eventType: "text-delta",
            textDelta: part.text,
          });
        }
        if (part.functionCall?.name !== undefined) {
          events.push({
            schemaVersion: 1,
            eventType: "tool-call-started",
            toolCallIdentifier: `gemini-function-${part.functionCall.name}`,
            toolName: part.functionCall.name,
          });
          const argumentsJson = JSON.stringify(part.functionCall.args ?? {});
          events.push({
            schemaVersion: 1,
            eventType: "tool-arguments-delta",
            toolCallIdentifier: `gemini-function-${part.functionCall.name}`,
            argumentsDelta: argumentsJson,
          });
          events.push({
            schemaVersion: 1,
            eventType: "tool-call-completed",
            toolCallIdentifier: `gemini-function-${part.functionCall.name}`,
            finalArgumentsJson: argumentsJson,
          });
        }
      }
    }
    // usageMetadata 出现表示本轮结束（无论本 chunk 是否含增量）
    if ((data as { usageMetadata?: unknown }).usageMetadata !== undefined) {
      events.push({
        schemaVersion: 1,
        eventType: "provider-completed",
        providerStopReason: "stop",
      });
    }
    return events;
  }
}