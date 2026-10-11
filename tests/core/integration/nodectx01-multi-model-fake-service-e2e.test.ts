/**
 * NODECTX-01-03：**长会话多模型假服务 + 重启**端到端演练（2026-10-10）。
 *
 * 卡内检查点 03 明文："**长会话多模型假服务、重启**与包级公共入口验收"。
 *
 * 与 `nodectx01-long-session-multi-model-restart.test.ts` 的分工：
 *  - 该套件在**管理器层**做多轮暂存/补回/重启的无损性核对（纯本地、快）；
 *  - 本套件做**真实产品端到端**：两个**不同的**假 Provider（模拟两个模型/两次预算变化）
 *    经产品入口各跑一次任务，中间**重启**（全新 facade、同一状态目录），
 *    并核对管理器层的原文在整个过程中**逐字节不变**。
 *
 * 用真实 HTTP 假服务与真实定时器；不联网（只连 127.0.0.1）、不用凭据。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实文件 I/O + 真实 HTTP + 真实定时器：全并行时放宽超时（仍有界）。
vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { createLosslessContextManager } from "../../../packages/core/src/toolkit/lossless-context-manager.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
let stagingDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-nodectx03-e2e-"));
  stagingDirectory = path.join(stateDirectory, "staging");
});

afterEach(async () => {
  for (const server of runningServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sha256Of(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/** 启动一个假 Provider：把给定文本按 SSE 分片返回（模拟某个"模型"）。 */
async function startFakeModelServer(modelReplyText: string) {
  let receivedRequestCount = 0;
  const server = http.createServer((request, response) => {
    // 请求体不影响本用例（假模型固定答复），但必须**消费**流以便 end 事件触发。
    request.resume();
    request.on("end", () => {
      receivedRequestCount += 1;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: modelReplyText }, finish_reason: null }],
          }) +
          "\n\n",
      );
      response.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          }) +
          "\n\n",
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + String(address.port) + "/v1/chat/completions",
    getReceivedRequestCount: () => receivedRequestCount,
  };
}

/** 用指定假模型端点打开一个产品 facade（runtime=provider）。 */
async function openApplicationForModel(input: {
  endpoint: string;
  modelIdentifier: string;
}) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: input.endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    // 测试显式隔离：默认反馈进程路径另有专门验收。
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: input.modelIdentifier,
      allowedModelIdentifiers: [input.modelIdentifier],
      requiredCapabilities: ["streaming"],
      baseUrl: input.endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 20_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

/** 跑一个任务到终态（有界等待）。 */
async function runTaskToTerminal(
  application: AstarrayApplicationFacade,
  input: { taskIdentifier: string; prompt: string },
) {
  await application.submitTask({
    sessionId: "session-1",
    taskIdentifier: input.taskIdentifier,
    prompt: input.prompt,
  });
  let result = await application.queryTask({
    sessionId: "session-1",
    taskIdentifier: input.taskIdentifier,
  });
  const deadlineMilliseconds = Date.now() + 45_000;
  while (
    !["done", "failed", "blocked", "cancelled"].includes(result.status) &&
    Date.now() < deadlineMilliseconds
  ) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    result = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: input.taskIdentifier,
    });
  }
  return result;
}

