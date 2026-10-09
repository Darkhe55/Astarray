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

/**
 * 用量捕获分支（2026-10-06 真实实测修正，2026-10-09 补测）。
 *
 * 这些分支来自真实厂商形态踩出来的缺陷，必须逐条固定：
 *  - `message_delta.usage` 是**累计终值**，给出的字段一律**覆盖** `message_start` 初值
 *    （真实厂商把 `message_start.message.usage.input_tokens` 发成 0，真实输入只在 delta 里）；
 *  - `usage` 可为**显式 null**（与 OpenAI 兼容侧同类形态），判空必须容忍；
 *  - 未拿到完整用量时**不得记 0**，必须带出可解释原因；
 *  - 观测失败不得阻塞业务。
 */
describe("Anthropic Messages runtime：用量捕获分支", () => {
  type CapturedUsageRecord = Record<string, unknown>;

  function buildUsageObserver(
    capturedRecords: CapturedUsageRecord[],
    shouldThrow = false,
  ): { recordProviderRequestUsage: (input: CapturedUsageRecord) => Promise<void> } {
    return {
      recordProviderRequestUsage: async (input: CapturedUsageRecord): Promise<void> => {
        if (shouldThrow) throw new Error("observer-down");
        capturedRecords.push(input);
      },
    };
  }

  function buildRuntime(
    baseUrl: string,
    providerRequestUsageObserver?: { recordProviderRequestUsage: (input: CapturedUsageRecord) => Promise<void> },
  ): AnthropicMessagesRuntime {
    return new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      ...(providerRequestUsageObserver === undefined ? {} : { providerRequestUsageObserver }),
    });
  }

  it("⑤ 完整用量：message_start 给输入与缓存读，message_delta 给输出，且不带缺失原因", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } },
      }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }) +
        sse({ type: "message_delta", usage: { output_tokens: 20 }, delta: { stop_reason: "end_turn" } }),
    );
    const capturedRecords: CapturedUsageRecord[] = [];
    const runtime = buildRuntime(baseUrl, buildUsageObserver(capturedRecords));

    await collectEvents(runtime, buildAgentRunInput());

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]).toMatchObject({
      missionIdentifier: "mission-1",
      sourceAgentInstanceId: "agent-1",
      modelIdentifier: "u2-flash",
      inputTokenCount: 100,
      outputTokenCount: 20,
      cachedInputTokenCount: 40,
    });
    // 完整用量不得携带缺失原因
    expect(capturedRecords[0]?.["missingUsageReason"]).toBeUndefined();
  });

  it("⑥ message_delta 覆盖 message_start（真实厂商把 start 的输入发成 0）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 0 } } }) +
        sse({
          type: "message_delta",
          usage: { input_tokens: 137, output_tokens: 9 },
          delta: { stop_reason: "end_turn" },
        }),
    );
    const capturedRecords: CapturedUsageRecord[] = [];
    const runtime = buildRuntime(baseUrl, buildUsageObserver(capturedRecords));

    await collectEvents(runtime, buildAgentRunInput());

    expect(capturedRecords).toHaveLength(1);
    // 若未实现覆盖规则，这里会是 0——真实运行曾因此统计错误
    expect(capturedRecords[0]?.["inputTokenCount"]).toBe(137);
    expect(capturedRecords[0]?.["outputTokenCount"]).toBe(9);
  });

  it("⑦ usage 显式为 null：容忍并报告响应未包含用量（不得记 0）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: null } }) +
        sse({ type: "message_delta", usage: null, delta: { stop_reason: "end_turn" } }),
    );
    const capturedRecords: CapturedUsageRecord[] = [];
    const runtime = buildRuntime(baseUrl, buildUsageObserver(capturedRecords));

    await collectEvents(runtime, buildAgentRunInput());

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]?.["inputTokenCount"]).toBeNull();
    expect(capturedRecords[0]?.["outputTokenCount"]).toBeNull();
    expect(capturedRecords[0]?.["missingUsageReason"]).toBe(
      "provider-response-did-not-include-usage",
    );
  });

  it("⑧ 只拿到部分用量：报告 provider-usage-incomplete（与'完全没带'区分）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 55 } } }) +
        sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    );
    const capturedRecords: CapturedUsageRecord[] = [];
    const runtime = buildRuntime(baseUrl, buildUsageObserver(capturedRecords));

    await collectEvents(runtime, buildAgentRunInput());

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]?.["inputTokenCount"]).toBe(55);
    expect(capturedRecords[0]?.["outputTokenCount"]).toBeNull();
    expect(capturedRecords[0]?.["missingUsageReason"]).toBe("provider-usage-incomplete");
  });

  it("⑨ 多次 delta 只上报一次（不得重复记账）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }) +
        sse({ type: "message_delta", usage: { output_tokens: 3 }, delta: { stop_reason: null } }) +
        sse({ type: "message_delta", usage: { output_tokens: 7 }, delta: { stop_reason: null } }) +
        sse({ type: "message_delta", usage: { output_tokens: 11 }, delta: { stop_reason: "end_turn" } }),
    );
    const capturedRecords: CapturedUsageRecord[] = [];
    const runtime = buildRuntime(baseUrl, buildUsageObserver(capturedRecords));

    await collectEvents(runtime, buildAgentRunInput());

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]?.["outputTokenCount"]).toBe(11);
  });

  it("⑩ 观测器抛错不得阻塞业务（沿用既定纪律）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
        sse({ type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } }),
    );
    const runtime = buildRuntime(baseUrl, buildUsageObserver([], true));

    const events = await collectEvents(runtime, buildAgentRunInput());
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "success" });
  });

  it("⑪ 未装配观测器时不影响运行", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
        sse({ type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } }),
    );
    const runtime = buildRuntime(baseUrl);

    const events = await collectEvents(runtime, buildAgentRunInput());
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "success" });
  });
});

