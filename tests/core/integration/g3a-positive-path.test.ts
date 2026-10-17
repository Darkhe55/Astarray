/**
 * G3a **正向**反例（2026-11-08，第 139 轮）：**调用了事实验证工具之后就应当允许结案**。
 *
 * 为什么必须有这一条（前几轮的教训）：
 * 「强制调用 X」这类接线若**只有负向**反例（不调 X ⇒ 不得 done），就无法区分
 * 「**正确的门禁**」与「**一律拦**」—— 第 136 轮正是因此把缺陷藏住了
 * （`factVerification` 是 `mutationKind: "none"`，被错放进"变更类必需集"⇒ 永不可满足）。
 *
 * 本用例失败时会把门面的流式输出打出来，用于定位**还有哪道门禁**在挡（诊断不参与判定）。
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
const streamedDiagnostics: string[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g3a-positive-"));
  streamedDiagnostics.length = 0;
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function startFakeServer() {
  const server = http.createServer((request, response) => {
    // 必须消费请求体，否则 `end` 不会按预期触发（无参数 ⇒ 不产生未使用变量）。
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const requestIndex = (server as unknown as { __count?: number }).__count ?? 0;
      (server as unknown as { __count?: number }).__count = requestIndex + 1;
      if (requestIndex === 0) {
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc-1",
                        function: {
                          name: "factVerification",
                          arguments: JSON.stringify({
                            action: "record-reasoning",
                            premises: ["p1"],
                            uncertainty: "medium",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }) +
            "\n\n",
        );
      } else {
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    content:
                      "ASTARRAY_TASK_COMPLETION_V1 " +
                      JSON.stringify({
                        taskExecutionId: "task-exec:g3a-positive",
                        completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
                        completedTaskIdentifiers: ["T-001"],
                        claimedStatus: "complete",
                        taskSequenceRevision: 1,
                      }) +
                      "\n",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n",
        );
      }
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

describe("G3a 正向：调用过 factVerification ⇒ 应当允许结案", () => {
  it("高严谨 + 开关开 + record-reasoning 成功 + 宣布完成 ⇒ 应当 done", async () => {
    const endpoint = await startFakeServer();
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "devolve",
      runtime: "provider",
      useFeedbackProcess: false,
      providerRuntimeRegistry: registry,
      maximumLoopIterations: 6,
      isHighRigorEnforcementEnabled: true,
      streamOutput: (_missionIdentifier: string, text: string) => {
        streamedDiagnostics.push(text);
      },
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
    application.createSession({ sessionId: "session-1", mode: "devolve" });

    /**
     * G3a（第 211 轮，按 **ADR-0020 / T06F** 的正当路径）：
     * `factVerification` 映射到 `network.read`，而 `network.read` 在 **devolve** 下默认 `allow`、
     * 在 assist 下是 `ask`（无头环境无人审批 ⇒ 会被拒）。
     * 因此**先切到 devolve 内置 profile**，再让模型调用该工具。
     */
    // `PermissionProfileReference` 是 `{ kind, profileId }` 的联合类型（permission-profile-store.ts:23）
    await application.switchPermissionProfile({ kind: "builtin", profileId: "devolve" });

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "T-001",
      prompt: "请在公司**发布上线**前做一次**合规**核查",
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

    expect(
      result.status,
      "调用过事实工具后应当放行；否则说明还有别的门禁在拦（诊断：" +
        streamedDiagnostics.join(" | ").slice(0, 700) +
        "）",
    ).toBe("done");
  });
});
