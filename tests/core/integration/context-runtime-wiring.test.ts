/**
 * T09A-R1-01：上下文装配进入产品请求（本地测试服务器捕获请求体）。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实文件 I/O + 真实定时器：全量并行时放宽超时（仍为有界）。
vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-r1-01-int-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-01：产品请求中的上下文装配", () => {
  it("本地服务器收到的请求包含系统规则/必要条件/相关全局记录，且不含无关记录", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory: stateDirectory });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "RELATED-DECISION-TEXT",
      keyRationale: "当前任务约束",
      appliesToScope: "T-001",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "UNRELATED-DECISION-TEXT",
      keyRationale: "无关范围",
      appliesToScope: "T-999",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });

    const receivedBodies: string[] = [];
    const server = http.createServer((request, response) => {
      let rawBody = "";
      request.on("data", (chunk) => {
        rawBody += String(chunk);
      });
      request.on("end", () => {
        receivedBodies.push(rawBody);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    content:
                      "已处理。\n" +
                      "ASTARRAY_TASK_COMPLETION_V1 " +
                      JSON.stringify({
                        taskExecutionId: "task-exec:context",
                        completionAttemptId: "attempt-context",
                        completedTaskIdentifiers: ["T-001"],
                        claimedStatus: "complete",
                        taskSequenceRevision: 1,
                      }),
                  },
                  finish_reason: "stop",
                },
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
    const endpoint = "http://127.0.0.1:" + address.port + "/v1/chat/completions";

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
        requiredCapabilities: ["streaming"],
        baseUrl: endpoint,
        protectedCredentialReferenceId: "cred-1",
        requestTimeoutMilliseconds: 2_000,
      },
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "上下文装配探针",
    });
    const deadline = Date.now() + 20_000;
    let status = "accepted";
    while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
    }
    await application.shutdown();

    expect(status).toBe("done");
    expect(receivedBodies).toHaveLength(1);
    const requestBody = receivedBodies[0] ?? "";
    expect(requestBody).toContain("[系统规则]");
    expect(requestBody).toContain("[任务必要条件]");
    expect(requestBody).toContain("[全局相关决策]");
    expect(requestBody).toContain("[局部活跃前沿]");
    expect(requestBody).toContain("RELATED-DECISION-TEXT");
    expect(requestBody).not.toContain("UNRELATED-DECISION-TEXT");
  });
});
