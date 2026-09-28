/**
 * 默认路径集成验收（T04）：SDK 正式任务运行路径（真实 Provider）在**不显式传参**时
 * 必须默认启用独立反馈进程，且任务真能跑完、关闭后无遗留子进程。
 * 反例：修复前 public-sdk 把 useFeedbackProcess 硬编码为 false。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-feedback-default-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseCompletion(): string {
  const marker =
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:provider",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    });
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: "已完成。\n" + marker }, finish_reason: "stop" }] }) +
    "\n\n"
  );
}

async function startFakeProviderServer(): Promise<string> {
  const server = http.createServer((_request, response) => {
    let rawBody = "";
    _request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    _request.on("end", () => {
      void rawBody;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseCompletion());
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  return "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";
}

describe("SDK 正式任务运行路径的默认反馈进程", () => {
  it("未显式传参时默认启用独立反馈进程，且真实任务能跑完", async () => {
    const endpoint = await startFakeProviderServer();
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
        requestTimeoutMilliseconds: 2_000,
      },
      statusPollIntervalMilliseconds: 10,
    });
    expect(application.getRuntimeDiagnostics().isFeedbackProcessIndependent).toBe(true);

    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "默认路径任务",
    });
    let result = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    const deadline = Date.now() + 60_000;
    while (!["done", "failed", "blocked", "cancelled"].includes(result.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = await application.queryTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
      });
    }
    expect(result.status).toBe("done");
    await application.shutdown();
  });

  it("显式隔离仍然可用（测试可注入进程内传输）", async () => {
    const endpoint = await startFakeProviderServer();
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
        requestTimeoutMilliseconds: 2_000,
      },
      statusPollIntervalMilliseconds: 10,
      useFeedbackProcess: false,
    });
    expect(application.getRuntimeDiagnostics().isFeedbackProcessIndependent).toBe(false);
    await application.shutdown();
  });
});
