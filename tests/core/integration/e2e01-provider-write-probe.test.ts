/**
 * E2E-01-02 能力探针与完成门禁回归：provider worker 在 assist 默认权限下
 * 无法写入项目文件时，**不得以文本声明结案**。
 *
 * - `replaceFileContent` 需要 project.modify + project.destructive-mutate；
 *   assist 默认对 destructive-mutate 为 deny（缺口 1，见
 *   docs/reports/E2E01_02_GAP_ANALYSIS.md）。
 * - 完成门禁必须与本轮真实工具结果对账：存在未成功的写操作时拒绝结案
 *   （缺口 2 的修复，T12A/E2E-01-02 切片 3）。
 *
 * 本用例在修复前会失败（当时任务仍以 done 收口），修复后必须通过。
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
/** 工作区内的 fixture 目录（工具只能写工作区内路径）。 */
const workspaceFixtureRelativeDirectories: string[] = [];

function createWorkspaceFixtureDirectory(name: string): {
  absoluteDirectory: string;
  relativeDirectory: string;
} {
  const relativeDirectory = path.join(
    ".tmp",
    "e2e01",
    "probe-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 8),
    name,
  );
  workspaceFixtureRelativeDirectories.push(relativeDirectory);
  return {
    absoluteDirectory: path.join(process.cwd(), relativeDirectory),
    relativeDirectory,
  };
}

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

async function startScriptedServer(
  targetFileRelativePath: string,
  content: string,
  toolName = "replaceFileContent",
) {
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
            toolName,
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

async function createProviderApplication(
  stateDirectory: string,
  endpoint: string,
  mode: "assist" | "devolve" = "assist",
) {
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
      requestTimeoutMilliseconds: 5_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode });
  return application;
}

describe("E2E-01-02 能力探针：assist 默认权限下的项目写入", () => {
  /**
   * 必须成立的不变量：写操作未成功、没有任何真实产物时，任务不得声称完成。
   */
  it("未写入产物时不得声称完成（fail-closed）", async () => {
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

  /** 补充证据：写操作失败被记为任务失败（而不是静默 done）。 */
  it("写操作失败后任务链标记为 failed，且目标文件保持桩实现", async () => {
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

    expect(status).not.toBe("done");
    expect(await fs.readFile(stubPath, "utf8")).toBe(stubContent);
    expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * 缺口 1（切片 3b）：受控的"新建项目文件"通道。
   * assist 默认（project.create=ask）→ 无应答方时 fail-closed：不落盘、任务不 done。
   */
  it("createProjectFile 在 assist 默认下 fail-closed（不落盘、不 done）", async () => {
    const acceptance = (await import(
      /* @vite-ignore */ acceptanceModuleUrl
    )) as unknown as AcceptanceModule;
    const fixtureTarget = createWorkspaceFixtureDirectory("fixture-assist");
    acceptance.scaffoldFixture(fixtureTarget.absoluteDirectory);
    const createdPath = path.join(
      fixtureTarget.absoluteDirectory,
      "project",
      "src",
      "created-by-assist.mjs",
    );
    const createdRelativePath = path.join(
      fixtureTarget.relativeDirectory,
      "project",
      "src",
      "created-by-assist.mjs",
    );

    const endpoint = await startScriptedServer(
      createdRelativePath,
      "export const created = true;\n",
      "createProjectFile",
    );
    const application = await createProviderApplication(temporaryDirectory, endpoint);
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-create-assist",
      prompt: "新建项目文件（assist）",
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
          taskIdentifier: "task-create-assist",
        })
      ).status;
    }
    await application.shutdown();

    expect(status).not.toBe("done");
    await expect(fs.access(createdPath)).rejects.toThrow();
  });

  /**
   * 缺口 1（切片 3b）：devolve 默认（project.create=allow）→ 受控通道真实落盘，
   * 且任务在写成功后结案（完成门禁与真实结果一致）。
   */
  it("createProjectFile 在 devolve 默认下真实写入并完成（真实产物）", async () => {
    const acceptance = (await import(
      /* @vite-ignore */ acceptanceModuleUrl
    )) as unknown as AcceptanceModule;
    const fixtureTarget = createWorkspaceFixtureDirectory("fixture-devolve");
    acceptance.scaffoldFixture(fixtureTarget.absoluteDirectory);
    const createdPath = path.join(
      fixtureTarget.absoluteDirectory,
      "project",
      "src",
      "created-by-devolve.mjs",
    );
    const createdRelativePath = path.join(
      fixtureTarget.relativeDirectory,
      "project",
      "src",
      "created-by-devolve.mjs",
    );

    const endpoint = await startScriptedServer(
      createdRelativePath,
      "export const created = true;\n",
      "createProjectFile",
    );
    const application = await createProviderApplication(
      temporaryDirectory,
      endpoint,
      "devolve",
    );
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-create-devolve",
      prompt: "新建项目文件（devolve）",
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
          taskIdentifier: "task-create-devolve",
        })
      ).status;
    }
    await application.shutdown();

    expect(status).toBe("done");
    expect(await fs.readFile(createdPath, "utf8")).toContain("created = true");
  });
});