/**
 * G3 验收（2026-11-08，阶段三）：**高严谨性任务必须被本地规则标记，并被强制调用事实验证工具**。
 *
 * 规则依据（`AGENTS.md`）：
 * > 高严谨性任务由**本地规则标记**，并**强制调用事实验证工具形成证据包**。
 * > 证据优先级固定为「资料搜索依据 > 本地实验验证 > 纯推理验证」……
 *
 * ## 现状：**先写反例，预期红**
 *
 * `LocalRigorPolicyEngine`（T06D / ADR-0016）已实现版本化本地规则（法律/医疗/财务/安全边界/
 * 破坏性操作/发布决策/身份权限/时效性事实/用户要求严格 ⇒ high），但**生产里零使用**
 * （`docs/reports/PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md` 的 G3）⇒ **没有任何任务会被标记**、
 * 证据包**从不被强制**（模型可以调 `factVerification`，但没东西要求它）。
 *
 * ## 断言设计（三条，缺一不可）
 *
 * 1. **高严谨 + 开关开 + 模型只发完成事件** ⇒ **不得** `done`（必须被拦）；
 * 2. **低严谨 + 开关开** ⇒ 照常 `done`（证明拦截**只作用于高严谨任务**、不是"一律拦"）；
 * 3. **高严谨 + 开关关** ⇒ 照常 `done`（证明差异**来自接线**，而不是别的东西）。
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
/** 诊断用：把门面的流式输出捕获下来，**仅在断言失败时**拼进消息（不参与判定）。 */
const streamedDiagnostics: string[] = [];
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g3-rigor-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
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

/** 一个"合法但空"的完成事件：模型直接宣布完成，**没有调用任何工具**。 */
function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:g3",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      // 内部任务标识恒为 T-001（完成事件必须声明**本任务**，否则被既有完成门禁判为 blocked）。
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

async function createApplication(endpoint: string, isHighRigorEnforcementEnabled: boolean) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  /**
   * `isHighRigorEnforcementEnabled` 目前**尚未**存在于门面选项（G3 未接线）⇒ 用类型断言传入，
   * 让反例**先红**（行为缺失），而不是被类型检查拦住。
   */
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    streamOutput: (_missionIdentifier: string, text: string) => {
      streamedDiagnostics.push(text);
    },
    maximumLoopIterations: 4,
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

const HIGH_RIGOR_PROMPT = "请在公司**发布上线**前做一次**合规**与**权限**边界核查";
const LOW_RIGOR_PROMPT = "帮我把这段文字的错别字挑出来";

describe("G3：高严谨性任务必须被本地规则标记并强制调用事实验证工具", () => {
  it("高严谨 + 开关开 + 只发完成事件（未调 factVerification）⇒ 不得 done", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseContent(completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createApplication(server.endpoint, true);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "T-001", HIGH_RIGOR_PROMPT);
    await application.shutdown();

    expect(
      result.status,
      "高严谨任务没有调用事实验证工具 ⇒ 证据包缺失 ⇒ **不得**结案为 done",
    ).not.toBe("done");
  });

  it("低严谨 + 开关开 ⇒ 照常 done（拦截**只**作用于高严谨任务）", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseContent(completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createApplication(server.endpoint, true);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "T-002", LOW_RIGOR_PROMPT);
    await application.shutdown();

    expect(
      result.status,
      "低严谨任务不该被这条门禁影响（诊断：" + streamedDiagnostics.join(" | ").slice(0, 600) + "）",
    ).toBe("done");
  });

  it("高严谨 + 开关关 ⇒ 照常 done（证明差异来自接线）", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseContent(completionMarkerLine(), "stop"));
      response.end();
    });
    const application = await createApplication(server.endpoint, false);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "T-003", HIGH_RIGOR_PROMPT);
    await application.shutdown();

    expect(result.status, "开关关闭时行为必须与现状一致").toBe("done");
  });
});
