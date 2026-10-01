import { describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRuntime, ToolCallResult } from "../../../packages/core/src/core/types.js";
import {
  OpenAiCompatibleRuntime,
  parseServerSentEvents,
} from "../../../packages/core/src/runtime/openai-compatible-runtime.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import type { ScriptedRunStep } from "../../../packages/core/src/runtime/scripted-runtime.js";
import { runToolLoop } from "../../../packages/core/src/runtime/tool-loop.js";

function makeRunInput(agentId = "worker-1"): AgentRunInput {
  return {
    missionId: "mission-1",
    agentId,
    systemPrompt: "系统提示",
    userPrompt: "用户任务",
    availableToolDescriptors: [],
    maxLoopIterations: 5,
  };
}

function collectEvents(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const events: unknown[] = [];
    for await (const event of iterable) {
      events.push(event);
    }
    return events;
  })();
}

describe("ScriptedRuntime", () => {
  it("回放文本增量与完成", async () => {
    const runtime = new ScriptedRuntime([
      { type: "text", text: "你好，" },
      { type: "text", text: "世界" },
      { type: "finish", reason: "success", detail: "完成" },
    ]);
    const events = await collectEvents(
      runtime.run(makeRunInput(), new AbortController().signal),
    );
    expect(events).toEqual([
      { kind: "textDelta", deltaText: "你好，" },
      { kind: "textDelta", deltaText: "世界" },
      { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" },
    ]);
  });

  it("工具调用步骤产出 toolCallRequested", async () => {
    const runtime = new ScriptedRuntime([
      {
        type: "tool-call",
        toolName: "readFile",
        argumentsJson: '{"filePath":"a.txt"}',
        callId: "call-1",
      },
      { type: "finish", reason: "tool-calls", detail: "请求工具" },
    ]);
    const events = await collectEvents(
      runtime.run(makeRunInput(), new AbortController().signal),
    );
    expect(events[0]).toMatchObject({
      kind: "toolCallRequested",
      toolName: "readFile",
      callId: "call-1",
    });
    expect(events[1]).toMatchObject({ kind: "runFinished", reason: "tool-calls" });
  });

  it("取消信号中断脚本", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const runtime = new ScriptedRuntime([
      { type: "text", text: "不会输出" },
    ]);
    const events = await collectEvents(runtime.run(makeRunInput(), abortController.signal));
    expect(events).toEqual([
      { kind: "runFinished", agentId: "worker-1", reason: "cancelled", detail: expect.any(String) },
    ]);
  });

  it("流式消费中途取消：已产出增量后中断", async () => {
    const abortController = new AbortController();
    const runtime = new ScriptedRuntime([
      { type: "text", text: "第一部分" },
      { type: "text", text: "第二部分" },
      { type: "finish", reason: "success", detail: "完成" },
    ]);
    const iterator = runtime.run(
      makeRunInput(),
      abortController.signal,
    )[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.value).toMatchObject({ kind: "textDelta" });
    abortController.abort();
    const secondChunk = await iterator.next();
    expect(secondChunk.value).toMatchObject({
      kind: "runFinished",
      reason: "cancelled",
    });
  });

  it("脚本耗尽后报 error", async () => {
    const runtime = new ScriptedRuntime([]);
    const events = await collectEvents(
      runtime.run(makeRunInput(), new AbortController().signal),
    );
    expect(events).toEqual([
      { kind: "runFinished", agentId: "worker-1", reason: "error", detail: expect.any(String) },
    ]);
  });
});

describe("parseServerSentEvents", () => {
  it("解析 data 行并忽略 [DONE] 与坏行", () => {
    const payload = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}",
      "data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}",
      "data: [DONE]",
      "data: 这不是 JSON",
      "",
    ].join("\n");
    const chunks = parseServerSentEvents(payload);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe("a");
  });
});

