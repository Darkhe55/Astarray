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
import {
  computeProviderRequestInputHash,
  type ProviderRequestUsageObserverPort,
} from "../measurement/provider-request-usage-observation.js";

export interface OpenAiCompatibleRuntimeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMilliseconds: number;
  /** 可注入以便测试。 */
  fetchImpl?: typeof fetch;
  /** Provider 运行时/协议标识（写进用量账目；缺省为 openai-compatible）。 */
  providerIdentifier?: string;
  /**
   * 真实用量观测端口（2026-10-06 接线）。
   * 缺省 = 不上报：显式表示本装配不采集用量，不冒充已采集。
   */
  providerRequestUsageObserver?: ProviderRequestUsageObserverPort;
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

/** OpenAI 兼容流式 usage 形态（需请求 `stream_options.include_usage`）。 */
interface OpenAiUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAiStreamChunk {
  choices?: OpenAiChoiceDelta[];
  /**
   * 收尾 chunk 携带真实 usage；**中间 chunk 常显式发 `null`**（unisound 实测），
   * 因此类型必须允许 null，解析也必须容忍 null。
   */
  usage?: OpenAiUsagePayload | null;
}

function readNonNegativeTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

export class OpenAiCompatibleRuntime implements AgentRuntime {
  private readonly fetchImpl: typeof fetch;
  /** 每个实例对应一个具体 Agent；实例内递增即可区分该 Agent 的每次真实请求。 */
  private requestSequence = 0;

  constructor(private readonly options: OpenAiCompatibleRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const requestBody = buildChatRequestBody(agentRunInput, this.options.model);
    const serializedRequestBody = JSON.stringify(requestBody);
    /**
     * 用量捕获（2026-10-06）：OpenAI 兼容协议**默认不返回**流式 usage，
     * 必须显式请求 `stream_options.include_usage`；返回的 usage 在**最后一个**
     * 「只有 usage、没有 choices」的 chunk 上（因此读数必须发生在 choices 判空之前）。
     */
    let observedInputTokenCount: number | null = null;
    let observedOutputTokenCount: number | null = null;
    let observedCachedInputTokenCount: number | null = null;
    let hasObservedUsagePayload = false;
    let hasReportedUsage = false;
    let hasStartedStream = false;
    this.requestSequence += 1;
    const requestIdentifier =
      "provider-request:" +
      agentRunInput.agentId +
      ":" +
      String(this.requestSequence);
    const reportUsageOnce = async (): Promise<void> => {
      if (!hasStartedStream || hasReportedUsage) {
        return;
      }
      hasReportedUsage = true;
      const observer = this.options.providerRequestUsageObserver;
      if (observer === undefined) {
        return;
      }
      const hasCompleteUsage =
        observedInputTokenCount !== null && observedOutputTokenCount !== null;
      try {
        await observer.recordProviderRequestUsage({
          missionIdentifier: agentRunInput.missionId,
          taskIdentifier: null,
          sourceAgentInstanceId: agentRunInput.agentId,
          providerIdentifier:
            this.options.providerIdentifier ?? "openai-compatible",
          modelIdentifier: this.options.model,
          requestIdentifier,
          inputTokenCount: observedInputTokenCount,
          outputTokenCount: observedOutputTokenCount,
          cachedInputTokenCount: observedCachedInputTokenCount,
          requestInputHash: computeProviderRequestInputHash(serializedRequestBody),
          observedAtIso: new Date().toISOString(),
          ...(hasCompleteUsage
            ? {}
            : {
                missingUsageReason: hasObservedUsagePayload
                  ? "provider-usage-incomplete"
                  : "provider-response-did-not-include-usage",
              }),
        });
      } catch {
        // 观测失败不得阻塞业务（沿用 perfSampleSink 的既定纪律）。
      }
    };
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
        // 只有调用方取消才算 cancelled；本适配器超时（abortController）必须报超时失败。
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
      const chunks = readOpenAiStreamChunks(response.body);
      const accumulatedToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finalFinishReason: string | null = null;
      hasStartedStream = true;
      for await (const chunk of chunks) {
        if (cancellationSignal.aborted) {
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: "cancelled",
            detail: "流式输出被取消",
          };
          return;
        }
        // usage 必须**先于** choices 判空读取：收尾 chunk 只有 usage、没有 choices。
        // 注意 `usage` 可以是显式 `null`（unisound 等厂商在中间 chunk 就这么发）：
        // 只判 `!== undefined` 会抛 "Cannot read properties of null"——真实运行踩到过。
        const chunkUsage = chunk.usage;
        if (chunkUsage !== undefined && chunkUsage !== null) {
          hasObservedUsagePayload = true;
          const inputTokenCount = readNonNegativeTokenCount(chunkUsage.prompt_tokens);
          if (inputTokenCount !== null) {
            observedInputTokenCount = inputTokenCount;
          }
          const outputTokenCount = readNonNegativeTokenCount(chunkUsage.completion_tokens);
          if (outputTokenCount !== null) {
            observedOutputTokenCount = outputTokenCount;
          }
          const cachedInputTokenCount = readNonNegativeTokenCount(
            chunkUsage.prompt_tokens_details?.cached_tokens,
          );
          if (cachedInputTokenCount !== null) {
            observedCachedInputTokenCount = cachedInputTokenCount;
          }
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
      // 无论正常收尾还是取消，只要拿到过流就把用量事实交给观测端口（幂等，只报一次）。
      await reportUsageOnce();
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
    /**
     * 流式 usage 必须显式请求（2026-10-06）。
     * 已实测确认 unisound 的 OpenAI 兼容端点接受该字段并返回 usage（HTTP 200）。
     */
    stream_options: { include_usage: true },
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

/**
 * 增量读取 SSE 流：逐块解码（TextDecoder stream 模式处理跨字节 UTF-8 中文），
 * 按行拆出 data: 负载并即时产出，支持取消/超时提前中断。
 */
export async function* readOpenAiStreamChunks(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<OpenAiStreamChunk> {
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
        const parsed = parseSseDataLine(line);
        if (parsed !== null) {
          yield parsed;
        }
      }
    }
    bufferedText += decoder.decode();
    for (const line of bufferedText.split("\n")) {
      const parsed = parseSseDataLine(line);
      if (parsed !== null) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseDataLine(line: string): OpenAiStreamChunk | null {
  if (!line.startsWith("data:")) {
    return null;
  }
  const payload = line.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(payload) as OpenAiStreamChunk;
  } catch {
    return null;
  }
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
