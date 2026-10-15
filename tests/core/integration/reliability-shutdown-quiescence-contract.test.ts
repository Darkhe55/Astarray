/**
 * RELIABILITY 产品侧契约：**`shutdown()` 返回即静默** —— 返回之后不得再发生链落盘。
 *
 * ## 缺陷与由来（确定性复现，见 `docs/reports/SHUTDOWN_TIMING_REPRODUCTION_2026-10-12.md` §7）
 *
 * 既有记录：`MissionOrchestrator.cancel()` 只**等待**在途 worker（2 秒上限）、
 * **不中止**它 ⇒ 在途 Provider 调用照常跑完，落盘发生在 `shutdown()` 返回**之后**；
 * 若宿主此时已清理状态目录，会产生**无人接管的 `ENOENT`**（全量约 30% 出现）。
 * 源码注释明文要求"**先取得确定性复现**"再动手（上一轮把上限临时改 30 秒**无法区分**，已回退）。
 *
 * 本用例用**受控慢 Provider**（延迟 5 秒）把窗口精确造出来，
 * **无需并发负载**即可稳定复现（约 9 秒）。
 *
 * ## 断言口径（**关键，我第一版写错过**）
 *
 * 正确契约 = **"`shutdown()` 返回之后"不得再写**，而**不是**"与 `shutdown()` 之前相同"。
 * 在 `shutdown()` **期间**完成的收尾落盘（例如被中止的 worker 落一个终态）是**合法**的
 * —— 那正是"返回即静默"要保证的：返回时活已干完。
 * 故：**基准快照取在 shutdown 返回之后**，再比对越过 Provider 延迟窗口之后的状态。
 *
 * ## 两个必须的前置条件（都曾让我得到**空洞的绿**）
 *
 * 1. 链文件**必须已落盘**（否则后续比对无意义）；
 * 2. 假 Provider **必须真的收到过请求** —— 只等"链文件落盘"或只看时间窗口**不够**：
 *    那时 worker 可能尚未派发（`inFlightWorkerPromises` 为空、Provider 从未被调用），
 *    用例会**什么都没验证到**却通过。
 *
 * 起 HTTP 服务 ⇒ 按本仓活规则**显式给出超时预算**。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

/** 远大于 cancel() 的有界等待 ⇒ 任务在 shutdown 时**必然**仍在途。 */
const providerResponseDelayMilliseconds = 5_000;
/** 越过 Provider 延迟窗口后仍多观察一段，确保逮到"迟到的收尾落盘"。 */
const observationMarginMilliseconds = 2_500;

let stateDirectory: string;
const runningServers: http.Server[] = [];

const completionMarkerLine = () =>
  "ASTARRAY_TASK_COMPLETION_V1 " +
  JSON.stringify({
    taskExecutionId: "task-exec:quiescence",
    completionAttemptId: "attempt-quiescence",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });

async function startDelayedProviderServer() {
  let receivedRequestCount = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      receivedRequestCount += 1;
      setTimeout(() => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: { content: "开始处理。\n" + completionMarkerLine() },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n",
        );
        response.end("data: [DONE]\n\n");
      }, providerResponseDelayMilliseconds);
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

