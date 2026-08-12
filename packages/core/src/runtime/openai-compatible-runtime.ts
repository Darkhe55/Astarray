/**
 * OpenAI 兼容运行时（T07）。
 * 单次 run = 一次 provider 迭代：流式输出 + 工具调用声明 + 结束原因。
 * 完整工具执行循环由 ToolLoop 驱动。
 * API key 绝不进入日志/错误/事件：错误消息仅含稳定领域信息。
 */
import { DomainError } from "../core/errors.js";
import type { AgentEvent } from "../core/events.js";
import type {
  AgentRunInput,
  AgentRuntime,
  ToolDescriptor,
} from "../core/types.js";

export interface OpenAiCompatibleRuntimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMilliseconds: number;
  /** 可注入以便测试。 */
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoiceDelta {
  delta?: { content?: string | null; tool_calls?: OpenAiToolCallDelta[] };
  finish_reason?: string | null;
}

interface OpenAiStreamChunk {
  choices?: OpenAiChoiceDelta[];
}

export class OpenAiCompatibleRuntime implements AgentRuntime {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const requestBody = buildChatRequestBody(agentRunInput, this.options.model);
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
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });
      } catch {
        if (cancellationSignal.aborted || abortController.signal.aborted) {
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
      const responseText = await response.text();
      const chunks = parseServerSentEvents(responseText);
      const accumulatedToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finalFinishReason: string | null = null;
      for (const chunk of chunks) {
        if (cancellationSignal.aborted) {
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: "cancelled",
            detail: "流式输出被取消",
          };
          return;
        }
        const choice = chunk.choices?.[0];
        if (choice === undefined) {
          continue;
        }
        const delta = choice.delta;
        if (delta?.content !== undefined && delta.content !== null) {
          yield { kind: "textDelta", deltaText: delta.content };
        }
        for (const toolCallDelta of delta?.tool_calls ?? []) {
          const toolCallIndex = toolCallDelta.index ?? 0;
          const currentToolCall = accumulatedToolCalls.get(toolCallIndex) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (toolCallDelta.id !== undefined) {
            currentToolCall.id = toolCallDelta.id;
          }
          if (toolCallDelta.function?.name !== undefined) {
            currentToolCall.name += toolCallDelta.function.name;
          }
          if (toolCallDelta.function?.arguments !== undefined) {
            currentToolCall.arguments += toolCallDelta.function.arguments;
          }
          accumulatedToolCalls.set(toolCallIndex, currentToolCall);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finalFinishReason = choice.finish_reason;
        }
      }
      for (const toolCall of accumulatedToolCalls.values()) {
        yield {
          kind: "toolCallRequested",
          callId: toolCall.id,
          toolName: toolCall.name,
          argumentsJson: toolCall.arguments,
        };
      }
      if (accumulatedToolCalls.size > 0) {
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "tool-calls",
          detail: `请求工具调用 ${accumulatedToolCalls.size} 个`,
        };
        return;
      }
      if (finalFinishReason === "stop") {
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
        `Provider 异常结束: finish_reason=${finalFinishReason ?? "未知"}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
      cancellationSignal.removeEventListener("abort", cancellationListener);
    }
  }
}

function buildChatRequestBody(
  agentRunInput: AgentRunInput,
  model: string,
): unknown {
  return {
    model,
    stream: true,
    messages: [
      { role: "system", content: agentRunInput.systemPrompt },
      { role: "user", content: agentRunInput.userPrompt },
      ...(agentRunInput.toolResultMessages ?? []),
    ],
    tools: agentRunInput.availableToolDescriptors.map(
      (descriptor: ToolDescriptor) => ({
        type: "function",
        function: {
          name: descriptor.name,
          description: descriptor.summary,
          parameters: descriptor.inputSchema,
        },
      }),
    ),
    tool_choice: "auto",
  };
}

export function parseServerSentEvents(responseText: string): OpenAiStreamChunk[] {
  const chunks: OpenAiStreamChunk[] = [];
  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      continue;
    }
    try {
      chunks.push(JSON.parse(payload) as OpenAiStreamChunk);
    } catch {
      // 忽略无法解析的行（保持稳定行为）
    }
  }
  return chunks;
}
