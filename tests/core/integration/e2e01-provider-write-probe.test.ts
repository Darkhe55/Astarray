/**
 * E2E-01-02 能力探针：provider worker 在 assist 默认权限下无法写入项目文件，
 * 却仍能把任务标成 done（**已确认缺陷**，记录于
 * docs/reports/E2E01_02_GAP_ANALYSIS.md 缺口 2）。
 *
 * - `replaceFileContent` 需要 project.modify + project.destructive-mutate；
 *   assist 默认对 destructive-mutate 为 deny。
 * - 本文件同时包含：① 必须成立的不变量（当前失败 → it.fails），
 *   ② 当前行为的特征记录（修复后应删除）。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
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

const acceptanceModuleUrl = new URL(
  "../../../scripts/e2e01-acceptance.mjs",
  import.meta.url,
).href;

interface AcceptanceModule {
  scaffoldFixture: (targetDirectory: string) => { fingerprint: string };
}

let temporaryDirectory: string;
let server: http.Server | null = null;
const receivedBodies: string[] = [];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-probe-"));
  receivedBodies.length = 0;
});

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:probe",
      completionAttemptId: "attempt-probe",
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    })
  );
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

function sseContent(text: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) +
    "\n\n"
  );
}

async function startScriptedServer(targetFileRelativePath: string, content: string) {
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      receivedBodies.push(rawBody);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (receivedBodies.length === 1) {
        response.write(
          sseToolCall(
            "replaceFileContent",
            JSON.stringify({ filePath: targetFileRelativePath, content }),
          ),
        );
        response.end();
        return;
      }
      response.write(sseContent("已尝试写入。\n" + completionMarkerLine()));
      response.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

async function createProviderApplication(stateDirectory: string, endpoint: string) {
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
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 5_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

describe("E2E-01-02 能力探针：assist 默认权限下的项目写入", () => {
  /**
   * 必须成立的不变量：没有任何真实产物写入时，任务不得声称完成。
   * 当前实现会返回 done（缺陷 2），故本用例以 it.fails 记录；
   * 修复后应改为普通 it 并保持通过。
   */
  it.fails("未写入产物时不得声称完成（当前为缺陷：会 done）", async () => {
    const acceptance = (await import(
      /* @vite-ignore */ acceptanceModuleUrl
    )) as unknown as AcceptanceModule;
    const fixtureTarget = path.join(temporaryDirectory, "fixture");
    acceptance.scaffoldFixture(fixtureTarget);
    const fixtureProjectDirectory = path.join(fixtureTarget, "project");
    const stubPath = path.join(fixtureProjectDirectory, "src", "summarize-tasks.mjs");
    const stubContent = await fs.readFile(stubPath, "utf8");
    expect(stubContent).toContain("E2E01_TARGET_NOT_IMPLEMENTED");

    const endpoint = await startScriptedServer(
      stubPath,
      "export function summarizeTaskChain() { return { totalCount: 0 }; }\n",
    );
    const application = await createProviderApplication(
      temporaryDirectory,
      endpoint,
    );
    const accepted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "实现 fixture 目标功能",
    });
    let status = "accepted";
    const deadline = Date.now() + 50_000;
    while (
      !["done", "failed", "blocked", "cancelled"].includes(status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      status = (
        await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })
      ).status;
    }
    await application.shutdown();

    expect(accepted.missionIdentifier).toMatch(/^mission-/);
    // 未取得破坏性写权限 → 不得声称完成
    expect(status).toBe("blocked");
    // 目标文件保持桩实现（没有产物被伪造或被静默写入）
    expect(await fs.readFile(stubPath, "utf8")).toBe(stubContent);
  });

  /** 当前行为特征记录（缺陷 2）：完成事件被接受但目标文件未变；修复后删除本用例。 */
  it("特征记录：当前会以 done 收口，但目标文件保持桩实现", async () => {
    const acceptance = (await import(
      /* @vite-ignore */ acceptanceModuleUrl
    )) as unknown as AcceptanceModule;
    const fixtureTarget = path.join(temporaryDirectory, "fixture-pinned");
    acceptance.scaffoldFixture(fixtureTarget);
    const fixtureProjectDirectory = path.join(fixtureTarget, "project");
    const stubPath = path.join(fixtureProjectDirectory, "src", "summarize-tasks.mjs");
    const stubContent = await fs.readFile(stubPath, "utf8");

    const endpoint = await startScriptedServer(
      stubPath,
      "export function summarizeTaskChain() { return { totalCount: 0 }; }\n",
    );
    const application = await createProviderApplication(temporaryDirectory, endpoint);
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-pinned",
      prompt: "实现 fixture 目标功能（特征记录）",
    });
    let status = "accepted";
    const deadline = Date.now() + 50_000;
    while (
      !["done", "failed", "blocked", "cancelled"].includes(status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      status = (
        await application.queryTask({
          sessionId: "session-1",
          taskIdentifier: "task-pinned",
        })
      ).status;
    }
    await application.shutdown();

    expect(status).toBe("done");
    expect(await fs.readFile(stubPath, "utf8")).toBe(stubContent);
    expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
  });
});