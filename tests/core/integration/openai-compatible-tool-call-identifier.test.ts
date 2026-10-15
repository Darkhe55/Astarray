/**
 * OpenAI 兼容运行时反例（2026-11-08）：**Provider 不给 tool_call id 时不得产出空 id**。
 *
 * ## 由来（真实用户人工体验发现的**真缺陷**，不是推测）
 *
 * 用户用真实 Provider（sensenova）提交「创建 .tmp/gui-live-check.md」后，
 * 「待授权」区**没有任何内容**。我从服务端查到任务在 **~6 秒内 failed**，
 * 再用 CLI 前台跑同一任务拿到真实判词：
 *
 * ```
 * 任务 T-001 失败：检查点非法: [
 *   { "code": "too_small", "minimum": 1,
 *     "path": ["toolCalls", 0, "toolCallIdentifier"],
 *     "message": "Too small: expected string to have >=1 characters" } ]
 * （状态：运行时异常终止）
 * ```
 *
 * ## 根因（`openai-compatible-runtime.ts` 累积 tool_calls 的分支）
 *
 * ```js
 * const currentToolCall = accumulatedToolCalls.get(toolCallIndex) ?? { id: "", ... };
 * if (toolCallDelta.id !== undefined) { currentToolCall.id = toolCallDelta.id; }
 * ...
 * yield { kind: "toolCallRequested", callId: toolCall.id, ... }   // ← 可能是 ""
 * ```
 *
 * 该 Provider 的流式响应**从不携带 `id`** ⇒ `callId = ""` ⇒ 检查点 schema
 * `toolCallIdentifier: z.string().min(1)` 拒绝 ⇒ **任务终止、mission 变 blocked**。
 *
 * **影响面**：任何"不返回 tool_call id"的 OpenAI 兼容 Provider，
 * **凡是需要调工具的任务都会失败** —— 而这正是本例要做的事（写文件）。
 * 也解释了为什么"授权区没有内容"：任务在**能产生授权请求之前**就死了。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRunInput } from "../../../packages/core/src/core/types.js";
import { OpenAiCompatibleRuntime } from "../../../packages/core/src/runtime/openai-compatible-runtime.js";

let stateDirectory: string;

beforeEach(() => {
  stateDirectory = mkdtempSync(path.join(tmpdir(), "astarray-toolcall-id-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

const baseRunInput: AgentRunInput = {
  missionId: "mission-toolcall-id",
  agentId: "worker:mission-toolcall-id:T-001:1",
  systemPrompt: "系统提示",
  userPrompt: "创建文件",
  availableToolDescriptors: [],
  maxLoopIterations: 4,
};

function openAiChunk(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function buildFetch(sseText: string): typeof fetch {
  return (async () =>
    new Response(sseText, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

async function drainEvents(fetchImpl: typeof fetch): Promise<AgentEvent[]> {
  const runtime = new OpenAiCompatibleRuntime({
    baseUrl: "https://example.invalid/v1/chat/completions",
    apiKey: "test-key-not-a-real-secret",
    model: "sensenova-6.8-flash-lite",
    requestTimeoutMilliseconds: 5_000,
    fetchImpl,
  });
  const collected: AgentEvent[] = [];
  for await (const event of runtime.run(baseRunInput, new AbortController().signal)) {
    collected.push(event);
  }
  return collected;
}

describe("OpenAI 兼容运行时：tool_call 标识", () => {
  it("① Provider **不给 id** 时，callId 必须被合成一个非空标识（不得是空串）", async () => {
    // 完全模仿 sensenova 的形态：流式 tool_calls **从不带 id**，参数分两片到达。
    const sseText =
      openAiChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    name: "createProjectFile",
                    arguments: '{"filePath":".tmp/gui-live-check.md"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      openAiChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ',"content":"# 人工体验"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      openAiChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n";

    const events = await drainEvents(buildFetch(sseText));
    const toolCallEvent = events.find((event) => event.kind === "toolCallRequested");
    expect(toolCallEvent, "没有产出 toolCallRequested，用例前提不成立").toBeDefined();

    const callId = (toolCallEvent as { callId: string }).callId;
    // 关键断言：空 id 会让检查点 schema（min 1）拒绝 ⇒ 任务终止
    expect(callId.length).toBeGreaterThan(0);
    // 参数照旧要完整拼起来（不得因为补 id 而丢参数）
    expect((toolCallEvent as { argumentsJson: string }).argumentsJson).toBe(
      '{"filePath":".tmp/gui-live-check.md","content":"# 人工体验"}',
    );
  });

  it("② Provider **给了 id** 时必须原样保留（不得被合成值覆盖）", async () => {
    const sseText =
      openAiChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-abc-123",
                  function: { name: "createProjectFile", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      openAiChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n";

    const events = await drainEvents(buildFetch(sseText));
    const toolCallEvent = events.find((event) => event.kind === "toolCallRequested");
    expect(toolCallEvent).toBeDefined();
    expect((toolCallEvent as { callId: string }).callId).toBe("call-abc-123");
  });
});
