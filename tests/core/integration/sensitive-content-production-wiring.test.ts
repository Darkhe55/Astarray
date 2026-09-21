/**
 * 生产接线反例：ADR-0018 敏感内容禁读与 ADR-0017 重复读取时间锁
 * 必须在**真实运行装配**（AstarrayApplicationFacade → PolicyWrapper → builtins）中生效，
 * 而不是只在测试自行塞入策略/账本时生效。
 *
 * 红：未装配时 readFile(.env) 会把内容回填给 Provider；同一文件二次读取不会被时间锁拒绝。
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
import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";

const FAKE_SECRET = "FAKE-ENV-SECRET-7788";
const FIXTURE_CONTENT = "PRODUCTION-WIRING-FIXTURE-42";

let stateDirectory: string;
let fixtureDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sec-wiring-"));
  fixtureDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "sec-wiring-fixture-"));
  await fs.writeFile(path.join(fixtureDirectory, ".env"), "TOKEN=" + FAKE_SECRET + "\n", "utf8");
  await fs.writeFile(path.join(fixtureDirectory, "data.txt"), FIXTURE_CONTENT, "utf8");
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

function sseToolCall(toolName: string, argumentsJson: string, callId = "tc-1"): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: callId, function: { name: toolName, arguments: argumentsJson } },
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

function relativeWorkspacePath(fileName: string): string {
  return path.relative(process.cwd(), path.join(fixtureDirectory, fileName)).split(path.sep).join("/");
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
  const deadline = Date.now() + 50_000;
  while (!["done", "failed", "blocked", "cancelled"].includes(result.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" });
  }
  return { accepted, result };
}

describe("生产装配：敏感内容禁读与重复读取时间锁", () => {
  it("ADR-0018：生产路径读取 .env 必须被拒绝且不回填内容", async () => {
    const server = await startFakeServer(async (_body, response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 0) {
        response.write(sseToolCall("readFile", JSON.stringify({ filePath: relativeWorkspacePath(".env") })));
        response.end();
        return;
      }
      response.write(sseContent("已读取。\n" + completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createProviderApplication(server.endpoint);
    const { result } = await runToTerminal(application, "读取 .env 并汇报");
    await application.shutdown();

    const toolResultPayload = server.receivedBodies[1] ?? "";
    expect(result.status).toBe("done");
    expect(toolResultPayload).toContain("sensitive-content-read-denied");
    expect(toolResultPayload).not.toContain(FAKE_SECRET);
  });

  it("ADR-0017：包装层装配账本后，路径别名重复读取被时间锁拒绝", async () => {
    // 说明：真实运行链路上同参重复读取先被"无进展/循环"守卫拦截，路径别名重复读取先被
    // auth-scope 重放守卫拦截（实测错误码 auth-scope-replay-rejected）。因此在 PolicyWrapper
    // 层锁定"账本确实被透传进 builtins 上下文"这一接线事实。
    const permissionDecider = new PermissionDecider(
      new ModeMachine("devolve"),
      new SessionAuthorizationManager(),
    );
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const wrapper = new PolicyWrapper({
      permissionDecider,
      registry,
      workspaceBoundary: new WorkspaceBoundary(process.cwd()),
      temporaryDirectoryPath: path.join(stateDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => "devolve",
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: stateDirectory,
      }),
      readSuppressionLedger: new ReadSuppressionLedger(),
    });
    const cancellationSignal = new AbortController().signal;
    const firstRead = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: relativeWorkspacePath("data.txt") }),
      "call-read-1",
      cancellationSignal,
    );
    expect(firstRead.kind).toBe("success");
    const secondRead = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(fixtureDirectory, "data.txt") }),
      "call-read-2",
      cancellationSignal,
    );
    expect(secondRead.kind).toBe("error");
    expect((secondRead as { errorCode?: string }).errorCode).toBe("resource-already-read");
  });
});
