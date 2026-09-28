/**
 * 思索模式（Ponder）只读白名单工具反例（AGENTS.md 硬性要求）：
 * 思索模式"只允许本地只读白名单工具查看项目文件、检索文本和查询只读任务状态"，
 * 修复前 respondInPonderMode 暴露 0 个工具且不接工具循环 → 规则不成立。
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

const FIXTURE_CONTENT = "PONDER_READONLY_FIXTURE_55";

let stateDirectory: string;
let fixtureDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ponder-tools-"));
  fixtureDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "ponder-tools-"));
  await fs.writeFile(path.join(fixtureDirectory, "notes.txt"), FIXTURE_CONTENT + "\n", "utf8");
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

const relativeFixturePath = (): string =>
  path.relative(process.cwd(), path.join(fixtureDirectory, "notes.txt")).split(path.sep).join("/");

async function startFakeServer(
  handler: (response: http.ServerResponse, requestIndex: number) => void,
): Promise<{ endpoint: string; receivedBodies: string[] }> {
  const receivedBodies: string[] = [];
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      const requestIndex = receivedBodies.length;
      receivedBodies.push(rawBody);
      handler(response, requestIndex);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  return {
    endpoint: "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions",
    receivedBodies,
  };
}

const sseToolCall = (toolName: string, argumentsJson: string, callId: string): string =>
  "data: " +
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: callId, function: { name: toolName, arguments: argumentsJson } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  }) +
  "\n\n";

const sseText = (text: string): string =>
  "data: " +
  JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) +
  "\n\n";

async function askInPonder(
  endpoint: string,
  streamedTexts: string[],
): Promise<{ promise: Promise<string>; streamedTexts: string[] }> {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "ponder",
    runtime: "provider",
    // 测试显式隔离：默认路径集成验收见 tests/core/integration/feedback-process-default-path.test.ts
    useFeedbackProcess: false,
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
    streamOutput: (_missionIdentifier, text) => {
      streamedTexts.push(text);
    },
  });
  application.createSession({ sessionId: "session-1", mode: "ponder" });
  return { promise: application.handleUserMessage("查看 notes.txt"), streamedTexts };
}

describe("思索模式只读白名单工具（生产装配）", () => {
  it("思索模式暴露只读白名单工具，隐藏写/执行类工具", async () => {
    const server = await startFakeServer((response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 0) {
        response.write(sseToolCall("readFile", JSON.stringify({ filePath: relativeFixturePath() }), "tc-read-1"));
        response.end();
        return;
      }
      response.write(sseText("已查看文件。"));
      response.end();
    });
    const streamedTexts: string[] = [];
    await (await askInPonder(server.endpoint, streamedTexts)).promise;

    const firstRequest = server.receivedBodies[0] ?? "";
    const secondRequest = server.receivedBodies[1] ?? "";
    expect(firstRequest).toContain("readFile");
    expect(firstRequest).not.toContain("writeFileTemporary");
    // 工具真实执行：正文回填进下一轮请求
    expect(secondRequest).toContain(FIXTURE_CONTENT);
  });

  it("思索模式拒绝白名单外工具（fail-closed）", async () => {
    const server = await startFakeServer((response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 0) {
        response.write(
          sseToolCall(
            "writeFileTemporary",
            JSON.stringify({ filePath: relativeFixturePath(), content: "x" }),
            "tc-write-1",
          ),
        );
        response.end();
        return;
      }
      response.write(sseText("无法写入。"));
      response.end();
    });
    const streamedTexts: string[] = [];
    await (await askInPonder(server.endpoint, streamedTexts)).promise;

    const secondRequest = server.receivedBodies[1] ?? "";
    expect(secondRequest).toContain("tool-permission-denied");
    expect(secondRequest).not.toContain(FIXTURE_CONTENT + "x");
  });
});