async function readChainState(): Promise<{ chainText: string | null; temporaryFileNames: string[] }> {
  const missionsDirectory = path.join(stateDirectory, "missions");
  let missionDirectoryNames: string[];
  try {
    missionDirectoryNames = await fs.readdir(missionsDirectory);
  } catch {
    return { chainText: null, temporaryFileNames: [] };
  }
  let chainText: string | null = null;
  const temporaryFileNames: string[] = [];
  for (const missionDirectoryName of missionDirectoryNames) {
    const missionDirectory = path.join(missionsDirectory, missionDirectoryName);
    let entries: string[];
    try {
      entries = await fs.readdir(missionDirectory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "task-chain.json") {
        try {
          chainText = await fs.readFile(path.join(missionDirectory, entry), "utf8");
        } catch {
          /* 读失败视为未落盘 */
        }
      } else if (entry.includes(".tmp")) {
        temporaryFileNames.push(missionDirectoryName + "/" + entry);
      }
    }
  }
  return { chainText, temporaryFileNames };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("RELIABILITY 契约：shutdown() 返回即静默（返回后不得再有链落盘）", () => {
  beforeAll(async () => {
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-shutdown-quiescence-"));
  });

  afterAll(async () => {
    for (const server of runningServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
  });

  it("① 在途任务被收口后，shutdown 返回之后链文件不得再变化、且无遗留临时文件", async () => {
    const providerServer = await startDelayedProviderServer();
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
      providerRuntimeRegistry: registry,
      provider: {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier: "quiescence-model",
        allowedModelIdentifiers: ["quiescence-model"],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: providerServer.endpoint,
        protectedCredentialReferenceId: "cred-quiescence",
        // 给足超时 ⇒ 确保收口来自 shutdown，而**不是** provider 超时
        requestTimeoutMilliseconds: 60_000,
      },
      statusPollIntervalMilliseconds: 25,
    });

    application.createSession({ sessionId: "quiescence-session", mode: "assist" });
    const submittedAtMilliseconds = Date.now();
    await application.submitTask({
      sessionId: "quiescence-session",
      taskIdentifier: "quiescence-task-1",
      prompt: "写一句话说明你在做什么。",
    });

    /**
     * ⚠️ 2026-11-08（第 68 轮）：两条前置条件的等待上限**从 5 秒抬到 60 秒**
     * （`attempt < 3000` × 20ms），`testTimeout` 120s → **180s**。
     *
     * **依据（真实观测）**：一次满载全量 `check` 中本用例翻红，报的正是
     * `前置条件 2 不成立：Provider 未收到请求`。
     * —— 这**不是**空洞通过，而是**前置条件在尽职**：满载下调度器在 5 秒内
     * 还没派发 worker（第 64 轮实测过同一现象：`shutdown` 6ms 返回时
     * `inFlightWorkerPromises` 还是空的、Provider 从未被调用）。
     *
     * 抬预算**不放宽**任何断言：60 秒内仍未派发 ⇒ **照样大声报错**
     * （那意味着真的有问题，不是"再等等就好"）。
     * 这与本仓"内部上限必须严格小于 `testTimeout`"的活规则一致
     * （60s + 60s + 观察窗 7.5s < 180s）。
     */
    // 前置条件 1：链文件已落盘
    let chainStateBeforeShutdown = await readChainState();
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      if (chainStateBeforeShutdown.chainText !== null) break;
      await sleep(20);
      chainStateBeforeShutdown = await readChainState();
    }
    expect(
      chainStateBeforeShutdown.chainText,
      "前置条件 1 不成立：任务未被受理并落盘（后续比对将失去意义）",
    ).not.toBeNull();

    // 前置条件 2（**必须**）：假 Provider 真的收到过请求 ⇒ 任务**真的在途**
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      if (providerServer.getReceivedRequestCount() >= 1) break;
      await sleep(20);
    }
    expect(
      providerServer.getReceivedRequestCount(),
      "前置条件 2 不成立：Provider 未收到请求 ⇒ 任务并未在途（用例将失去意义）",
    ).toBeGreaterThanOrEqual(1);

    await application.shutdown();

    // 契约口径：**以 shutdown 返回之后**为基准
    const chainStateAfterShutdownReturned = await readChainState();
    expect(
      chainStateAfterShutdownReturned.chainText,
      "shutdown 返回时链文件不存在 ⇒ 前置条件 1 的结果被破坏（异常）",
    ).not.toBeNull();

    // 越过 Provider 延迟窗口：任何"迟到的收尾落盘"都会在这段窗口内发生
    while (
      Date.now() - submittedAtMilliseconds <
      providerResponseDelayMilliseconds + observationMarginMilliseconds
    ) {
      await sleep(100);
    }

    const chainStateAfterObservationWindow = await readChainState();
    expect(
      chainStateAfterObservationWindow.chainText,
      "`shutdown()` 返回**之后**链文件仍被改写 ⇒ 违反『返回即静默』" +
        "（在途 worker 未被收口，其落盘发生在返回之后）",
    ).toBe(chainStateAfterShutdownReturned.chainText);
    expect(
      chainStateAfterObservationWindow.temporaryFileNames,
      "`shutdown()` 返回**之后**仍遗留写入中的临时文件 ⇒ 违反『返回即静默』",
    ).toEqual([]);
  });
});
