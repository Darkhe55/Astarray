/**
 * G2 **正向**反例（2026-11-08，第 165 轮）：**守卫开启时，正常任务必须照常结案**。
 *
 * 为什么必须有这一条（前几轮的教训）：
 * G2 此前的反例全是**负向**（重复调用被中止、预算耗尽被拦、跨重启不清零），
 * 只有负向就无法区分「**正确的守卫**」与「**一律拦**」—— G3 上我正是因此把坏掉的强制
 * 藏了两轮（第 132→136 轮）。
 *
 * 本用例：守卫 **开**，一次普通工具调用 + 合法完成事件 ⇒ 必须 `done`。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
let fixtureDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g2-positive-"));
  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g2-positive-fixture-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseToolCall(toolName: string, argumentsJson: string): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "tc-1", function: { name: toolName, arguments: argumentsJson } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    "\n\n"
  );
}

function sseContent(text: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) +
    "\n\n"
  );
}

function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:g2-positive",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

async function startFakeServer(filePath: string) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      void body;
      const requestIndex = ((server as unknown as { __count?: number }).__count ?? 0) + 1;
      (server as unknown as { __count?: number }).__count = requestIndex;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        requestIndex === 1
          ? sseToolCall("readFile", JSON.stringify({ filePath }))
          : sseContent(completionMarkerLine()),
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

describe("G2 正向：守卫开启时正常任务不得被误拦", () => {
  it("守卫开 + 一次正常工具调用 + 合法完成事件 ⇒ 应当 done", async () => {
    const fixturePath = path.join(fixtureDirectory, "normal.txt");
    await fs.writeFile(fixturePath, "NORMAL-CONTENT", "utf8");
    const endpoint = await startFakeServer(fixturePath);

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
      useFeedbackProcess: false,
      providerRuntimeRegistry: registry,
      maximumLoopIterations: 6,
      isProgressGuardEnabled: true,
      provider: {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier: "fake-model",
        allowedModelIdentifiers: ["fake-model"],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: endpoint,
        protectedCredentialReferenceId: "cred-1",
        requestTimeoutMilliseconds: 2_000,
      },
      statusPollIntervalMilliseconds: 10,
    } as unknown as Parameters<typeof AstarrayApplicationFacade.create>[0]);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "T-001",
      prompt: "读一个文件然后报告完成",
    });
    let result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "T-001" });
    const deadline = Date.now() + 45_000;
    while (
      !["done", "failed", "blocked", "cancelled"].includes(result.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "T-001" });
    }
    await application.shutdown();

    expect(
      result.status,
      "守卫开启不得把**正常任务**也拦下（否则就是'一律拦'，不是'守卫'）",
    ).toBe("done");
  });
});