/**
 * 错误路径与选项透传（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 覆盖 `anthropic-messages-runtime.ts` 中未被触发的分支：HTTP 非 2xx、空响应体、
 * 非法 SSE 行、缺失 stop_reason、一次响应内多个 tool_use、以及 `providerIdentifier`
 * 选项透传给用量观测器（`?? ANTHROPIC_MESSAGES_PROTOCOL` 的另一条分支）。
 *
 * 断言原则：错误路径断言**必须报错**（不得静默成功）；容错路径断言**不得抛错**且结束事件合法。
 */
describe("Anthropic Messages runtime：错误路径与选项分支", () => {
  /** 本 block 自用的运行构造（上一块的 buildRuntime 是其 describe 内的局部函数，作用域外不可见）。 */
  function buildRuntime(baseUrl: string): AnthropicMessagesRuntime {
    return new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
    });
  }

  async function startCustomStatusServer(
    statusCode: number,
    bodyText: string,
  ): Promise<{ baseUrl: string }> {
    server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
        response.end(bodyText);
      });
    });
    await new Promise<void>((resolve) => {
      (server as http.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    return { baseUrl: "http://127.0.0.1:" + String(port) + "/anthropic/v1/messages" };
  }

  it("⑫ HTTP 502：必须报错，不得当成成功", async () => {
    const { baseUrl } = await startCustomStatusServer(502, "bad gateway");
    const runtime = buildRuntime(baseUrl);
    await expect(collectEvents(runtime, buildAgentRunInput())).rejects.toThrow();
  });

  it("⑬ HTTP 200 但响应体为空：必须报错（无有效事件不得静默成功）", async () => {
    const { baseUrl } = await startFakeAnthropicServer("");
    const runtime = buildRuntime(baseUrl);
    await expect(collectEvents(runtime, buildAgentRunInput())).rejects.toThrow();
  });

  it("⑭ 非法 SSE 行：必须跳过而不是抛错，正常事件仍可产出", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      "event: message\ndata: 这不是 JSON\n\n" +
        sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }) +
        sse({ type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } }),
    );
    const runtime = buildRuntime(baseUrl);
    const events = await collectEvents(runtime, buildAgentRunInput());
    expect(events).toContainEqual({ kind: "textDelta", deltaText: "好" });
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "success" });
  });

  it("⑮ 缺少 stop_reason：必须报错（不得当成正常结束）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }),
    );
    const runtime = buildRuntime(baseUrl);
    await expect(collectEvents(runtime, buildAgentRunInput())).rejects.toThrow();
  });

  it("⑯ 一次响应内两个 tool_use：必须产出两个 toolCallRequested", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start" }) +
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_a", name: "createProjectFile" },
        }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"filePath":".tmp/A.md","content":"A"}' },
        }) +
        sse({ type: "content_block_stop", index: 0 }) +
        sse({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_b", name: "createProjectFile" },
        }) +
        sse({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"filePath":".tmp/B.md","content":"B"}' },
        }) +
        sse({ type: "content_block_stop", index: 1 }) +
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    );
    const runtime = buildRuntime(baseUrl);
    const events = await collectEvents(runtime, buildAgentRunInput());
    const requestedCallIds = events
      .filter((event) => event["kind"] === "toolCallRequested")
      .map((event) => event["callId"]);
    expect(requestedCallIds).toEqual(["toolu_a", "toolu_b"]);
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "tool-calls" });
  });

  it("⑰ providerIdentifier 透传：观测器收到显式标识（覆盖 ?? 的另一分支）", async () => {
    const { baseUrl } = await startFakeAnthropicServer(
      sse({ type: "message_start", message: { usage: { input_tokens: 7 } } }) +
        sse({ type: "message_delta", usage: { output_tokens: 3 }, delta: { stop_reason: "end_turn" } }),
    );
    const capturedRecords: Record<string, unknown>[] = [];
    const runtime = new AnthropicMessagesRuntime({
      baseUrl,
      apiKey: "test-key",
      model: "u2-flash",
      requestTimeoutMilliseconds: 5_000,
      providerIdentifier: "custom-provider-label",
      providerRequestUsageObserver: {
        recordProviderRequestUsage: async (input: Record<string, unknown>): Promise<void> => {
          capturedRecords.push(input);
        },
      },
    });

    await collectEvents(runtime, buildAgentRunInput());
    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]?.["providerIdentifier"]).toBe("custom-provider-label");
  });
});
