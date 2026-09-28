/**
 * 生产接线：本地只读工具（T06B / ADR-0014）的 LocalToolPolicyEngine 必须真实可用。
 * 修复前：引擎从未注入 → searchProjectText 恒报"本地策略引擎未装配"（工具注册了却永远失败）。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";
import { LocalToolPolicyEngine } from "../../../packages/core/src/tools/local-tool-policy-engine.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";

const SEARCH_TOKEN = "WIRING_SEARCH_TOKEN_77";

let stateDirectory: string;
let workspaceDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-local-readonly-"));
  workspaceDirectory = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "local-readonly-ws-"));
  await fs.writeFile(
    path.join(workspaceDirectory, "notes.txt"),
    SEARCH_TOKEN + " 命中内容\n",
    "utf8",
  );
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("生产装配：本地只读工具", () => {
  it("装配 LocalToolPolicyEngine 后 searchProjectText 可执行并返回命中内容", async () => {
    const workspaceBoundary = new WorkspaceBoundary(workspaceDirectory);
    const protectedStoragePolicy = new ProtectedStoragePolicy({
      stateDirectoryPath: stateDirectory,
    });
    const localToolPolicyEngine = new LocalToolPolicyEngine({
      workspaceBoundary,
      protectedStoragePolicy,
    });
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(
        new ModeMachine("devolve"),
        new SessionAuthorizationManager(),
      ),
      registry,
      workspaceBoundary,
      temporaryDirectoryPath: path.join(stateDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => "devolve",
      protectedStoragePolicy,
      localToolPolicyEngine,
      ponderGitRepositoryPath: workspaceDirectory,
    });
    const result = await wrapper.execute(
      "searchProjectText",
      JSON.stringify({ pattern: SEARCH_TOKEN }),
      "call-search-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    const outputText = String((result as { outputText?: string }).outputText ?? "");
    expect(outputText).toContain(SEARCH_TOKEN);
    expect(outputText).toContain("notes.txt");
  });

  it("未装配引擎时明确失败（证明上一条断言依赖真实注入）", async () => {
    const workspaceBoundary = new WorkspaceBoundary(workspaceDirectory);
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(
        new ModeMachine("devolve"),
        new SessionAuthorizationManager(),
      ),
      registry,
      workspaceBoundary,
      temporaryDirectoryPath: path.join(stateDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => "devolve",
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: stateDirectory,
      }),
    });
    const result = await wrapper.execute(
      "searchProjectText",
      JSON.stringify({ pattern: SEARCH_TOKEN }),
      "call-search-2",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect(String((result as { errorMessage?: string }).errorMessage)).toContain(
      "本地策略引擎未装配",
    );
  });

  it("真实运行装配（Provider 工具循环）不再报引擎未装配", async () => {
    const receivedBodies: string[] = [];
    const server = http.createServer((request, response) => {
      let rawBody = "";
      request.on("data", (chunk) => {
        rawBody += String(chunk);
      });
      request.on("end", () => {
        const requestIndex = receivedBodies.length;
        receivedBodies.push(rawBody);
        response.writeHead(200, { "content-type": "text/event-stream" });
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
                          id: "tc-search-1",
                          function: {
                            name: "searchProjectText",
                            arguments: JSON.stringify({ pattern: SEARCH_TOKEN }),
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
          response.end();
          return;
        }
        const marker =
          "ASTARRAY_TASK_COMPLETION_V1 " +
          JSON.stringify({
            taskExecutionId: "task-exec:provider",
            completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
            completedTaskIdentifiers: ["T-001"],
            claimedStatus: "complete",
            taskSequenceRevision: 1,
          });
        response.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: "已完成。\n" + marker }, finish_reason: "stop" }],
            }) +
            "\n\n",
        );
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    runningServers.push(server);
    const endpoint =
      "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";
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
      // 测试显式隔离：默认路径集成验收见 tests/core/integration/feedback-process-default-path.test.ts
      useFeedbackProcess: false,
      providerRuntimeRegistry: registry,
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
    });
    application.createSession({ sessionId: "session-1", mode: "devolve" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "搜索关键字",
    });
    let result = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    const deadline = Date.now() + 40_000;
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
    await application.shutdown();

    const functionMessages = (JSON.parse(receivedBodies[1] ?? "{}").messages ?? []).filter(
      (message: { role?: string }) => message.role === "function",
    );
    // 运行链路的范围门禁会先要求授权（范围未知），但**不应**再出现"引擎未装配"：
    // 该错误码只在装配缺口时出现，是本检查点要锁定的回归信号。
    const joined = functionMessages.map((message: { content?: string }) => String(message.content)).join("|");
    expect(joined).not.toContain("本地策略引擎未装配");
    expect(joined.length).toBeGreaterThan(0);
  });
});
