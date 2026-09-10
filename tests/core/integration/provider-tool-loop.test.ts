/**
 * T07D-R2-03：工具与多层调度（Provider 经工具循环真实读取 fixture）。
 * 验收：真实 fixture 读取；禁用工具无法旁路；未满足本地完成门禁不宣布成功。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

const FIXTURE_CONTENT = "FIXTURE-CONTENT-42";

let stateDirectory: string;
let fixtureDirectory: string;
let fixtureRelativePath: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r2-03-"));
  fixtureDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "t07d-r2-03-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "data.txt");
  await fs.writeFile(fixturePath, FIXTURE_CONTENT, "utf8");
  fixtureRelativePath = path.relative(process.cwd(), fixturePath).split(path.sep).join("/");
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

type ScenarioHandler = (
  body: Record<string, unknown>,
  response: http.ServerResponse,
  requestIndex: number,
) => Promise<void>;

async function startFakeServer(handler: ScenarioHandler) {
  const receivedBodies: string[] = [];
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      const requestIndex = receivedBodies.length;
      receivedBodies.push(rawBody);
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      void handler(body, response, requestIndex);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + address.port + "/v1/chat/completions",
    receivedBodies,
  };
}

function sseContent(text: string, finishReason: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finishReason }] }) +
    "\n\n"
  );
}

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

function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:provider",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

async function createProviderApplication(endpoint: string) {
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
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

async function runToTerminal(application: AstarrayApplicationFacade, prompt: string) {
  const accepted = await application.submitTask({
    sessionId: "session-1",
    taskIdentifier: "task-1",
    prompt,
  });
  let result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" });
  const deadline = Date.now() + 8_000;
  while (!["done", "failed", "blocked", "cancelled"].includes(result.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" });
  }
  return { accepted, result };
}

describe("T07D-R2-03：Provider 工具循环与完成门禁", () => {
  it("Provider 工具调用经本地权限/注册表真实读取 fixture 并回填", async () => {
    const server = await startFakeServer(async (_body, response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 0) {
        response.write(sseToolCall("readFile", JSON.stringify({ filePath: fixtureRelativePath })));
        response.end();
        return;
      }
      response.write(sseContent("已读取文件。\n" + completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    const { result } = await runToTerminal(application, "读取 fixture 并汇报");
    await application.shutdown();

    expect(result.status).toBe("done");
    expect(server.receivedBodies.length).toBeGreaterThanOrEqual(2);
    expect(server.receivedBodies[1]).toContain(FIXTURE_CONTENT);
  });

  it("未注册/禁用工具无法旁路，错误回填给 Provider", async () => {
    const server = await startFakeServer(async (_body, response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 0) {
        response.write(sseToolCall("shell", JSON.stringify({ command: "whoami" })));
        response.end();
        return;
      }
      response.write(sseContent("工具不可用。\n" + completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    const { result } = await runToTerminal(application, "尝试调用禁用工具");
    await application.shutdown();

    expect(result.status).toBe("done");
    const secondRequest = server.receivedBodies[1] ?? "";
    expect(secondRequest).toMatch(/未注册|tool-not-found|不在本 Worker/);
    expect(secondRequest).not.toContain("whoami");
  });

  it("缺少版本化完成控制事件时不得宣布成功", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseContent("我完成了任务。", "stop"));
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    const { result } = await runToTerminal(application, "无完成事件探针");
    await application.shutdown();

    expect(result.status).not.toBe("done");
  });
});
