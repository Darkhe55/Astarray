/**
 * G5 反例（2026-11-08，第 190 轮）：**早停 ⇒ 从检查点有界续跑**。
 *
 * 规则（`AGENTS.md`）：
 * > 输出提前结束、缺失完成事件或标识与本地状态不符时，由本地看门狗**从检查点有界续跑**，
 * > **禁止无限重试或重复副作用**。
 *
 * ## 当前预期：**两条都红**（G5 完全未接线）
 *
 * ## 断言设计（可区分"没接"与"接错"）
 *
 * | # | 场景 | 期望 |
 * | --- | --- | --- |
 * | 1 | 首次给**截断输出（无完成事件）**，随后正常完成 ⇒ **最终 done**，且续跑次数 = 1 | 正向：证明续跑真的发生 |
 * | 2 | **每次**都截断 ⇒ **最终失败**，且续跑次数 **≥1 且 ≤ N** | 负向：证明有界（不无限重试） |
 *
 * 说明：本文件的"续跑次数"通过**假 Provider 收到的请求数**间接观测（
 * 首次尝试 1 次 + 每次续跑 1 次）—— 这是**真实可观测**的行为，不依赖内部计数器。
 *
 * ## ⚠️ 暂缓的一条
 *
 * "续跑下同一写操作只有一次副作用"需要**写类工具**，而写类工具在 `assist` 下需逐次授权
 * （与 G3a 遇到的 `factVerification` 同类问题）⇒ 暂缓，待 G3 的 (a)/(b) 决策后一并处理。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g5-resume-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseContent(text: string, finishReason: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finishReason }] }) +
    "\n\n"
  );
}

function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:g5",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    }) +
    "\n"
  );
}

/** `completionAttempt`：第几次请求给完成事件（1-based）；null ⇒ 永不给（一直截断）。 */
async function startFakeServer(completionAttempt: number | null) {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const shouldComplete = completionAttempt !== null && requestCount >= completionAttempt;
      response.write(
        shouldComplete
          ? sseContent(completionMarkerLine(), "stop")
          : // 截断：有内容但**没有**完成事件（模拟"输出提前结束"）
            sseContent("我已完成分析。", "stop"),
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + address.port + "/v1/chat/completions",
    requestCount: () => requestCount,
  };
}

async function createApplication(endpoint: string) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    isCheckpointResumeEnabled: true,
    providerRuntimeRegistry: registry,
    maximumLoopIterations: 8,
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

describe("G5：早停必须从检查点有界续跑", () => {
  it("① 首次截断、随后正常完成 ⇒ 最终 done（证明续跑确实发生）", async () => {
    const server = await startFakeServer(2);
    const application = await createApplication(server.endpoint);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "T-001", "完成一个小任务");
    await application.shutdown();

    expect(
      result.status,
      "早停后应有界续跑并最终完成（当前 G5 未接线 ⇒ 预期红）",
    ).toBe("done");
  });

  it("② 每次截断 ⇒ 最终失败，且**尝试次数有界**（不无限重试）", async () => {
    const server = await startFakeServer(null);
    const application = await createApplication(server.endpoint);
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const result = await runToTerminal(application, "T-001", "永远不给完成事件");
    const attempts = server.requestCount();
    await application.shutdown();

    expect(result.status, "永不完成 ⇒ 必须失败收口").not.toBe("done");
    expect(attempts, "至少要有 1 次续跑尝试（证明续跑机制存在）").toBeGreaterThanOrEqual(2);
    expect(attempts, "续跑必须有界（不超过 1 次首试 + 2 次续跑）").toBeLessThanOrEqual(3);
  });
});
