/**
 * Provider 真实用量接线（2026-10-06）：行为反例（红 → 绿）。
 *
 * 已被查证的既有缺陷：
 *  - `usage-updated` 规范事件**只有声明，没有生产者与消费者**；
 *  - 两个产品运行时（`AnthropicMessagesRuntime` / `OpenAiCompatibleRuntime`）各自解析 SSE，
 *    把厂商返回的 usage **丢弃**（Anthropic 连 `message_start` 都不处理）；
 *  - `UsageLedgerStore` 在生产路径上**从未被写入**，`usage/entries.json` 永远为空。
 *
 * 因此本文件在实现之前必须失败：
 *  ① 真实 usage 必须逐请求落进用量账目（含缓存命中 token）；
 *  ② 响应未带 usage 时必须记 `null` + 原因，**不得补 0**；
 *  ③ 观测失败**不得阻塞**业务（Provider 调用结果不受影响）；
 *  ④ 每次真实请求记一条，键唯一（不互相覆盖）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProviderUsageLedgerObserver } from "../../../packages/core/src/orchestration/provider-usage-ledger-observer.js";
import { UsageLedgerStore } from "../../../packages/core/src/orchestration/usage-ledger-store.js";
import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";
import type { AgentRunInput } from "../../../packages/core/src/core/types.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";

let stateDirectory: string;

beforeEach(() => {
  stateDirectory = mkdtempSync(path.join(tmpdir(), "astarray-usage-wiring-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

const baseRunInput: AgentRunInput = {
  missionId: "mission-usage-wiring",
  agentId: "worker:mission-usage-wiring:T-001:1",
  systemPrompt: "系统提示",
  userPrompt: "受控改动",
  availableToolDescriptors: [],
  maxLoopIterations: 4,
};

function buildSseResponse(sseText: string): Response {
  return new Response(sseText, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function buildFetchReturning(sseText: string): typeof fetch {
  return (async () => buildSseResponse(sseText)) as unknown as typeof fetch;
}

function anthropicSseEvent(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

async function drainRuntimeEvents(
  runtime: AnthropicMessagesRuntime,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of runtime.run(baseRunInput, new AbortController().signal)) {
    collected.push(event);
  }
  return collected;
}

function createLedgerBackedRuntime(input: {
  sseText: string;
  store: UsageLedgerStore;
}): AnthropicMessagesRuntime {
  return new AnthropicMessagesRuntime({
    baseUrl: "https://example.invalid/anthropic/v1/messages",
    apiKey: "test-key-not-a-real-secret",
    model: "u2-flash",
    requestTimeoutMilliseconds: 5_000,
    providerIdentifier: "anthropic-messages",
    fetchImpl: buildFetchReturning(input.sseText),
    providerRequestUsageObserver: createProviderUsageLedgerObserver({
      store: input.store,
    }),
  });
}

describe("Provider 真实用量接线：逐请求落进用量账目", () => {
  it("① 真实 usage（输入/输出/缓存命中）必须写进账目，而不是被丢弃", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const sseText =
      anthropicSseEvent({
        type: "message_start",
        message: {
          id: "msg_1",
          usage: {
            input_tokens: 1234,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 7,
          },
        },
      }) +
      anthropicSseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "已完成" },
      }) +
      anthropicSseEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 56 },
      }) +
      anthropicSseEvent({ type: "message_stop" });

    const runtime = createLedgerBackedRuntime({ sseText, store });
    await drainRuntimeEvents(runtime);

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) {
      throw new Error("账目为空：真实 usage 没有被写入");
    }
    expect(entry.inputTokenCount).toBe(1234);
    expect(entry.outputTokenCount).toBe(56);
    expect(entry.cachedTokenCount).toBe(7);
    expect(entry.modelIdentifier).toBe("u2-flash");
    expect(entry.providerProfileId).toBe("anthropic-messages");
    expect(entry.sourceAgentInstanceId).toBe(baseRunInput.agentId);
    expect(entry.missionIdentifier).toBe("mission-usage-wiring");
    expect(entry.isEstimated).toBe(false);
    expect(entry.attribution).toEqual({ kind: "total", parentRequestIdentifier: null });
    expect(entry.missingUsageReason).toBeUndefined();
    // 哈希必须稳定可复算，不是空串占位。
    expect(entry.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("② 响应未带 usage：记 null 并给原因，绝不补 0", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const sseText =
      anthropicSseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "完成" },
      }) + anthropicSseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });

    const runtime = createLedgerBackedRuntime({ sseText, store });
    await drainRuntimeEvents(runtime);

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) {
      throw new Error("账目为空：缺 usage 的请求也必须留下记录（含原因）");
    }
    expect(entry.inputTokenCount).toBeNull();
    expect(entry.outputTokenCount).toBeNull();
    expect(entry.missingUsageReason).toBe("provider-response-did-not-include-usage");
  });

  it("③ 观测失败不得阻塞业务：Provider 调用照常收尾", async () => {
    const runtime = new AnthropicMessagesRuntime({
      baseUrl: "https://example.invalid/anthropic/v1/messages",
      apiKey: "test-key-not-a-real-secret",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: buildFetchReturning(
        anthropicSseEvent({
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 1 } },
        }) +
          anthropicSseEvent({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          }),
      ),
      providerRequestUsageObserver: {
        recordProviderRequestUsage: () => {
          throw new Error("观测端口故障");
        },
      },
    });

    const events = await drainRuntimeEvents(runtime);
    expect(events.some((event) => event.kind === "runFinished")).toBe(true);
  });

  it("④ 每次真实请求各记一条（键唯一，不互相覆盖）", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const sseText =
      anthropicSseEvent({
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 1 } },
      }) +
      anthropicSseEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      });

    const runtime = createLedgerBackedRuntime({ sseText, store });
    await drainRuntimeEvents(runtime);
    await drainRuntimeEvents(runtime);

    const entries = await store.readAll();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.requestIdentifier)).size).toBe(2);
  });
});
