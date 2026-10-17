/**
 * G2 预算持久化验收（2026-11-08，第 161 轮）：按 **T07E 卡原文**要求实现。
 *
 * 卡内要求（`docs/tasks/T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md`）：
 *
 * - L27：「新建 Agent、模型切换、Provider切换、**早停续跑、进程重启**和 handoff
 *   **不能清零任务链累计预算**。」
 * - L82（检查点 T07E-04）：「任务链累计预算、重启/handoff 保持和防 Agent 分裂绕过」
 *   验收：「**新身份/续跑不清零**；个体预算仍相互隔离」。
 *
 * ## 本反例怎么模拟"进程重启"
 *
 * 用**同一个 `stateDirectory`** 新建**第二个** `AstarrayApplicationFacade` 实例
 * （第一个实例 `shutdown()` 之后）—— 这正是"应用重启、磁盘状态保留"的等价场景。
 *
 * ## 断言
 *
 * 1. 预算上限设为 **3** 次工具调用（测试用旋钮，缺省 200 不变）；
 * 2. 第一个实例消费掉 3 次 ⇒ 被拦（`progress-guard` 生效）；
 * 3. **重启后**（第二个实例、同一 state 目录）**不得重新获得 3 次额度** ⇒
 *    再调 1 次即被拦（累计已超预算）。
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
let fixtureDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g2-budget-"));
  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g2-budget-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "data.txt");
  await fs.writeFile(fixturePath, "BUDGET-FIXTURE", "utf8");
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

async function startFakeServer() {
  const counter = { value: 0 };
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      counter.value += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      // 每次都返回**不同文件**的读取 ⇒ "有进展"，只受**总调用预算**约束。
      const filePath = path.join(fixtureDirectory, "f" + String(counter.value) + ".txt");
      void fs.writeFile(filePath, "X" + String(counter.value), "utf8");
      response.write(
        sseToolCall("readFile", JSON.stringify({ filePath })),
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + address.port + "/v1/chat/completions",
    requestCount: () => counter.value,
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
    providerRuntimeRegistry: registry,
    maximumLoopIterations: 50,
    isProgressGuardEnabled: true,
    /** 测试旋钮：把总调用预算调到 3（缺省 200 不变）。 */
    progressGuardTaskTotalCallBudget: 3,
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

describe("G2 预算：进程重启不得清零任务链累计预算（T07E L27）", () => {
  it("同一 state 目录第二个实例不得重新获得预算额度", async () => {
    const server = await startFakeServer();

    // 第一次运行：消费预算直到被守卫拦（预算 3）。
    const firstApplication = await createApplication(server.endpoint);
    firstApplication.createSession({ sessionId: "session-1", mode: "assist" });
    const firstResult = await runToTerminal(firstApplication, "T-001", "连续读取不同文件");
    const firstRequestCount: number = server.requestCount();
    await firstApplication.shutdown();
    expect(firstResult.status, "预算耗尽后不得 done").not.toBe("done");

    // "重启"：同一 state 目录、**新实例**。
    const secondApplication = await createApplication(server.endpoint);
    secondApplication.createSession({ sessionId: "session-1", mode: "assist" });
    const secondResult = await runToTerminal(secondApplication, "T-001", "重启后继续同一任务链");
    const secondRequestCount: number = server.requestCount() - firstRequestCount;
    await secondApplication.shutdown();

    expect(
      secondResult.status,
      "重启后不得重新获得预算 ⇒ 仍不得 done（否则就是卡里明令禁止的'进程重启清零预算'）",
    ).not.toBe("done");
    expect(
      secondRequestCount,
      "重启后最多只允许极少数调用（预算已累计超限）；若又拿到 3 次以上说明预算被清零了",
    ).toBeLessThanOrEqual(2);
  });
});
