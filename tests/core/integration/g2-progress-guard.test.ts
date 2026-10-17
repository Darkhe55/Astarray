/**
 * G2 验收（2026-11-08，第 130 轮）：**循环/无进展调用必须被本地检测并「有界中止」**。
 *
 * 规则依据（`AGENTS.md`）：
 * > 文件读取和其他可重复工具必须使用本地反指/活锁保护……**循环调用、无进展重试和
 * > Agent 互相回派必须有本地检测与有界中止**。
 *
 * ## 现状：**先写反例，预期红**
 *
 * `LocalProgressAndCycleGuard`（T07B / ADR-0017）已实现且有 12 处测试构造，
 * 但**生产里零使用**（见 `docs/reports/PRODUCT_WIRING_GAPS_MASTER_2026-11-08.md` 的 G2）。
 * 本文件从**真实装配入口**（`AstarrayApplicationFacade`）驱动：
 * 假 Provider **每次都返回同一个工具调用** ⇒ 不接守卫时会一直跑到 `maximumLoopIterations`。
 *
 * ## 断言（接线后必须成立）
 *
 * 1. 任务**不得以 done 收尾**（被中止，而不是"跑完 20 轮算成功"）；
 * 2. Provider 收到的请求数**显著小于** `maximumLoopIterations`（**有界中止**的证据）；
 * 3. 中止必须是**快速**的（不靠把上限调小来伪装）。
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

const MAXIMUM_LOOP_ITERATIONS = 20;

let stateDirectory: string;
let fixtureRelativePath: string;
let fixtureDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g2-guard-"));
  fixtureDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "g2-guard-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "data.txt");
  await fs.writeFile(fixturePath, "G2-FIXTURE", "utf8");
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

async function createApplication(endpoint: string, isProgressGuardEnabled: boolean) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  /**
   * `isProgressGuardEnabled` 目前**尚未**存在于门面选项（G2 未接线）⇒ 用类型断言传进去，
   * 让本反例**先红**（行为缺失），而不是被类型检查拦住。
   */
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    maximumLoopIterations: MAXIMUM_LOOP_ITERATIONS,
    isProgressGuardEnabled,
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

async function runToTerminal(application: AstarrayApplicationFacade, prompt: string) {
  await application.submitTask({
    sessionId: "session-1",
    taskIdentifier: "task-1",
    prompt,
  });
  let result = await application.queryTask({
    sessionId: "session-1",
    taskIdentifier: "task-1",
  });
  const deadline = Date.now() + 45_000;
  while (
    !["done", "failed", "blocked", "cancelled"].includes(result.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
  }
  return result;
}

describe("G2：重复相同调用必须被本地检测并**有界中止**", () => {
  it("假 Provider 每次返回同一工具调用：启用守卫后必须显著早于上限中止", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseToolCall("readFile", JSON.stringify({ filePath: fixtureRelativePath })));
      response.end();
    });
    const application = await createApplication(server.endpoint, true);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "反复读同一个文件");
    await application.shutdown();

    expect(
      result.status,
      "被守卫中止的任务不得以 done 收尾（那不是'完成'，是撞上了上限）",
    ).not.toBe("done");
    expect(
      server.receivedBodies.length,
      "必须**有界中止**：请求数应显著小于 maximumLoopIterations=" +
        String(MAXIMUM_LOOP_ITERATIONS) +
        "（否则说明守卫没接线，只是被循环上限兜住）",
    ).toBeLessThanOrEqual(8);
  });

  it("对照：**未启用**守卫时确实会跑到接近上限（证明上一条的差异来自守卫）", async () => {
    const server = await startFakeServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseToolCall("readFile", JSON.stringify({ filePath: fixtureRelativePath })));
      response.end();
    });
    const application = await createApplication(server.endpoint, false);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "反复读同一个文件（对照）");
    await application.shutdown();

    expect(
      server.receivedBodies.length,
      "对照组（守卫关闭）应接近上限 —— 这是'差异来自守卫'的证据",
    ).toBeGreaterThan(10);
    expect(["failed", "blocked", "cancelled"]).toContain(result.status);
  });
});
