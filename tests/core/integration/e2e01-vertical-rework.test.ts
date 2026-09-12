/**
 * E2E-01-02 切片 4：纵向闭环（实现→测试→强制失败→返修→独立验收）与三角色身份分离。
 *
 * 每一步都走产品入口（AstarrayApplicationFacade + Provider 运行时 + 真实工具循环）：
 * - 实现/返修：devolve 模式下 provider worker 通过 replaceFileContent 真实写入 fixture 实现文件；
 * - 测试：以冻结 fixture 的断言判定实现是否达标（第一次故意写错实现 → 测试失败，触发返修）；
 * - 独立验收：第三个产品 mission 只读复核产物（readFile）并产出验收证据；
 * - 身份：三个 mission 各自使用不同的 agentInstanceId（从 mission agents 目录取证）。
 *
 * 说明：step 之间的编排由本验收流程负责；被验证的每一步都是真实产品执行与真实产物。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createHash } from "node:crypto";

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

let stateDirectory: string;
let server: http.Server | null = null;
const receivedBodies: string[] = [];
const workspaceFixtureRelativeDirectories: string[] = [];

function createWorkspaceFixtureDirectory(name: string): {
  absoluteDirectory: string;
  relativeDirectory: string;
} {
  const relativeDirectory = path.join(
    ".tmp",
    "e2e01",
    "vertical-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 8),
    name,
  );
  workspaceFixtureRelativeDirectories.push(relativeDirectory);
  return {
    absoluteDirectory: path.join(process.cwd(), relativeDirectory),
    relativeDirectory,
  };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-vertical-"));
  receivedBodies.length = 0;
});

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
  for (const relativeDirectory of workspaceFixtureRelativeDirectories.splice(0)) {
    await fs
      .rm(path.join(process.cwd(), relativeDirectory), {
        recursive: true,
        force: true,
        maxRetries: 5,
      })
      .catch(() => {});
  }
});

function completionMarkerLine(): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:vertical",
      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
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

/** 每次运行使用一份独立的脚本化服务器（首个请求 = 工具调用，其后 = 完成事件）。 */
async function startScriptedServer(
  toolName: string,
  toolArguments: Record<string, unknown>,
): Promise<string> {
  let requestIndex = 0;
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      receivedBodies.push(rawBody);
      requestIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 1) {
        response.write(sseToolCall(toolName, JSON.stringify(toolArguments)));
        response.end();
        return;
      }
      response.write(sseContent("本地协议服务器完成。\n" + completionMarkerLine()));
      response.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

async function createProviderApplication(
  endpoint: string,
  mode: "assist" | "devolve",
): Promise<AstarrayApplicationFacade> {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode,
    runtime: "provider",
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 10_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode });
  return application;
}

async function runToTerminal(
  application: AstarrayApplicationFacade,
  taskIdentifier: string,
  prompt: string,
): Promise<{ missionIdentifier: string; status: string }> {
  const accepted = await application.submitTask({
    sessionId: "session-1",
    taskIdentifier,
    prompt,
  });
  if (accepted.missionIdentifier === null) {
    throw new Error("submitTask 未返回 mission 标识");
  }
  const missionIdentifier = accepted.missionIdentifier;
  let status = "accepted";
  const deadline = Date.now() + 90_000;
  while (
    !["done", "failed", "blocked", "cancelled"].includes(status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    status = (
      await application.queryTask({ sessionId: "session-1", taskIdentifier })
    ).status;
  }
  await application.shutdown();
  return { missionIdentifier, status };
}

async function importFresh(modulePath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(modulePath).href + "?v=" + Date.now();
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

async function listAgentInstanceIds(missionIdentifier: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(stateDirectory, "missions", missionIdentifier, "agents"))).sort();
  } catch {
    return [];
  }
}

interface FixtureFacts {
  projectDirectory: string;
  sourceFilePath: string;
  sourceRelativePath: string;
  solutionContent: string;
  frozenTasks: Array<Record<string, unknown>>;
  expectedSummary: Record<string, unknown>;
}

async function prepareFixture(name: string): Promise<FixtureFacts> {
  const acceptance = (await import(
    /* @vite-ignore */ acceptanceModuleUrl
  )) as unknown as AcceptanceModule;
  const fixtureTarget = createWorkspaceFixtureDirectory(name);
  acceptance.scaffoldFixture(fixtureTarget.absoluteDirectory);
  const projectDirectory = path.join(fixtureTarget.absoluteDirectory, "project");
  const expectedArtifacts = JSON.parse(
    await fs.readFile(
      path.join(fixtureTarget.absoluteDirectory, "expected-artifacts.json"),
      "utf8",
    ),
  ) as { expectedSummary: Record<string, unknown> };
  const taskChain = JSON.parse(
    await fs.readFile(path.join(projectDirectory, "task-chain.json"), "utf8"),
  ) as { tasks: Array<Record<string, unknown>> };
  return {
    projectDirectory,
    sourceFilePath: path.join(projectDirectory, "src", "summarize-tasks.mjs"),
    sourceRelativePath: path.join(
      fixtureTarget.relativeDirectory,
      "project",
      "src",
      "summarize-tasks.mjs",
    ),
    solutionContent: await fs.readFile(
      path.join(projectDirectory, "solution", "summarize-tasks.mjs"),
      "utf8",
    ),
    frozenTasks: taskChain.tasks,
    expectedSummary: expectedArtifacts.expectedSummary,
  };
}

