/**
 * Anthropic Messages 协议运行时（2026-10-02，多协议装配第一步）。
 *
 * 与 `OpenAiCompatibleRuntime` 同契约（AgentRuntime）：单次 run = 一次 provider 迭代，
 * 产出流式文本增量、工具调用声明与结束原因；工具执行循环由 ToolLoop 驱动。
 *
 * 协议要点（Anthropic Messages + SSE）：
 * - 鉴权用 `x-api-key`（不是 Bearer）；另有 `anthropic-version` 头；
 * - system 走**顶层** `system` 字段，messages 里不接受 system 角色；
 * - 工具结果必须是 **user** 消息内的 `tool_result` 块（不是 OpenAI 的 role="tool"）；
 * - `max_tokens` 必填；
 * - 流事件：`message_start` / `content_block_start` / `content_block_delta`
 *   （text_delta 或 input_json_delta）/ `content_block_stop` / `message_delta`（stop_reason）/ `message_stop`。
 *
 * API key 绝不进入日志/错误/事件：错误消息只含稳定领域信息。
 */
import { DomainError } from "../core/errors.js";
import type { AgentEvent } from "../core/events.js";
import type { AgentRunInput, AgentRuntime, ToolDescriptor } from "../core/types.js";
// 复用既有适配器导出的协议标识与 API 版本，避免第二份定义漂移。
import {
  ANTHROPIC_MESSAGES_API_VERSION,
  ANTHROPIC_MESSAGES_PROTOCOL_NAME,
} from "./anthropic-gemini-adapters.js";

export const ANTHROPIC_MESSAGES_PROTOCOL = ANTHROPIC_MESSAGES_PROTOCOL_NAME;
export const ANTHROPIC_API_VERSION_HEADER_VALUE = ANTHROPIC_MESSAGES_API_VERSION;
/** 运行时协议版本（记录到 provider 注册；与 API 版本区分：后者是请求头值）。 */
export const ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION = "messages/stream-tools-2026-10-02";
/** `max_tokens` 为 Anthropic 必填项；取一个足够完成受控改动的保守上限。 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4_096;

export interface AnthropicMessagesRuntimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMilliseconds: number;
  /** 可注入以便测试。 */
  fetchImpl?: typeof fetch;
  /** 覆盖 `anthropic-version` 头（默认 2023-06-01）。 */
  anthropicVersion?: string;
  maxTokens?: number;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
}

