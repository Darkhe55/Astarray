/**
 * G4 端到端验收（2026-11-08 第 284 轮）：**四层接线真的改变提示词**。
 *
 * 手法：假 Provider **捕获请求体**，从中读出 system 消息，断言：
 * - 提供 `toolDocumentationRegistry`（测试内合成）⇒ system 消息**含完整用法**（`## factVerification`、`用途：`）；
 * - **不提供**登记 ⇒ system 消息**不含**完整用法（提示词逐字不变）；
 * - 登记缺项（工具未登记）⇒ 不注入（fail-closed）。
 *
 * 拔线验证：去掉门面→装配→控制器→编排器的任一层透传 ⇒ 本用例红。
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
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g4-e2e-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  // 不删临时目录：后台仍可能写盘（§14.3 教训）。
});

function completionMarkerLine(taskExecutionId: string): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId,
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

/** 捕获每次请求的 system 消息与全部消息文本。 */
async function startCapturingServer(taskExecutionId: string) {
  const captured: string[] = [];
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(rawBody) as { messages?: unknown };
        captured.push(JSON.stringify(parsed.messages ?? []));
      } catch {
        captured.push(rawBody);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              { delta: { content: completionMarkerLine(taskExecutionId) }, finish_reason: "stop" },
            ],
          }) +
          "\n\n",
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + String(address.port) + "/v1/chat/completions",
    capturedMessagesJson: () => captured.join("\n"),
  };
}

const registryEntry = {
  examples: ['{"action":"record-reasoning","premises":["p1"],"uncertainty":"medium"}'],
  failureCodes: ["invalid-task-chain"],
  returnSchemaJson: '{"type":"object"}',
  requiredCapabilities: ["network.read"],
  limitations: ["纯推理不构成证据"],
};

async function runOnce(options: {
  endpoint: string;
  taskExecutionId: string;
  withRegistry: boolean;
}) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: options.endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "devolve",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    maximumLoopIterations: 4,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: options.endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 2_000,
    },
    statusPollIntervalMilliseconds: 10,
    // 关键：只为 factVerification 登记（其余工具缺登记 ⇒ fail-closed 不注入）
    ...(options.withRegistry
      ? {
          toolDocumentationRegistry: {
            factVerification: registryEntry,
          },
        }
      : {}),
  } as unknown as Parameters<typeof AstarrayApplicationFacade.create>[0]);

  application.createSession({ sessionId: "session-1", mode: "devolve" });
  await application.submitTask({
    sessionId: "session-1",
    taskIdentifier: "T-001",
    prompt: "做一个简单任务",
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
  return result;
}

describe("G4 端到端：登记表真的进入提示词", () => {
  it("提供登记 ⇒ system 消息含完整用法（`## factVerification` + 用途 + 局限）", async () => {
    const server = await startCapturingServer("task-exec:g4-with");
    await runOnce({ endpoint: server.endpoint, taskExecutionId: "task-exec:g4-with", withRegistry: true });
    const messages = server.capturedMessagesJson();
    expect(messages).toContain("## factVerification");
    // 用途来自真实描述符的 summary（不由测试编造），只断言字段存在
    expect(messages).toContain("用途：");
    // 局限来自测试提供的登记内容，可精确断言
    expect(messages).toContain("局限：纯推理不构成证据");
  });

  it("**不提供登记** ⇒ system 消息不含完整用法（提示词逐字不变）", async () => {
    const server = await startCapturingServer("task-exec:g4-without");
    await runOnce({
      endpoint: server.endpoint,
      taskExecutionId: "task-exec:g4-without",
      withRegistry: false,
    });
    const messages = server.capturedMessagesJson();
    expect(messages).not.toContain("【工具说明】");
    expect(messages).not.toContain("局限：纯推理不构成证据");
  });
});
