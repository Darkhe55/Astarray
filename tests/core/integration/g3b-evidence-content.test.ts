/**
 * G3b-1 验收（2026-11-08，第 136 轮）：**高严谨任务必须产出「证据包」，只有推理不算依据**。
 *
 * ## 现状：**先写反例，预期红**
 *
 * G3a 已接「高严谨 ⇒ **必须调用过** `factVerification`」。但 `EvidenceCompletionGate` 仍是零使用：
 * 只要"调用过"就放行，**不管证据包是否存在/合格**。
 *
 * ## 为什么用 `record-reasoning`（判别性关键）
 *
 * `executeFactVerification` 四条 action 的真实行为（第 135 轮实读源码）：
 *
 * - `search-sources`：**需要搜索代理**，无则 **throw**（离线）；
 * - `build-evidence-bundle`：需要 `evidenceBundleBuilder`（**生产中未装配**）；
 * - **`record-reasoning`：无需外部依赖、会成功**，返回 `relation: "insufficient"`、`entryType: "reasoning"`；
 *
 * ⇒ 用 `record-reasoning` 可以做到「**G3a 的'调用过'被满足**、但**只有推理、没有证据包**」，
 * 从而**单独**检验"内容门禁"是否存在 —— 否则会被 G3a 的"必需工具未成功"混淆（第 134 轮踩过）。
 *
 * ## 断言
 *
 * 1. 高严谨 + 开关开 + 只 `record-reasoning` 后宣布完成 ⇒ **不得 done**（纯推理不足以结案）；
 * 2. 对照：同一流程 + 开关关 ⇒ 照常 done（**证明差异来自接线**）。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g3b1-evidence-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  // 2026-11-08（第 257 轮）：**不删临时目录**。
    // 实测：门禁拒绝的用例会让应用在 shutdown 后仍有后台写盘，
    // 与 rm 竞态产生 `ENOENT: rename` 的 unhandled error（vitest exit 1）。
    // 目录交给操作系统临时区回收；用例不再做删除。
    void stateDirectory;
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
      taskExecutionId: "task-exec:g3b1",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      // 内部任务标识恒为 T-001（完成事件必须声明本任务）。
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

const REASONING_ONLY_CALL = JSON.stringify({
  action: "record-reasoning",
  premises: ["按经验判断该配置可用"],
  uncertainty: "medium",
});

async function createApplication(endpoint: string, isHighRigorEnforcementEnabled: boolean) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "devolve",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    maximumLoopIterations: 6,
    isHighRigorEnforcementEnabled,
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
}

async function runToTerminal(
  application: AstarrayApplicationFacade,
  taskIdentifier: string,
  prompt: string,
) {
  await application.submitTask({ sessionId: "session-1", taskIdentifier, prompt });
  let result = await application.queryTask({ sessionId: "session-1", taskIdentifier });
  const deadline = Date.now() + 45_000;
  while (
    !["done", "failed", "blocked", "cancelled"].includes(result.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({ sessionId: "session-1", taskIdentifier });
  }
  return result;
}

const HIGH_RIGOR_PROMPT = "请在公司**发布上线**前做一次**合规**核查，并给出**结论**";

describe("G3b-1：高严谨任务必须产出证据包（纯推理不算依据）", () => {
  it("高严谨 + 开关开 + 只 record-reasoning 后宣布完成 ⇒ 不得 done", async () => {
    const server = await startFakeServer(async (_body, response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        requestIndex === 0
          ? sseToolCall("factVerification", REASONING_ONLY_CALL)
          : sseContent(completionMarkerLine()),
      );
      response.end();
    });
    const application = await createApplication(server.endpoint, true);
    application.createSession({ sessionId: "session-1", mode: "devolve" });

    const result = await runToTerminal(application, "T-001", HIGH_RIGOR_PROMPT);
    await application.shutdown();

    expect(
      result.status,
      "只有推理、没有证据包 ⇒ 纯推理验证不足 ⇒ **不得**结案为 done",
    ).not.toBe("done");
  });

  it("对照：同一流程 + 开关关 ⇒ 照常 done（证明差异来自接线）", async () => {
    const server = await startFakeServer(async (_body, response, requestIndex) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        requestIndex === 0
          ? sseToolCall("factVerification", REASONING_ONLY_CALL)
          : sseContent(completionMarkerLine()),
      );
      response.end();
    });
    const application = await createApplication(server.endpoint, false);
    application.createSession({ sessionId: "session-1", mode: "devolve" });

    const result = await runToTerminal(application, "T-001", HIGH_RIGOR_PROMPT);
    await application.shutdown();

    expect(result.status, "开关关闭时行为必须与现状一致").toBe("done");
  });
});
