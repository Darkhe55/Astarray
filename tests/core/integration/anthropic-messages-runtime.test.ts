/**
 * Anthropic Messages runtime 行为测试（2026-10-02，多协议装配第一步）。
 *
 * 这些断言在 runtime 实现之前均为红（当时不存在 anthropic-messages 运行时）；
 * 它们固定以下协议契约：
 *  - 鉴权用 `x-api-key`（不是 Bearer）+ `anthropic-version` 头；
 *  - system 走**顶层** `system`，messages 中不出现 system 角色；
 *  - 工具定义用 `input_schema`，且 `max_tokens` 必填；
 *  - SSE 解析：text_delta → textDelta；tool_use + input_json_delta → toolCallRequested；
 *  - stop_reason=end_turn → runFinished(success)；有工具调用 → runFinished(tool-calls)。
 */
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";
import type { AgentRunInput } from "../../../packages/core/src/core/types.js";

let server: http.Server | null = null;

afterEach(() => {
  if (server !== null) {
    server.close();
    server = null;
  }
});

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** 起一个本地服务器，按给定 SSE 片段回放，并捕获请求。 */
async function startFakeAnthropicServer(sseBody: string): Promise<{
  baseUrl: string;
  capturedRequests: CapturedRequest[];
}> {
  const capturedRequests: CapturedRequest[] = [];
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => (rawBody += String(chunk)));
    request.on("end", () => {
      capturedRequests.push({
        headers: request.headers,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(sseBody);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    (server as http.Server).listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return { baseUrl: "http://127.0.0.1:" + String(port) + "/anthropic/v1/messages", capturedRequests };
}

function sse(event: unknown): string {
  return "event: message\ndata: " + JSON.stringify(event) + "\n\n";
}

function buildAgentRunInput(toolResultMessages: unknown[] = []): AgentRunInput {
  return {
    missionId: "mission-1",
    agentId: "agent-1",
    systemPrompt: "你是执行 Agent。",
    userPrompt: "创建 .tmp/A.md",
    availableToolDescriptors: [
      {
        name: "createProjectFile",
        summary: "新建项目文件",
        category: "restricted",
        mutationKind: "create-only",
        backupPolicy: "not-required",
        authorizationPolicy: "standard",
        supportedTaskTypes: ["coding"],
        isIdempotent: true,
        inputSchema: {
          type: "object",
          properties: { filePath: { type: "string" }, content: { type: "string" } },
          required: ["filePath", "content"],
        },
      },
    ],
    maxLoopIterations: 3,
    toolResultMessages,
  };
}

async function collectEvents(
  runtime: AnthropicMessagesRuntime,
  agentRunInput: AgentRunInput,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const cancellationController = new AbortController();
  for await (const event of runtime.run(agentRunInput, cancellationController.signal)) {
    events.push(event as unknown as Record<string, unknown>);
  }
  return events;
}

describe("Anthropic Messages runtime：请求形态", () => {
  it("① 鉴权与版本头、system 顶层、max_tokens、input_schema", async () => {
    const { baseUrl, capturedRequests } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }) +
        sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
        sse({ type: "message_stop" }),
    );
    const runtime = new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
    });

    const events = await collectEvents(runtime, buildAgentRunInput());
    expect(events).toContainEqual({ kind: "textDelta", deltaText: "好" });
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "success" });

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0] as CapturedRequest;
    // x-api-key 鉴权（不是 Bearer）
    expect(captured.headers["x-api-key"]).toBe("test-key");
    expect(captured.headers["authorization"]).toBeUndefined();
    expect(captured.headers["anthropic-version"]).toBe("2023-06-01");
    // system 顶层 + max_tokens + messages 中无 system 角色
    expect(captured.body["system"]).toBe("你是执行 Agent。");
    expect(typeof captured.body["max_tokens"]).toBe("number");
    const messages = captured.body["messages"] as Array<{ role: string }>;
    expect(messages.every((message) => message.role !== "system")).toBe(true);
    expect(messages[0]).toMatchObject({ role: "user" });
    // 工具用 input_schema
    const tools = captured.body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "createProjectFile" });
    expect(tools[0]?.["input_schema"]).toBeDefined();
    expect(tools[0]?.["function"]).toBeUndefined();
  });
});

describe("Anthropic Messages runtime：工具与结果形态转换", () => {
  it("② tool_use + input_json_delta 流内累积 → toolCallRequested；结束为 tool-calls", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "createProjectFile" },
        }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"filePath":' },
        }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '".tmp/A.md","content":"# A\\n"}' },
        }) +
        sse({ type: "content_block_stop", index: 0 }) +
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
        sse({ type: "message_stop" }),
    );
    const runtime = new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
    });

    const events = await collectEvents(runtime, buildAgentRunInput());
    expect(events).toContainEqual({
      kind: "toolCallRequested",
      callId: "toolu_1",
      toolName: "createProjectFile",
      argumentsJson: '{"filePath":".tmp/A.md","content":"# A\\n"}',
    });
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "tool-calls" });
  });

  it("③ 前序 OpenAI 形态消息 → Anthropic 形态（assistant.tool_use + user.tool_result，同角色合并）", async () => {
    const { baseUrl, capturedRequests } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    );
    const runtime = new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
    });

    await collectEvents(
      runtime,
      buildAgentRunInput([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "createProjectFile", arguments: '{"filePath":".tmp/A.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "已新建项目文件: .tmp/A.md" },
      ]),
    );

    const messages = (capturedRequests[0] as CapturedRequest).body["messages"] as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[1]?.content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_1",
      name: "createProjectFile",
      input: { filePath: ".tmp/A.md" },
    });
    expect(messages[2]).toMatchObject({ role: "user" });
    expect(messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "已新建项目文件: .tmp/A.md",
    });
    // OpenAI 的 role="tool" 不得出现在 Anthropic messages 中
    expect(messages.every((message) => message.role !== "tool")).toBe(true);
  });

  it("④ 异常 stop_reason → 报错（不得当成成功）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    );
    const runtime = new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
    });

    await expect(collectEvents(runtime, buildAgentRunInput())).rejects.toThrow(/stop_reason=max_tokens/);
  });
});
