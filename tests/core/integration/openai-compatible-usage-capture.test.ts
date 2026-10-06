/**
 * OpenAI 兼容运行时的真实用量接线（2026-10-06）：行为反例（红 → 绿）。
 *
 * 已查证的既有缺陷：
 *  - 该运行时的请求体**从不请求** `stream_options.include_usage`，因此 OpenAI 兼容
 *    服务端默认不返回流式 usage；
 *  - `OpenAiStreamChunk` 连 `usage` 字段都没有声明，返回了也会被丢弃；
 *  - 收尾 chunk 只有 `usage`、**没有 `choices`**，读数必须发生在 choices 判空之前。
 *
 * 本文件在实现之前必须失败。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRunInput } from "../../../packages/core/src/core/types.js";
import { createProviderUsageLedgerObserver } from "../../../packages/core/src/orchestration/provider-usage-ledger-observer.js";
import { UsageLedgerStore } from "../../../packages/core/src/orchestration/usage-ledger-store.js";
import { OpenAiCompatibleRuntime } from "../../../packages/core/src/runtime/openai-compatible-runtime.js";

let stateDirectory: string;
let lastRequestBodyJson = "";

beforeEach(() => {
  stateDirectory = mkdtempSync(path.join(tmpdir(), "astarray-usage-openai-"));
  lastRequestBodyJson = "";
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

const baseRunInput: AgentRunInput = {
  missionId: "mission-usage-openai",
  agentId: "worker:mission-usage-openai:T-001:1",
  systemPrompt: "系统提示",
  userPrompt: "受控改动",
  availableToolDescriptors: [],
  maxLoopIterations: 4,
};

function openAiChunk(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

/** 记录请求体，便于断言"是否真的请求了 usage"。 */
function buildCapturingFetch(sseText: string): typeof fetch {
  return (async (_url: string, init: { body?: string }) => {
    lastRequestBodyJson = String(init?.body ?? "");
    return new Response(sseText, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

async function drainRuntimeEvents(
  runtime: OpenAiCompatibleRuntime,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of runtime.run(baseRunInput, new AbortController().signal)) {
    collected.push(event);
  }
  return collected;
}

describe("OpenAI 兼容运行时：真实用量接线", () => {
  it("① 必须显式请求流式 usage（stream_options.include_usage）", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://example.invalid/v1/chat/completions",
      apiKey: "test-key-not-a-real-secret",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: buildCapturingFetch(
        openAiChunk({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      ),
      providerRequestUsageObserver: createProviderUsageLedgerObserver({ store }),
    });

    await drainRuntimeEvents(runtime);

    expect(lastRequestBodyJson).not.toBe("");
    const requestBody = JSON.parse(lastRequestBodyJson) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(requestBody.stream_options).toEqual({ include_usage: true });
  });

  it("② 收尾 chunk 只有 usage、没有 choices 时也必须记账", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://example.invalid/v1/chat/completions",
      apiKey: "test-key-not-a-real-secret",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: buildCapturingFetch(
        openAiChunk({
          choices: [{ delta: { content: "已完成" }, finish_reason: null }],
        }) +
          openAiChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          // 收尾 chunk：只有 usage，choices 为空数组。
          openAiChunk({
            choices: [],
            usage: {
              prompt_tokens: 812,
              completion_tokens: 143,
              prompt_tokens_details: { cached_tokens: 64 },
            },
          }) +
          "data: [DONE]\n\n",
      ),
      providerRequestUsageObserver: createProviderUsageLedgerObserver({ store }),
    });

    await drainRuntimeEvents(runtime);

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) {
      throw new Error("账目为空：OpenAI 兼容路径的真实 usage 未被记录");
    }
    expect(entry.inputTokenCount).toBe(812);
    expect(entry.outputTokenCount).toBe(143);
    expect(entry.cachedTokenCount).toBe(64);
    expect(entry.modelIdentifier).toBe("u2-flash");
    expect(entry.missingUsageReason).toBeUndefined();
  });

  it("③ 服务端未返回 usage：记 null 并给原因，绝不补 0", async () => {
    const store = new UsageLedgerStore({ baseDirectory: stateDirectory });
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://example.invalid/v1/chat/completions",
      apiKey: "test-key-not-a-real-secret",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: buildCapturingFetch(
        openAiChunk({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      ),
      providerRequestUsageObserver: createProviderUsageLedgerObserver({ store }),
    });

    await drainRuntimeEvents(runtime);

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputTokenCount).toBeNull();
    expect(entries[0]?.outputTokenCount).toBeNull();
    expect(entries[0]?.missingUsageReason).toBe(
      "provider-response-did-not-include-usage",
    );
  });
});
