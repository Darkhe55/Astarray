/**
 * OBS-01／DIAG（生产采集接线）反例（2026-11-08，第 85 轮）：
 * **诊断事件必须由生产路径产生**，且**不得把"拒绝/取消"记成故障**。
 *
 * ## 缺口（第 82 轮查实）
 *
 * 生产里**没有任何地方构造 `DiagnosticEvent`**：`DiagnosticEventStore` 只在
 * CLI/GUI 被构造**用于查询**（`commands.ts`／`gui-server.ts`），
 * 其写入方法 `append` **只被测试调用** ⇒ `queryDiagnosticSummary` 在生产里恒"不可报告"。
 * 与 `PERF` 是**同一类**「组件存在但产品不可达」。
 *
 * ## 卡内硬约束（本用例逐条守）
 *
 * > 正常计划暂停、**用户拒绝、取消**与程序故障**分开，不把等待都记成失败**
 *
 * ⇒ 三条用例：① 真故障**必须**采集且产品查询面看得见；
 * ② **拒绝**（工具不存在 ⇒ 执行前即被拒）**不得**产生故障事件；
 * ③ 采集**缺省关**，未给开关时不得写任何事件。
 *
 * 起 HTTP 服务 ⇒ 按本仓活规则**显式给出超时预算**。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  DiagnosticEventStore,
  queryDiagnosticSummary,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

const runningServers: http.Server[] = [];
const temporaryDirectories: string[] = [];

const TERMINAL_STATUSES = ["done", "failed", "blocked", "cancelled"];

function sseChunk(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

const completionMarkerLine = () =>
  "ASTARRAY_TASK_COMPLETION_V1 " +
  JSON.stringify({
    taskExecutionId: "task-exec:diag-collection",
    completionAttemptId: "attempt-diag-collection",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });

/** 首次请求回**工具调用**（工具名可指定），其后回文本 + 完成标记。 */
async function startScriptedProviderServer(toolName: string, argumentsJson: string) {
  let receivedRequestCount = 0;
  const server = http.createServer((request, response) => {
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
                      id: "tc-diag-1",
                      function: { name: toolName, arguments: argumentsJson },
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
                delta: { content: "已处理。\n" + completionMarkerLine() },
                finish_reason: "stop",
              },
            ],
          }),
        );
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

/** 跑一次真实任务（含一次指定工具调用），返回该次运行结果与所用状态目录。 */
async function runScriptedTaskScenario(input: {
  toolName: string;
  argumentsJson: string;
  isDiagnosticCollectionEnabled: boolean | undefined;
  sessionId: string;
}): Promise<{ stateDirectory: string; receivedRequestCount: number; status: string }> {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-obs-diag-"));
  temporaryDirectories.push(stateDirectory);
  const providerServer = await startScriptedProviderServer(input.toolName, input.argumentsJson);
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
    ...(input.isDiagnosticCollectionEnabled === undefined
      ? {}
      : { isDiagnosticCollectionEnabled: input.isDiagnosticCollectionEnabled }),
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "diag-model",
      allowedModelIdentifiers: ["diag-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: providerServer.endpoint,
      protectedCredentialReferenceId: "cred-diag",
      requestTimeoutMilliseconds: 30_000,
    },
    statusPollIntervalMilliseconds: 20,
  });

  let status = "accepted";
  try {
    application.createSession({ sessionId: input.sessionId, mode: "assist" });
    await application.submitTask({
      sessionId: input.sessionId,
      taskIdentifier: "task-diag",
      prompt: "执行一次工具调用并汇报。",
    });
    const deadline = Date.now() + 45_000;
    while (!TERMINAL_STATUSES.includes(status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (
        await application.queryTask({
          sessionId: input.sessionId,
          taskIdentifier: "task-diag",
        })
      ).status;
    }
  } finally {
    await application.shutdown();
  }
  return {
    stateDirectory,
    receivedRequestCount: providerServer.getReceivedRequestCount(),
    status,
  };
}

