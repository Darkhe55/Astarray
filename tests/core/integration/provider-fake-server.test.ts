/**
 * T07D-R2-02：生产入口连通本地协议服务器（fake server）。
 * 覆盖：分片中文 + 慢流、工具调用参数消费、429、断流、超时、取消。
 * 适配器不得直接执行工具或决定完成（工具执行只能来自本地工具循环/端口）。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实文件 I/O + 真实定时器：全量并行时放宽超时（仍为有界）。
vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r2-02-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const completionMarkerLine = () =>
  "ASTARRAY_TASK_COMPLETION_V1 " +
  JSON.stringify({
    taskExecutionId: "task-exec:provider",
    completionAttemptId: "attempt-fake",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });

type ScenarioHandler = (
  body: Record<string, unknown>,
  response: http.ServerResponse,
  requestIndex: number,
) => Promise<void>;

async function startFakeServer(handler: ScenarioHandler) {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      const requestIndex = requestCount;
      requestCount += 1;
      void handler(body, response, requestIndex);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + address.port + "/v1/chat/completions",
    getRequestCount: () => requestCount,
  };
}

function writeSseChunk(response: http.ServerResponse, content: string, finishReason: string | null): void {
  response.write(
    "data: " +
      JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] }) +
      "\n\n",
  );
}

async function createProviderApplication(
  endpoint: string,
  overrides: { requestTimeoutMilliseconds?: number } = {},
) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: overrides.requestTimeoutMilliseconds ?? 2_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

async function runToTerminal(
  application: AstarrayApplicationFacade,
  prompt: string,
  taskIdentifier = "task-1",
) {
  const accepted = await application.submitTask({
    sessionId: "session-1",
    taskIdentifier,
    prompt,
  });
  let result = await application.queryTask({ sessionId: "session-1", taskIdentifier });
  const deadline = Date.now() + 50_000;
  while (!["done", "failed", "blocked", "cancelled"].includes(result.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({ sessionId: "session-1", taskIdentifier });
  }
  return { accepted, result };
}

describe("T07D-R2-02：经产品入口连接本地 fake server", () => {
  it("分片中文 + 慢流：增量消费完成并得到受控结果", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSseChunk(response, "分布", null);
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeSseChunk(response, "式恢", null);
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeSseChunk(response, "复完成", null);
      writeSseChunk(response, "\n" + completionMarkerLine(), "stop");
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    const { accepted, result } = await runToTerminal(application, "分片中文探针");
    await application.shutdown();

    expect(accepted.missionIdentifier).not.toBeNull();
    expect(result.status).toBe("done");
    expect(result.summaryPreview ?? "").toContain("分布式恢复完成");
    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1);
  });

  it("429 不得被当作成功", async () => {
    const rateLimitedServer = await startFakeServer(async (_body, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const rateLimitedApp = await createProviderApplication(rateLimitedServer.endpoint);
    const rateLimited = await runToTerminal(rateLimitedApp, "429 探针");
    await rateLimitedApp.shutdown();
    expect(rateLimited.result.status).not.toBe("done");
  });

  it("断流不得被当作成功", async () => {
    const disconnectServer = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSseChunk(response, "部分", null);
      response.socket?.destroy();
    });
    const disconnectApp = await createProviderApplication(disconnectServer.endpoint);
    const disconnected = await runToTerminal(disconnectApp, "断流探针");
    await disconnectApp.shutdown();
    expect(disconnected.result.status).not.toBe("done");
  });

  it("Provider 超时不得被当作成功", async () => {
    const timeoutServer = await startFakeServer(async () => {
      // 故意不响应，触发 Provider 超时
    });
    const timeoutApp = await createProviderApplication(timeoutServer.endpoint, {
      requestTimeoutMilliseconds: 300,
    });
    const timedOut = await runToTerminal(timeoutApp, "超时探针");
    await timeoutApp.shutdown();
    expect(timedOut.result.status).not.toBe("done");
  });

  it("取消在途 Provider 调用得到 cancelled 终态", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSseChunk(response, "开始", null);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      writeSseChunk(response, "结束", "stop");
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-cancel",
      prompt: "取消探针",
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await application.cancelTask({
      sessionId: "session-1",
      taskIdentifier: "task-cancel",
    });
    const cancelled = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-cancel",
    });
    await application.shutdown();
    expect(cancelled.status).toBe("cancelled");
  });

  it("工具调用参数被消费且不由适配器执行", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc-1",
                      function: { name: "readFile", arguments: '{"filePath":"a.txt"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) +
          "\n\n",
      );
      response.end();
    });
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: server.endpoint, apiKey: "fake-key" }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());
    const resolved = await registry.resolveRuntime({
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      baseUrl: server.endpoint,
      protectedCredentialReferenceId: "cred-1",
    });
    const runtime = resolved.createRuntime();
    const events: Array<{ kind: string; toolName?: string; argumentsJson?: string }> = [];
    for await (const event of runtime.run(
      {
        agentId: "agent-1",
        systemPrompt: "system",
        userPrompt: "use tool",
        availableToolDescriptors: [
          {
            name: "readFile",
            summary: "读取文件",
            category: "readonly",
            backupPolicy: "not-required",
            mutationKind: "none",
            inputSchema: { type: "object" },
          },
        ],
      } as never,
      new AbortController().signal,
    )) {
      events.push(event as never);
    }
    const toolCallEvents = events.filter((event) => event.kind === "toolCallRequested");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      toolName: "readFile",
      argumentsJson: '{"filePath":"a.txt"}',
    });
    // 适配器只声明工具调用；本地没有工具端口 → 不产生任何本地执行结果事件
    expect(events.some((event) => event.kind === "toolCallFinished")).toBe(false);
  });
});