function buildSseResponse(
  chunks: Array<Record<string, unknown>>,
): Response {
  const payload = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}`)
    .join("\n");
  return new Response(payload, { status: 200 });
}

describe("OpenAiCompatibleRuntime", () => {
  it("流式输出 + 工具调用累积（分段 arguments）", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedRequests.push({
        url: String(url),
        init: init ?? {},
      });
      return buildSseResponse([
        { choices: [{ delta: { content: "先" } }] },
        { choices: [{ delta: { content: "生" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call-x", function: { name: "read", arguments: '{"path"' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':"a.txt"}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    };
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-test-key-1234567890",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const events = await collectEvents(
      runtime.run(makeRunInput(), new AbortController().signal),
    );
    const textEvents = events.filter((event) => (event as { kind: string }).kind === "textDelta");
    expect(textEvents).toEqual([
      { kind: "textDelta", deltaText: "先" },
      { kind: "textDelta", deltaText: "生" },
    ]);
    const toolCallEvents = events.filter(
      (event) => (event as { kind: string }).kind === "toolCallRequested",
    );
    expect(toolCallEvents).toEqual([
      {
        kind: "toolCallRequested",
        callId: "call-x",
        toolName: "read",
        argumentsJson: '{"path":"a.txt"}',
      },
    ]);
    const requestBody = JSON.parse(
      (capturedRequests[0]?.init.body as string) ?? "{}",
    ) as {
      messages: Array<{ role: string }>;
      tools: unknown[];
    };
    expect(requestBody.tools).toHaveLength(0);
    expect(requestBody.messages[0]).toMatchObject({ role: "system" });
  });

  it("fetch 拒绝（网络/超时）转为 provider-timeout DomainError", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-test-key-1234567890",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: (() => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(
      collectEvents(runtime.run(makeRunInput(), new AbortController().signal)),
    ).rejects.toMatchObject({ errorCode: "provider-timeout" });
  });

  it("非 2xx 响应转为 provider-timeout", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-test-key-1234567890",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: (() =>
        new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(
      collectEvents(runtime.run(makeRunInput(), new AbortController().signal)),
    ).rejects.toMatchObject({ errorCode: "provider-timeout" });
  });

  it("finish_reason=stop 正常完成；异常 finish_reason 报 provider-timeout", async () => {
    const successRuntime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-test-key-1234567890",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: (() =>
        buildSseResponse([
          { choices: [{ delta: { content: "结果" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])) as unknown as typeof fetch,
    });
    const successEvents = await collectEvents(
      successRuntime.run(makeRunInput(), new AbortController().signal),
    );
    expect(successEvents).toEqual([
      { kind: "textDelta", deltaText: "结果" },
      { kind: "runFinished", agentId: "worker-1", reason: "success", detail: expect.any(String) },
    ]);

    const abnormalRuntime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-test-key-1234567890",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: (() =>
        buildSseResponse([
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ])) as unknown as typeof fetch,
    });
    await expect(
      collectEvents(abnormalRuntime.run(makeRunInput(), new AbortController().signal)),
    ).rejects.toMatchObject({ errorCode: "provider-timeout" });
  });

  it("错误消息不包含 API key（脱敏可判定）", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "https://provider.example/v1/chat/completions",
      apiKey: "sk-top-secret-api-key-987654321",
      model: "test-model",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: (() => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const failure = await collectEvents(
      runtime.run(makeRunInput(), new AbortController().signal),
    ).catch((error: Error) => error);
    expect(String(failure)).not.toContain("sk-top-secret-api-key-987654321");
  });
});

describe("runToolLoop", () => {
  it("工具结果回填为 OpenAI 规范消息序列：assistant(tool_calls) + role=tool（不得用 role=function）", async () => {
    const capturedInputs: AgentRunInput[] = [];
    let iterationIndex = 0;
    const capturingRuntime: AgentRuntime = {
      async *run(agentRunInput: AgentRunInput): AsyncIterable<never> {
        capturedInputs.push({
          ...agentRunInput,
          toolResultMessages: [...(agentRunInput.toolResultMessages ?? [])],
        });
        iterationIndex += 1;
        if (iterationIndex === 1) {
          yield {
            kind: "toolCallRequested",
            agentId: agentRunInput.agentId,
            toolName: "createProjectFile",
            callId: "call-spec-1",
            argumentsJson: '{"filePath":"tasks/PROBE-001.md","content":"x"}',
          } as never;
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: "tool-calls",
            detail: "请求工具",
          } as never;
          return;
        }
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "success",
          detail: "完成",
        } as never;
      },
    };
    const toolPort: { execute: (...args: unknown[]) => Promise<ToolCallResult> } = {
      execute: async () => ({
        kind: "error",
        callId: "call-spec-1",
        errorCode: "permission-ask-pending",
        errorMessage: "工具需要用户裁决",
        isIdempotencyConfirmed: true,
      }),
    };
    await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: capturingRuntime,
        toolPort: toolPort as unknown as never,
        maxLoopIterations: 5,
        cancellationSignal: new AbortController().signal,
      }),
    );

    // 第 2 次迭代必须携带规范化的续发消息。
    const secondIterationMessages = capturedInputs[1]?.toolResultMessages ?? [];
    expect(secondIterationMessages.length).toBeGreaterThanOrEqual(2);
    const assistantMessage = secondIterationMessages[0] as Record<string, unknown>;
    expect(assistantMessage["role"]).toBe("assistant");
    expect(Array.isArray(assistantMessage["tool_calls"])).toBe(true);
    const assistantToolCalls = assistantMessage["tool_calls"] as Array<
      Record<string, unknown>
    >;
    expect(assistantToolCalls[0]).toMatchObject({
      id: "call-spec-1",
      type: "function",
      function: { name: "createProjectFile" },
    });
    const toolMessage = secondIterationMessages[1] as Record<string, unknown>;
    expect(toolMessage["role"]).toBe("tool");
    expect(toolMessage["tool_call_id"]).toBe("call-spec-1");
    expect(String(toolMessage["content"])).toContain("permission-ask-pending");
    // 真实 OpenAI 兼容端点会拒绝 role=function（实测 400 invalid msg role）。
    expect(
      secondIterationMessages.some(
        (message) => (message as Record<string, unknown>)["role"] === "function",
      ),
    ).toBe(false);
    // 首轮不得注入完成协议重述（只在工具执行后出现，避免污染初始提示）。
    const firstIterationMessages = capturedInputs[0]?.toolResultMessages ?? [];
    expect(
      firstIterationMessages.some((message) =>
        JSON.stringify(message).includes("ASTARRAY_TASK_COMPLETION_V1"),
      ),
    ).toBe(false);
    // 工具执行后必须注入本地完成协议重述：真实模型在工具执行后往往不再重复完成事件，
    // 导致任务被判 blocked（2026-10-01 真实服务实测）。
    const protocolReminder = secondIterationMessages.find((message) => {
      const record = message as Record<string, unknown>;
      return (
        record["role"] === "system" &&
        String(record["content"] ?? "").includes("ASTARRAY_TASK_COMPLETION_V1")
      );
    }) as Record<string, unknown> | undefined;
    expect(protocolReminder).toBeDefined();
    expect(String(protocolReminder?.["content"])).toContain("最后一行");
    // 真实收口实测（2026-10-01）：模型先做"文件是否已存在"的预检探查，探查被授权边界拒绝后
    // 便放弃创建。重述必须明确 create-only 语义（无需预检），否则任务会停在"模糊/受阻"。
    expect(String(protocolReminder?.["content"])).toContain("无需先做");
    expect(String(protocolReminder?.["content"])).toContain("createProjectFile");
    expect(secondIterationMessages.at(-1)).toBe(protocolReminder);
  });

  it("执行工具调用并回填结果后再次调用 runtime", async () => {
    const callLog: string[] = [];
    const scriptedRuntime = new ScriptedRuntime([
      {
        type: "tool-call",
        toolName: "readFile",
        argumentsJson: '{"filePath":"a.txt"}',
        callId: "call-1",
      },
      { type: "finish", reason: "tool-calls", detail: "第一次迭代请求工具" },
      { type: "text", text: "最终结果" },
      { type: "finish", reason: "success", detail: "完成" },
    ]);
    const toolPort: { execute: (...args: unknown[]) => Promise<ToolCallResult> } = {
      execute: async () => ({
        kind: "success",
        callId: "call-1",
        outputText: "文件内容",
        isSideEffectFree: true,
      }),
    };
    const events = await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: scriptedRuntime as unknown as AgentRuntime,
        toolPort: toolPort as unknown as never,
        maxLoopIterations: 5,
        cancellationSignal: new AbortController().signal,
        buildToolResultMessage: (callId, toolName) => {
          callLog.push(`${toolName}:${callId}`);
          return { role: "function", tool_call_id: callId, content: "文件内容" };
        },
      }),
    );
    expect(callLog).toEqual(["readFile:call-1"]);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({ kind: "runFinished", reason: "success" });
  });

  it("达到最大迭代次数报 max-iterations", async () => {
    const loopPairs: Array<ScriptedRunStep> = [];
    for (let pairIndex = 0; pairIndex < 4; pairIndex++) {
      loopPairs.push(
        {
          type: "tool-call",
          toolName: "readFile",
          argumentsJson: "{}",
          callId: `call-loop-${pairIndex}`,
        },
        { type: "finish", reason: "tool-calls", detail: "循环" },
      );
    }
    const scriptedRuntime = new ScriptedRuntime(loopPairs);
    const events = await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: scriptedRuntime as unknown as AgentRuntime,
        toolPort: {
          execute: async () => ({
            kind: "success",
            callId: "call-loop",
            outputText: "x",
            isSideEffectFree: true,
          }),
        } as never,
        maxLoopIterations: 3,
        cancellationSignal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      kind: "runFinished",
      reason: "max-iterations",
    });
  });

  it("工具调用请求但无结果可迭代时报 error", async () => {
    const scriptedRuntime = new ScriptedRuntime([
      { type: "finish", reason: "tool-calls", detail: "声明工具但未产出调用" },
    ]);
    const events = await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: scriptedRuntime as unknown as AgentRuntime,
        toolPort: {
          execute: async () => ({
            kind: "error",
            callId: "call-x",
            errorCode: "unknown",
            errorMessage: "x",
            isIdempotencyConfirmed: false,
          }),
        } as never,
        maxLoopIterations: 5,
        cancellationSignal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "error" });
  });

  it("非工具事件透传（如 statusChanged）", async () => {
    const passthroughRuntime: AgentRuntime = {
      run: async function* () {
        yield {
          kind: "statusChanged",
          agentId: "worker-1",
          previousStatus: "idle",
          nextStatus: "busy",
        };
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "success",
          detail: "完成",
        };
      },
    };
    const events = await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: passthroughRuntime,
        toolPort: {
          execute: async () => ({
            kind: "error",
            callId: "call-x",
            errorCode: "unknown",
            errorMessage: "x",
            isIdempotencyConfirmed: false,
          }),
        } as never,
        maxLoopIterations: 5,
        cancellationSignal: new AbortController().signal,
      }),
    );
    expect(events[0]).toMatchObject({ kind: "statusChanged" });
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "success" });
  });

  it("取消信号终止循环", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const scriptedRuntime = new ScriptedRuntime([
      { type: "text", text: "不执行" },
      { type: "finish", reason: "success", detail: "不应到达" },
    ]);
    const events = await collectEvents(
      await runToolLoop(makeRunInput(), {
        runtime: scriptedRuntime as unknown as AgentRuntime,
        toolPort: {
          execute: async () => ({
            kind: "error",
            callId: "call-0",
            errorCode: "unknown",
            errorMessage: "x",
            isIdempotencyConfirmed: false,
          }),
        } as never,
        maxLoopIterations: 5,
        cancellationSignal: abortController.signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: "runFinished", reason: "cancelled" });
  });
});
