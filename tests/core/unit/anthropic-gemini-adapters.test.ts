/**
 * T07D-04 测试：Anthropic Messages 与 Gemini 原生适配。
 * 验收：content block/step 事件；工具参数增量累积；工具结果回填；
 * 未知事件跳过；协议/API 版本显式记录。
 */
import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesAdapter,
  GeminiInteractionsAdapter,
} from "../../../packages/core/src/runtime/anthropic-gemini-adapters.js";
import type { NormalizedProviderEvent } from "../../../packages/core/src/runtime/provider-protocol-port.js";

async function collect(
  adapter: {
    parseEventStream(chunks: AsyncIterable<string>): AsyncIterable<NormalizedProviderEvent>;
  },
  chunks: string[],
) {
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

describe("AnthropicMessagesAdapter", () => {
  const adapter = new AnthropicMessagesAdapter();

  it("协议/API 版本显式记录（anthropic-version）", () => {
    expect(adapter.protocolName).toBe("anthropic-messages");
    expect(adapter.supportedApiVersion).toBe("2023-06-01");
  });

  it("文本流：message_start → text_delta 多片 → message_delta stop", async () => {
    const events = await collect(adapter, [
      'event: message_start\ndata: {"message":{"id":"msg-1"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"世界"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "response-started" });
    expect(events[1]).toMatchObject({ eventType: "text-delta", textDelta: "你好" });
    expect(events[2]).toMatchObject({ eventType: "text-delta", textDelta: "世界" });
    expect(events[3]).toMatchObject({
      eventType: "provider-completed",
      providerStopReason: "end_turn",
    });
  });

  it("工具调用：input_json_delta 流内累积 → content_block_stop 产出完整参数", async () => {
    const events = await collect(adapter, [
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","name":"project.read"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file\\":"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "tool-call-started",
      toolCallIdentifier: "anthropic-block-0",
      toolName: "project.read",
    });
    expect(events[1]).toMatchObject({
      eventType: "tool-arguments-delta",
      toolCallIdentifier: "anthropic-block-0",
      argumentsDelta: '{"file":',
    });
    // 累积完成：stop 时产出完整参数（结果回填由运行时执行）
    expect(events[3]).toMatchObject({
      eventType: "tool-call-completed",
      toolCallIdentifier: "anthropic-block-0",
      finalArgumentsJson: '{"file":"a.ts"}',
    });
  });

  it("error 事件 → provider-error（稳定错误码）", async () => {
    const events = await collect(adapter, [
      'event: error\ndata: {"error":{"type":"rate_limit_error"}}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "provider-error",
      stableErrorCode: "rate_limit_error",
    });
  });

  it("未知事件跳过（不中断）", async () => {
    const events = await collect(adapter, [
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"stop_sequence"}}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerStopReason: "stop_sequence" });
  });
});

describe("GeminiInteractionsAdapter", () => {
  const adapter = new GeminiInteractionsAdapter();

  it("协议/API 版本显式记录（v1beta）", () => {
    expect(adapter.protocolName).toBe("gemini-interactions");
    expect(adapter.supportedApiVersion).toBe("v1beta");
  });

  it("文本流：parts 增量产出 text-delta；usageMetadata 结束 → provider-completed", async () => {
    const events = await collect(adapter, [
      'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"世界"}]}}],"usageMetadata":{"totalTokenCount":15}}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "text-delta", textDelta: "你好" });
    expect(events[1]).toMatchObject({ eventType: "text-delta", textDelta: "世界" });
    expect(events[2]).toMatchObject({
      eventType: "provider-completed",
      providerStopReason: "stop",
    });
  });

  it("functionCall：一次性产出 started → arguments-delta → completed", async () => {
    const events = await collect(adapter, [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"project.read","args":{"file":"a.ts"}}}]}}]}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "tool-call-started",
      toolName: "project.read",
    });
    expect(events[1]).toMatchObject({
      eventType: "tool-arguments-delta",
      argumentsDelta: '{"file":"a.ts"}',
    });
    expect(events[2]).toMatchObject({
      eventType: "tool-call-completed",
      finalArgumentsJson: '{"file":"a.ts"}',
    });
  });

  it("error 字段 → provider-error", async () => {
    const events = await collect(adapter, [
      'data: {"error":{"code":429,"message":"quota exceeded"}}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "provider-error",
      stableErrorCode: "429",
    });
  });

  it("未知/空 chunk 跳过", async () => {
    const events = await collect(adapter, [
      'data: {"candidates":[]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "text-delta", textDelta: "ok" });
  });
});