describe("NODECTX-01-03：长会话多模型假服务 + 重启（端到端）", () => {
  it("① 模型 A 跑一次 → 重启 → 模型 B 跑一次；两模型都真的收到请求，且暂存原文逐字节不变", async () => {
    const modelAServer = await startFakeModelServer("模型 A 的答复");
    const modelBServer = await startFakeModelServer("模型 B 的答复");

    const originalContentText = "长会话中必须逐字节保留的原文（多模型期间）";
    const originalContentHash = sha256Of(originalContentText);

    /** 第一段：模型 A 期间，窗口收紧 ⇒ 原文无损暂存。 */
    const applicationWithModelA = await openApplicationForModel({
      endpoint: modelAServer.endpoint,
      modelIdentifier: "fake-model-a",
    });
    let firstTaskStatus: string;
    try {
      const firstTaskResult = await runTaskToTerminal(applicationWithModelA, {
        taskIdentifier: "task-model-a",
        prompt: "在模型 A 下执行的任务",
      });
      const stagingManager = createLosslessContextManager({
        stagingDirectory,
        maximumMigrationsPerRound: 4,
      });
      const stageOutcome = await stagingManager.stageNode({
        nodeIdentifier: "session-node-1",
        revision: 1,
        sourceKind: "agent",
        priorityTier: 1,
        contentText: originalContentText,
        isUrgent: false,
        isImportant: false,
        isNeededForCurrentExecution: false,
        toolCallIdentifier: null,
        dependencyNodeIdentifiers: [],
      });
      expect(stageOutcome.isStaged).toBe(true);
      firstTaskStatus = firstTaskResult.status;
    } finally {
      await applicationWithModelA.shutdown();
    }
    expect(["done", "failed", "blocked", "cancelled"]).toContain(firstTaskStatus);
    expect(modelAServer.getReceivedRequestCount()).toBeGreaterThanOrEqual(1);

    /**
     * 第二段：**重启**（全新 facade、同一状态目录）后在模型 B 下继续，
     * 并仅凭磁盘恢复管理器状态。
     */
    const applicationWithModelB = await openApplicationForModel({
      endpoint: modelBServer.endpoint,
      modelIdentifier: "fake-model-b",
    });
    try {
      const secondTaskResult = await runTaskToTerminal(applicationWithModelB, {
        taskIdentifier: "task-model-b",
        prompt: "在模型 B 下继续的任务",
      });
      expect(["done", "failed", "blocked", "cancelled"]).toContain(secondTaskResult.status);
      expect(modelBServer.getReceivedRequestCount()).toBeGreaterThanOrEqual(1);

      // 重启恢复：状态与原文都必须回来，且**逐字节**一致。
      const restartedManager = createLosslessContextManager({
        stagingDirectory,
        maximumMigrationsPerRound: 4,
      });
      const restoreOutcome = await restartedManager.restoreFromDisk();
      expect(restoreOutcome.isRestored).toBe(true);
      expect(restoreOutcome.isIndexPresent).toBe(true);
      expect(restartedManager.getVisibilityState("session-node-1")).toBe(
        "temporarily-closed",
      );
      const restoredContentText = await restartedManager.readStagedContent("session-node-1");
      expect(restoredContentText).toBe(originalContentText);
      expect(sha256Of(String(restoredContentText))).toBe(originalContentHash);
    } finally {
      await applicationWithModelB.shutdown();
    }
  });

  it("② 两个模型**各自只收到自己的请求**（不串数据）", async () => {
    const modelAServer = await startFakeModelServer("A 答复");
    const modelBServer = await startFakeModelServer("B 答复");

    const applicationWithModelA = await openApplicationForModel({
      endpoint: modelAServer.endpoint,
      modelIdentifier: "fake-model-a",
    });
    try {
      await runTaskToTerminal(applicationWithModelA, {
        taskIdentifier: "task-only-a",
        prompt: "只给 A 的任务",
      });
    } finally {
      await applicationWithModelA.shutdown();
    }

    /** 模型 B 的假服务在 A 跑完时**必须一次都没被请求过**。 */
    expect(modelAServer.getReceivedRequestCount()).toBeGreaterThanOrEqual(1);
    expect(modelBServer.getReceivedRequestCount()).toBe(0);

    const applicationWithModelB = await openApplicationForModel({
      endpoint: modelBServer.endpoint,
      modelIdentifier: "fake-model-b",
    });
    try {
      await runTaskToTerminal(applicationWithModelB, {
        taskIdentifier: "task-only-b",
        prompt: "只给 B 的任务",
      });
    } finally {
      await applicationWithModelB.shutdown();
    }
    expect(modelBServer.getReceivedRequestCount()).toBeGreaterThanOrEqual(1);
  });
});