export class AnthropicMessagesRuntime implements AgentRuntime {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicMessagesRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const requestBody = buildMessagesRequestBody(
      agentRunInput,
      this.options.model,
      this.options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    );
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, this.options.requestTimeoutMilliseconds);
    const cancellationListener = () => {
      abortController.abort();
    };
    cancellationSignal.addEventListener("abort", cancellationListener);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.options.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.options.apiKey,
            "anthropic-version":
              this.options.anthropicVersion ?? ANTHROPIC_API_VERSION_HEADER_VALUE,
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });
      } catch {
        if (cancellationSignal.aborted) {
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: "cancelled",
            detail: "Provider 请求被取消",
          };
          return;
        }
        throw new DomainError(
          "provider-timeout",
          `Provider 请求失败或超时（${this.options.requestTimeoutMilliseconds}ms）`,
        );
      }
      if (!response.ok || !response.body) {
        throw new DomainError(
          "provider-timeout",
          `Provider 返回非 2xx: ${response.status} ${response.statusText}`,
        );
      }

      // 按 content block 累积：文本块直接转发；tool_use 块累积 id/name/部分 JSON。
      const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
      let finalStopReason: string | null = null;

      for await (const event of readAnthropicStreamEvents(response.body)) {
        if (cancellationSignal.aborted) {
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: "cancelled",
            detail: "流式输出被取消",
          };
          return;
        }
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolCallsByIndex.set(event.index ?? 0, {
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
            arguments: "",
          });
          continue;
        }
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text !== undefined) {
            yield { kind: "textDelta", deltaText: event.delta.text };
            continue;
          }
          if (event.delta?.type === "input_json_delta") {
            const current = toolCallsByIndex.get(event.index ?? 0);
            if (current !== undefined && event.delta.partial_json !== undefined) {
              current.arguments += event.delta.partial_json;
            }
            continue;
          }
          continue;
        }
        if (event.type === "message_delta" && event.delta?.stop_reason !== undefined) {
          finalStopReason = event.delta.stop_reason;
          continue;
        }
      }

      for (const toolCall of toolCallsByIndex.values()) {
        yield {
          kind: "toolCallRequested",
          callId: toolCall.id,
          toolName: toolCall.name,
          argumentsJson: toolCall.arguments,
        };
      }
      if (toolCallsByIndex.size > 0) {
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "tool-calls",
          detail: `请求工具调用 ${toolCallsByIndex.size} 个`,
        };
        return;
      }
      // Anthropic 正常结束为 end_turn；stop_sequence 亦视为正常收尾。
      if (finalStopReason === "end_turn" || finalStopReason === "stop_sequence") {
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "success",
          detail: "Provider 输出完成",
        };
        return;
      }
      throw new DomainError(
        "provider-timeout",
        `Provider 异常结束: stop_reason=${finalStopReason ?? "未知"}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
      cancellationSignal.removeEventListener("abort", cancellationListener);
    }
  }
}

/** 构造 Anthropic Messages 请求体（system 走顶层；工具结果走 user + tool_result 块）。 */
export function buildMessagesRequestBody(
  agentRunInput: AgentRunInput,
  model: string,
  maxTokens: number,
): unknown {
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: agentRunInput.systemPrompt,
    messages: [
      { role: "user", content: agentRunInput.userPrompt },
      ...convertPriorMessagesToAnthropicMessages(agentRunInput.toolResultMessages ?? []),
    ],
    tools: agentRunInput.availableToolDescriptors.map((descriptor: ToolDescriptor) => ({
      name: descriptor.name,
      description: descriptor.summary,
      input_schema: descriptor.inputSchema ?? { type: "object", properties: {} },
    })),
    tool_choice: { type: "auto" },
  };
}

interface UnknownMessageRecord {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
}

/**
 * 把前序迭代消息转换为 Anthropic 形态。
 *
 * ToolLoop 默认按 OpenAI 规范回填（`role="tool"`、`assistant.tool_calls`）；
 * Anthropic 要求：
 *  - assistant 的工具调用是 `content: [{type:"tool_use", id, name, input}]`；
 *  - 工具结果是 **user** 消息里的 `content: [{type:"tool_result", tool_use_id, content}]`；
 *  - 相邻同角色消息必须合并为一条（Anthropic 要求 user/assistant 交替）。
 */
export function convertPriorMessagesToAnthropicMessages(
  priorMessages: unknown[],
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const converted: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const rawMessage of priorMessages) {
    if (rawMessage === null || typeof rawMessage !== "object") {
      continue;
    }
    const message = rawMessage as UnknownMessageRecord;
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "tool") {
      appendAnthropicMessage(converted, "user", [
        {
          type: "tool_result",
          tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
          content: typeof message.content === "string" ? message.content : "",
        },
      ]);
      continue;
    }
    if (role === "assistant") {
      const contentBlocks: unknown[] = [];
      if (typeof message.content === "string" && message.content !== "") {
        contentBlocks.push({ type: "text", text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const rawToolCall of message.tool_calls) {
          if (rawToolCall === null || typeof rawToolCall !== "object") {
            continue;
          }
          const toolCall = rawToolCall as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          contentBlocks.push({
            type: "tool_use",
            id: typeof toolCall.id === "string" ? toolCall.id : "",
            name:
              typeof toolCall.function?.name === "string" ? toolCall.function.name : "",
            input: parseToolArguments(toolCall.function?.arguments),
          });
        }
      }
      appendAnthropicMessage(converted, "assistant", contentBlocks);
      continue;
    }
    if (role === "user") {
      appendAnthropicMessage(converted, "user", [
        { type: "text", text: typeof message.content === "string" ? message.content : "" },
      ]);
      continue;
    }
    // 其它角色（如本地 system 指导）不进入 Anthropic messages：由调用方经 system 传递。
  }
  return converted;
}

function appendAnthropicMessage(
  converted: Array<{ role: "user" | "assistant"; content: unknown }>,
  role: "user" | "assistant",
  contentBlocks: unknown[],
): void {
  if (contentBlocks.length === 0) {
    return;
  }
  const previous = converted[converted.length - 1];
  if (previous !== undefined && previous.role === role && Array.isArray(previous.content)) {
    previous.content = [...previous.content, ...contentBlocks];
    return;
  }
  converted.push({ role, content: contentBlocks });
}

function parseToolArguments(rawArguments: unknown): unknown {
  if (typeof rawArguments !== "string" || rawArguments.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(rawArguments);
  } catch {
    // 参数不是合法 JSON：按空对象传递（由工具层给出参数校验错误）。
    return {};
  }
}

/**
 * 增量读取 Anthropic SSE 流：逐块解码（处理跨字节 UTF-8），按 `data:` 行解析事件。
 */
export async function* readAnthropicStreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        bufferedText += decoder.decode(value, { stream: true });
      }
      const lines = bufferedText.split("\n");
      bufferedText = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseAnthropicSseDataLine(line);
        if (parsed !== null) {
          yield parsed;
        }
      }
    }
    bufferedText += decoder.decode();
    for (const line of bufferedText.split("\n")) {
      const parsed = parseAnthropicSseDataLine(line);
      if (parsed !== null) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseAnthropicSseDataLine(line: string): AnthropicStreamEvent | null {
  if (!line.startsWith("data:")) {
    return null;
  }
  const payload = line.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(payload) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}