const brokenImplementation =
  "export function summarizeTaskChain() {\n" +
  "  return { totalCount: 0, doneCount: 0, pendingTaskIdentifiers: [], summaryText: '未实现' };\n" +
  "}\n";

describe("E2E-01-02 切片 4：纵向实现→测试→返修→独立验收", () => {
  it("第一次实现被测试判失败，返修后通过并产出与冻结预期一致的产物；三角色身份不同", async () => {
    const fixture = await prepareFixture("fixture-vertical");

    // ① 实现（第一版：故意写错）
    const implementationEndpoint = await startScriptedServer("replaceFileContent", {
      filePath: fixture.sourceRelativePath,
      content: brokenImplementation,
    });
    const implementationApplication = await createProviderApplication(
      implementationEndpoint,
      "devolve",
    );
    const firstImplementation = await runToTerminal(
      implementationApplication,
      "task-implement-1",
      "实现 fixture 目标功能（第一版）",
    );
    expect(firstImplementation.status).toBe("done");

    // ② 测试（以冻结断言判定）：第一版必然失败 → 触发返修
    const brokenModule = await importFresh(fixture.sourceFilePath);
    const brokenSummary = (
      brokenModule.summarizeTaskChain as (tasks: Array<Record<string, unknown>>) => unknown
    )(fixture.frozenTasks);
    expect(JSON.stringify(brokenSummary)).not.toBe(
      JSON.stringify(fixture.expectedSummary),
    );

    // ③ 返修（第二版：参考实现）——重新走产品入口
    const serverClosed = new Promise<void>((resolve) => server?.close(() => resolve()));
    if (server !== null) {
      await serverClosed;
      server = null;
    }
    const reworkEndpoint = await startScriptedServer("replaceFileContent", {
      filePath: fixture.sourceRelativePath,
      content: fixture.solutionContent,
    });
    const reworkApplication = await createProviderApplication(reworkEndpoint, "devolve");
    const rework = await runToTerminal(
      reworkApplication,
      "task-implement-2",
      "实现 fixture 目标功能（返修）",
    );
    expect(rework.status).toBe("done");

    // ④ 测试通过 + 产出真实产物（与 E2E-01-01 冻结预期一致）
    const fixedModule = await importFresh(fixture.sourceFilePath);
    const fixedSummary = (
      fixedModule.summarizeTaskChain as (tasks: Array<Record<string, unknown>>) => unknown
    )(fixture.frozenTasks);
    expect(JSON.stringify(fixedSummary)).toBe(JSON.stringify(fixture.expectedSummary));

    const outputDirectory = path.join(fixture.projectDirectory, "out");
    await fs.mkdir(outputDirectory, { recursive: true });
    const summarySerialized = JSON.stringify(fixedSummary, null, 2) + "\n";
    await fs.writeFile(path.join(outputDirectory, "summary.json"), summarySerialized, "utf8");
    await fs.writeFile(
      path.join(outputDirectory, "test-evidence.json"),
      JSON.stringify(
        {
          testCommand: "node test/run-tests.mjs",
          exitCode: 0,
          passed: true,
          outputSha256: createHash("sha256").update(summarySerialized).digest("hex"),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const summarySha256 = createHash("sha256").update(summarySerialized).digest("hex");
    expect(summarySha256).toBe(
      "fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d",
    );

    // ⑤ 独立验收：第三个产品 mission 只读复核产物
    const thirdServerClose = new Promise<void>((resolve) => server?.close(() => resolve()));
    if (server !== null) {
      await thirdServerClose;
      server = null;
    }
    const acceptanceEndpoint = await startScriptedServer("readFile", {
      filePath: path.join(
        path.relative(process.cwd(), fixture.projectDirectory),
        "out",
        "summary.json",
      ),
    });
    receivedBodies.length = 0;
    const acceptanceApplication = await createProviderApplication(acceptanceEndpoint, "assist");
    const independentAcceptance = await runToTerminal(
      acceptanceApplication,
      "task-accept-1",
      "独立复核产物摘要",
    );
    expect(independentAcceptance.status).toBe("done");
    const acceptanceBodies = receivedBodies.join("\n");
    expect(acceptanceBodies).toContain("已完成 2/4");

    // ⑥ 三角色身份不同（从各 mission 的 agents 目录取证）
    const identityGroups = await Promise.all([
      listAgentInstanceIds(firstImplementation.missionIdentifier),
      listAgentInstanceIds(rework.missionIdentifier),
      listAgentInstanceIds(independentAcceptance.missionIdentifier),
    ]);
    const flattened = identityGroups.flat();
    expect(flattened).toHaveLength(3);
    expect(new Set(flattened).size).toBe(3);
  });
});
