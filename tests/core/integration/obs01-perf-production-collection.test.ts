/**
 * OBS-01（PERF-01-02 采集接线）反例（2026-11-08，第 83 轮）：
 * **生产路径必须真的产生性能样本**。
 *
 * ## 缺口（第 82 轮查实，逐条有据）
 *
 * - `perfSampleSink` **全仓只在 `runtime/tool-loop.ts` 声明**，**只有 1 个测试传入**；
 * - `runToolLoop` 的两处**生产**调用（`main-controller.ts`、`worker-agent.ts`）**都不传**；
 * - `PerfEventStore` 在生产里**只在 CLI/GUI 被构造用于查询**（`commands.ts`／`gui-server.ts`）
 *   ⇒ `queryPerfOverview` 在生产里**永远拿不到样本**。
 *
 * 即：**行内（per-request）测量在循环层已实现，但应用装配从未接上 sink**
 * —— 属于本仓反复点名的「**组件存在但产品不可达**」。
 * 仓库里早就记过这一条（`scripts/verify-u2-flash-token-usage.mjs`：
 * 「`perfSampleSink` 只被 `runtime/tool-loop.ts` 声明、**未接线到应用装配**」）。
 *
 * ## 本用例做什么
 *
 * 用**脚本文本 Provider**（OpenAI 兼容 SSE）让模型真的发起一次工具调用
 * （`readFile` —— **读类**，避免写类工具的人工授权门禁干扰本用例；
 * 即使该调用被拒，sink 仍在 `toolPort.execute` 返回后触发，故断言**不依赖 outcome**），
 * 再从**产品查询面**（`queryPerfOverview`）与**原始样本**两个角度断言"生产确实采集了"。
 *
 * 起 HTTP 服务 ⇒ 按本仓活规则**显式给出超时预算**。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { PerfEventStore, queryPerfOverview } from "../../../packages/core/src/orchestration/perf-event-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
const runningServers: http.Server[] = [];

const completionMarkerLine = () =>
  "ASTARRAY_TASK_COMPLETION_V1 " +
  JSON.stringify({
    taskExecutionId: "task-exec:perf-collection",
    completionAttemptId: "attempt-perf-collection",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });

function sseChunk(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

/** 首次请求回**工具调用**，其后回文本 + 完成标记。 */
async function startScriptedProviderServer() {
  let receivedRequestCount = 0;
  const server = http.createServer((request, response) => {
    // 请求体本用例不需要（只关心"模型被调用了几次、回了什么"），消费掉即可
    request.resume();
    request.on("end", () => {
      receivedRequestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (receivedRequestCount === 1) {
        response.write(
          sseChunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc-perf-1",
                      function: {
                        name: "readFile",
                        arguments: JSON.stringify({ filePath: "package.json" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      } else {
        response.write(
          sseChunk({
            choices: [
              {
                delta: { content: "已读取。\n" + completionMarkerLine() },
                finish_reason: "stop",
              },
            ],
          }),
        );
        response.end("data: [DONE]\n\n");
        return;
      }
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

const TERMINAL_STATUSES = ["done", "failed", "blocked", "cancelled"];

describe("OBS-01：性能样本必须由**生产路径**产生（而不是只由测试手工写入）", () => {
  beforeAll(async () => {
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-perf-"));
  });

  afterAll(async () => {
    for (const server of runningServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
  });

  /** 用脚本文本 Provider 跑一次**真实任务**（含一次工具调用），返回该次运行的状态。 */
  async function runScriptedTaskScenario(input: {
    isPerformanceCollectionEnabled: boolean | undefined;
    sessionId: string;
  }): Promise<{ receivedRequestCount: number; status: string }> {
    const providerServer = await startScriptedProviderServer();
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: providerServer.endpoint, apiKey: "fake-key" }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "provider",
      useFeedbackProcess: false,
      ...(input.isPerformanceCollectionEnabled === undefined
        ? {}
        : { isPerformanceCollectionEnabled: input.isPerformanceCollectionEnabled }),
      providerRuntimeRegistry: registry,
      provider: {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier: "perf-model",
        allowedModelIdentifiers: ["perf-model"],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: providerServer.endpoint,
        protectedCredentialReferenceId: "cred-perf",
        requestTimeoutMilliseconds: 30_000,
      },
      statusPollIntervalMilliseconds: 20,
    });

    let status = "accepted";
    try {
      application.createSession({ sessionId: input.sessionId, mode: "assist" });
      await application.submitTask({
        sessionId: input.sessionId,
        taskIdentifier: "task-perf",
        prompt: "读一下 package.json 并汇报。",
      });
      const deadline = Date.now() + 45_000;
      while (!TERMINAL_STATUSES.includes(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = (
          await application.queryTask({
            sessionId: input.sessionId,
            taskIdentifier: "task-perf",
          })
        ).status;
      }
    } finally {
      await application.shutdown();
    }
    return { receivedRequestCount: providerServer.getReceivedRequestCount(), status };
  }

  it("① 打开采集时：真实任务里的工具调用必须留下性能样本，且**产品查询面**看得见", async () => {
    const outcome = await runScriptedTaskScenario({
      isPerformanceCollectionEnabled: true,
      sessionId: "session-perf-on",
    });
    expect(outcome.receivedRequestCount, "模型必须真的被调用过").toBeGreaterThanOrEqual(1);
    expect(TERMINAL_STATUSES, "任务应收敛到终态（实际 " + outcome.status + "）").toContain(
      outcome.status,
    );

    // ① 原始样本：生产必须写入过 perf 样本
    const store = new PerfEventStore({ baseDirectory: stateDirectory });
    const samples = await store.readAll();
    expect(
      samples.length,
      "生产路径必须产生性能样本（当前为 0 ⇒ perfSampleSink 未接线到应用装配）",
    ).toBeGreaterThanOrEqual(1);

    const toolCallSamples = samples.filter((sample) =>
      sample.operationKind.startsWith("tool-call:"),
    );
    expect(
      toolCallSamples.length,
      "工具调用必须被采集（operationKind 以 tool-call: 开头）",
    ).toBeGreaterThanOrEqual(1);
    const sample = toolCallSamples[0]!;
    expect(sample.eventType).toBe("perf");
    expect(sample.observeEventVersion).toBe(1);
    // **可追溯**：身份/任务必须由编排层补齐，而不是留空
    expect(sample.sourceAgentInstanceId, "sourceAgentInstanceId 必须非空").not.toBe("");
    expect(sample.missionIdentifier, "missionIdentifier 必须非空（可追溯到 mission）").not.toBeNull();
    expect(sample.taskIdentifier).not.toBeNull();
    expect(sample.requestRevision).toBeGreaterThanOrEqual(1);

    // ② 产品查询面：CLI/GUI 用的那条查询必须看得见这些样本
    const overview = await queryPerfOverview({ store });
    expect(
      overview.coverage.totalSampleCount,
      "产品查询面必须看得见生产样本（不能只有测试手工写入的样本可见）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("② **缺省（开关未给）必须不采集** —— 防止有人把「先测再定」的开销默认打开", async () => {
    // 用**独立状态目录**，避免与用例①的样本混在一起
    const isolatedStateDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-obs-perf-default-off-"),
    );
    const originalStateDirectory = stateDirectory;
    stateDirectory = isolatedStateDirectory;
    try {
      const outcome = await runScriptedTaskScenario({
        isPerformanceCollectionEnabled: undefined,
        sessionId: "session-perf-off",
      });
      expect(outcome.receivedRequestCount, "该轮同样必须真的调用过模型").toBeGreaterThanOrEqual(1);
      const samples = await new PerfEventStore({
        baseDirectory: isolatedStateDirectory,
      }).readAll();
      expect(
        samples.length,
        "开关缺省时**不得**采集（本卡要求观察开销先测再定；默认打开会引入未测量的开销）",
      ).toBe(0);
    } finally {
      stateDirectory = originalStateDirectory;
      await fs.rm(isolatedStateDirectory, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
