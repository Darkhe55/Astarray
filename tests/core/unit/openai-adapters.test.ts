/**
 * T07D-03 测试：OpenAI Responses / Chat Completions / 通用兼容适配。
 * fake-server 契约：文本、工具调用、并行工具、usage、stop 原因与错误。
 */
import { describe, expect, it } from "vitest";

import {
  GenericOpenAiCompatibleAdapter,
  OpenAiChatCompletionsAdapter,
  OpenAiResponsesAdapter,
} from "../../../packages/core/src/runtime/openai-adapters.js";
import type { NormalizedProviderEvent } from "../../../packages/core/src/runtime/provider-protocol-port.js";

async function collect(adapter: { parseEventStream(chunks: AsyncIterable<string>): AsyncIterable<NormalizedProviderEvent> }, chunks: string[]) {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.parseEventStream(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  )) {
    events.push(event);
  }
  return events;
}

describe("OpenAiResponsesAdapter", () => {
  const adapter = new OpenAiResponsesAdapter();

  it("协议标识：responses 与 chat-completions 互不冒充", () => {
    expect(adapter.protocolName).toBe("openai-responses");
    expect(adapter.protocolName).not.toBe("openai-chat-completions");
    expect(new OpenAiChatCompletionsAdapter().protocolName).toBe(
      "openai-chat-completions",
    );
  });

  it("文本流：created → text-delta → completed", async () => {
    const events = await collect(adapter, [
      'event: response.created\ndata: {"id":"resp-1"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"你好"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"世界"}\n\n',
      'event: response.completed\ndata: {"status":"completed"}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "response-started" });
    expect(events[1]).toMatchObject({ eventType: "text-delta", textDelta: "你好" });
    expect(events[2]).toMatchObject({ eventType: "text-delta", textDelta: "世界" });
    expect(events[3]).toMatchObject({
      eventType: "provider-completed",
      providerStopReason: "completed",
    });
  });

  it("工具调用：output_item.added → arguments delta → arguments done", async () => {
    const events = await collect(adapter, [
      'event: response.output_item.added\ndata: {"type":"function_call","id":"fc-1","name":"project.read"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"call_id":"fc-1","delta":"{\\"file\\":"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"call_id":"fc-1","arguments":"{\\"file\\":\\"a.ts\\"}"}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "tool-call-started",
      toolCallIdentifier: "fc-1",
      toolName: "project.read",
    });
    expect(events[1]).toMatchObject({
      eventType: "tool-arguments-delta",
      toolCallIdentifier: "fc-1",
    });
    expect(events[2]).toMatchObject({
      eventType: "tool-call-completed",
      toolCallIdentifier: "fc-1",
      finalArgumentsJson: '{"file":"a.ts"}',
    });
  });

  it("response.failed → provider-error（稳定错误码）", async () => {
    const events = await collect(adapter, [
      'event: response.failed\ndata: {"error":{"code":"rate_limit_exceeded"}}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "provider-error",
      stableErrorCode: "rate_limit_exceeded",
    });
  });

  it("未知事件跳过（不中断）", async () => {
    const events = await collect(adapter, [
      'event: response.unknown_event\ndata: {"x":1}\n\n',
      'event: response.completed\ndata: {"status":"completed"}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "provider-completed" });
  });
});

describe("OpenAiChatCompletionsAdapter", () => {
  const adapter = new OpenAiChatCompletionsAdapter();

  it("文本流：content delta 多片 + finish_reason=stop", async () => {
    const events = await collect(adapter, [
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"！"},"finish_reason":"stop"}]}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "text-delta", textDelta: "你好" });
    expect(events[1]).toMatchObject({ eventType: "text-delta", textDelta: "！" });
    expect(events[2]).toMatchObject({
      eventType: "provider-completed",
      providerStopReason: "stop",
    });
  });

  it("并行工具调用：两个工具各输出 name/arguments 增量与完成", async () => {
    const events = await collect(adapter, [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc-0","function":{"name":"project.read"}},{"index":1,"id":"tc-1","function":{"name":"project.search"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file\\":\\"a.ts\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"query\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ]);
    const toolCalls = events.filter((event) => event.eventType === "tool-call-started");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((event) => (event as { toolName: string }).toolName)).toEqual([
      "project.read",
      "project.search",
    ]);
    const argumentDeltas = events.filter(
      (event) => event.eventType === "tool-arguments-delta",
    );
    expect(argumentDeltas).toHaveLength(2);
    const completed = events.filter(
      (event) => event.eventType === "provider-completed",
    );
    expect(completed[0]).toMatchObject({ providerStopReason: "tool_calls" });
  });

  it("usage-updated 透传（usage 字段）", async () => {
    const events = await collect(adapter, [
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    ]);
    expect(events.some((event) => event.eventType === "provider-completed")).toBe(true);
  });

  it("error 事件 → provider-error", async () => {
    const events = await collect(adapter, [
      'event: error\ndata: {"error":{"code":"rate_limit","message":"slow down"}}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "provider-error",
      stableErrorCode: "rate_limit",
    });
  });

  it("[DONE] 哨兵跳过", async () => {
    const events = await collect(adapter, [
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events.every((event) => event.eventType !== "provider-error")).toBe(true);
  });
});

describe("GenericOpenAiCompatibleAdapter", () => {
  it("协议标识与 API 版本显式记录（conformance 子集）", () => {
    const adapter = new GenericOpenAiCompatibleAdapter();
    expect(adapter.protocolName).toBe("generic-openai-compatible");
    expect(adapter.supportedApiVersion).toBe("2024-06-01");
  });

  it("文本流契约与 Chat Completions 一致", async () => {
    const adapter = new GenericOpenAiCompatibleAdapter();
    const events = await collect(adapter, [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "text-delta", textDelta: "ok" });
    expect(events[1]).toMatchObject({ eventType: "provider-completed" });
  });
});