describe("OBS-01／DIAG：诊断事件必须由**生产路径**产生，且拒绝不得记成故障", () => {
  afterAll(async () => {
    for (const server of runningServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of temporaryDirectories) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("① 真故障（工具执行失败）必须被采集，且**产品查询面**看得见", async () => {
    const outcome = await runScriptedTaskScenario({
      // 读一个**不存在**的文件 ⇒ 真实执行失败（不在"执行前拒绝"集合里）
      toolName: "readFile",
      argumentsJson: JSON.stringify({ filePath: "definitely-missing-diag-probe.txt" }),
      isDiagnosticCollectionEnabled: true,
      sessionId: "session-diag-on",
    });
    expect(outcome.receivedRequestCount, "模型必须真的被调用过").toBeGreaterThanOrEqual(1);
    expect(TERMINAL_STATUSES, "任务应收敛到终态（实际 " + outcome.status + "）").toContain(
      outcome.status,
    );

    const store = new DiagnosticEventStore({ baseDirectory: outcome.stateDirectory });
    const events = await store.readAll();
    expect(
      events.length,
      "生产路径必须产生诊断事件（当前为 0 ⇒ 生产里无人构造 DiagnosticEvent）",
    ).toBeGreaterThanOrEqual(1);

    const failureEvent = events.find((event) => event.eventType === "diagnostic");
    expect(failureEvent, "必须有 diagnostic 事件").toBeDefined();
    expect(failureEvent!.stage, "工具执行失败 ⇒ stage 必须是 tool").toBe("tool");
    expect(failureEvent!.severity).toBe("error");
    expect(failureEvent!.errorCode, "必须带稳定的 DomainErrorCode，而不是空串").not.toBe("");
    expect(failureEvent!.classification).toBe("deterministic-fact");
    // **可追溯**：身份/任务必须由编排层补齐
    expect(failureEvent!.sourceAgentInstanceId, "sourceAgentInstanceId 必须非空").not.toBe("");
    expect(
      failureEvent!.missionIdentifier,
      "missionIdentifier 必须非空（否则故障无法追溯到任务）",
    ).not.toBeNull();
    expect(failureEvent!.taskIdentifier).not.toBeNull();

    // **产品查询面**：CLI/GUI 用的那条查询必须看得见（且是"确定事实"，不是"不可报告"）
    const summary = await queryDiagnosticSummary({ store });
    expect(
      summary.isReportable,
      "有真实诊断事件时不得报「不可报告」",
    ).toBe(true);
    expect(
      summary.deterministicFindings.length,
      "该事件必须作为**确定事实**出现（不得降级成推断）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("② **执行前拒绝（工具不存在）不得记成故障** —— 卡内明令区分拒绝与故障", async () => {
    const outcome = await runScriptedTaskScenario({
      toolName: "tool-that-does-not-exist-in-registry",
      argumentsJson: "{}",
      isDiagnosticCollectionEnabled: true,
      sessionId: "session-diag-refusal",
    });
    expect(outcome.receivedRequestCount, "模型必须真的被调用过").toBeGreaterThanOrEqual(1);

    const events = await new DiagnosticEventStore({
      baseDirectory: outcome.stateDirectory,
    }).readAll();
    const failureEvents = events.filter((event) => event.severity === "error");
    expect(
      failureEvents.length,
      "「工具不存在」属**执行前拒绝**（确定无副作用），不得记成程序故障：" +
        JSON.stringify(failureEvents.map((event) => event.errorCode)),
    ).toBe(0);
  });

  it("③ **缺省（开关未给）不得采集** —— 不在未决策时改变生产行为", async () => {
    const outcome = await runScriptedTaskScenario({
      toolName: "readFile",
      argumentsJson: JSON.stringify({ filePath: "definitely-missing-diag-probe.txt" }),
      isDiagnosticCollectionEnabled: undefined,
      sessionId: "session-diag-default-off",
    });
    expect(outcome.receivedRequestCount).toBeGreaterThanOrEqual(1);
    const events = await new DiagnosticEventStore({
      baseDirectory: outcome.stateDirectory,
    }).readAll();
    expect(events.length, "开关缺省时不得写任何诊断事件").toBe(0);
  });
});
