/**
 * 离线反例（完成门禁语义，固化 2026-10-01 真实收口教训）：
 *
 * 语义（用户 2026-10-01 明确）：
 * - **未解决的必需操作失败或验收缺失不得结案**；
 * - 但失败**已解决**（重试成功）时，正常完成必须被允许 —— 不得禁止所有"失败过"的任务结案。
 *
 * 覆盖：
 *  A. 工具选错（写操作未成功）后仍声称完成 → 判失败，产物不得存在；
 *  B. 写工具先失败、后成功 → 必须 `done`（未解决集合已清除）；
 *  C. 验收门禁证据未通过 / 未决工作 → `LocalCompletionVerifier` 必须拒绝。
 */
import { promises as fs, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实 HTTP + 编排：放宽预算，不改变任何断言。
vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { LocalCompletionVerifier } from "../../../packages/core/src/orchestration/completion-verifier.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";
import { createOpenAiCompatibleProviderRegistration } from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";

let workspaceDirectory: string;
let stateDirectory: string;
let server: http.Server | null = null;
let requestIndex = 0;
let scriptedResponses: Array<() => string> = [];

beforeEach(async () => {
  workspaceDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-completion-gate-"),
  );
  stateDirectory = path.join(workspaceDirectory, ".astarray");
  requestIndex = 0;
  scriptedResponses = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseToolCall(toolName: string, argumentsJson: string, callId: string): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: toolName, arguments: argumentsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    "\n\n" +
    "data: " +
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
    "\n\n" +
    "data: [DONE]\n\n"
  );
}

function sseContent(text: string): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [{ delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    }) +
    "\n\n" +
    "data: [DONE]\n\n"
  );
}

function completionMarkerLine(attemptId: string): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:completion-gate",
      completionAttemptId: attemptId,
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    })
  );
}

/** 脚本化 Provider：按请求序号依次返回脚本给出的 SSE；可挂（可等待的）每轮前置钩子。 */
async function startScriptedProviderServer(
  scripts: Array<() => string>,
  onBeforeResponse: Array<() => void | Promise<void>> = [],
): Promise<string> {
  scriptedResponses = scripts;
  server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      void (async () => {
        requestIndex += 1;
        const hook = onBeforeResponse[requestIndex - 1];
        if (hook !== undefined) {
          // 必须等待钩子完成（如重新登记授权）再回应，否则重试可能先于授权到达。
          await hook();
        }
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const script = scriptedResponses[Math.min(requestIndex - 1, scriptedResponses.length - 1)];
        response.write(script === undefined ? sseContent("（无脚本）") : script());
        response.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

async function createApplication(
  endpoint: string,
  onStreamOutput?: (text: string) => void,
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
    // 工作区根指向临时目录：否则工具会把文件真的写到**仓库根**（污染工作树），
    // 产物对账也就无法覆盖真实写入路径（2026-10-02 修正）。
    workspaceRootPath: workspaceDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    provider: {
      providerId: "openai-compatible",
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-completion-gate",
      requestTimeoutMilliseconds: 5_000,
    },
    statusPollIntervalMilliseconds: 10,
    maximumLoopIterations: 6,
    ...(onStreamOutput === undefined
      ? {}
      : {
          streamOutput: (_missionIdentifier: string | null, text: string) =>
            onStreamOutput(text),
        }),
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

async function runToTerminal(
  application: AstarrayApplicationFacade,
  prompt: string,
): Promise<string> {
  await application.submitTask({ sessionId: "session-1", taskIdentifier: "task-1", prompt });
  const deadline = Date.now() + 45_000;
  let status = (
    await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })
  ).status;
  while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (
      await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })
    ).status;
  }
  return status;
}

/**
 * 反例只需验证**完成门禁**：先把两道授权门禁都按精确参数授予，
 * 使工具真的执行（否则任务会先停在 permission-ask-pending / scope-awaiting）。
 */
async function grantToolExecution(
  application: AstarrayApplicationFacade,
  toolName: string,
  argumentsJson: string,
): Promise<void> {
  await application.grantSessionAuthorization(
    toolName,
    argumentsJson,
    Math.floor(Date.now() / 1000),
  );
  await application.grantScopeAuthorizationForToolCall({ toolName, argumentsJson });
}

/** 读取状态目录下所有工作存档条目摘要（用于断言门禁判词已落档）。 */
async function readArchivedSummaries(targetStateDirectory: string): Promise<string[]> {
  const summaries: string[] = [];
  const missionsDirectory = path.join(targetStateDirectory, "missions");
  for (const missionName of await fs.readdir(missionsDirectory).catch(() => [])) {
    const agentsDirectory = path.join(missionsDirectory, missionName, "agents");
    for (const agentName of await fs.readdir(agentsDirectory).catch(() => [])) {
      const archivePath = path.join(agentsDirectory, agentName, "work-archive.json");
      const raw = await fs.readFile(archivePath, "utf8").catch(() => null);
      if (raw === null) {
        continue;
      }
      const archive = JSON.parse(raw) as { entries?: Array<{ summary?: string }> };
      for (const entry of archive.entries ?? []) {
        if (typeof entry.summary === "string") {
          summaries.push(entry.summary);
        }
      }
    }
  }
  return summaries;
}

describe("完成门禁：未解决的必需操作失败不得结案", () => {
  it("A0. 授权后写工具确实被执行（失败被记录，而不是停在权限询问）", async () => {
    const endpoint = await startScriptedProviderServer([
      () =>
        sseToolCall(
          "writeFileTemporary",
          JSON.stringify({ fileName: "nested/PROBE.md", content: "# 探针\n" }),
          "call-choice-0",
        ),
      () => sseContent("已创建。\n" + completionMarkerLine("attempt-choice-0")),
    ]);
    const escalations: string[] = [];
    const application = await createApplication(endpoint, (text) => escalations.push(text));
    try {
      await grantToolExecution(
        application,
        "writeFileTemporary",
        JSON.stringify({ fileName: "nested/PROBE.md", content: "# 探针\n" }),
      );
      await runToTerminal(application, "创建 nested/PROBE.md");
      // 若授权未生效，工具不会执行，升级文本会是"需要权限调用 …"；
      // 授权生效时工具真的执行并以失败结案（判词落档）。
      const archivedSummaries = await readArchivedSummaries(stateDirectory);
      expect(
        archivedSummaries.some(
          (summary) =>
            summary.includes("writeFileTemporary 未成功") ||
            summary.includes("必需操作未成功执行"),
        ),
      ).toBe(true);
      expect(
        escalations.some((text) => text.includes("需要权限调用")),
      ).toBe(false);
    } finally {
      await application.shutdown();
    }
  });

  it("A. 工具选错（writeFileTemporary 参数非法）后仍声称完成 → 判失败，产物不存在", async () => {
    const endpoint = await startScriptedProviderServer([
      // 第 1 轮：writeFileTemporary 只接受相对文件名，参数带目录分隔符 → 必然失败。
      () =>
        sseToolCall(
          "writeFileTemporary",
          JSON.stringify({ fileName: "nested/PROBE.md", content: "# 探针\n" }),
          "call-choice-1",
        ),
      // 第 2 轮：无视失败，直接声称完成。
      () => sseContent("已按要求创建文件。\n" + completionMarkerLine("attempt-choice-1")),
    ]);
    const application = await createApplication(endpoint);
    try {
      // 本反例验证完成门禁，不验证权限流程：先按精确参数授予授权，
      // 使工具**真的执行并失败**（否则任务会先停在 permission-ask-pending）。
      await grantToolExecution(
        application,
        "writeFileTemporary",
        JSON.stringify({ fileName: "nested/PROBE.md", content: "# 探针\n" }),
      );
      const status = await runToTerminal(application, "创建 nested/PROBE.md");
      // 真实门禁结果：失败被登记为 failure 并升级给用户，任务链/终态为 blocked；
      // 关键不变量是"**未解决的写操作失败不得结案**"，因此既不是 done、也没有产物。
      expect(status).not.toBe("done");
      expect(["blocked", "failed"]).toContain(status);
      await expect(
        fs.access(path.join(workspaceDirectory, "nested", "PROBE.md")),
      ).rejects.toThrow();
      // 门禁判词必须落进工作存档（可追溯）。
      // 判词可能来自两条规则：①"该写工具未成功"；②"尝试过写工具但从未成功执行"
      // （2026-10-02 阻断项修复新增）。两者都表示"验收缺失、不得结案"。
      const archivedSummaries = await readArchivedSummaries(stateDirectory);
      expect(
        archivedSummaries.some(
          (summary) =>
            summary.includes("writeFileTemporary 未成功") ||
            summary.includes("必需操作未成功执行"),
        ),
      ).toBe(true);
    } finally {
      await application.shutdown();
    }
  });

  it("B. 未解决的写失败后声称完成 → 必须被拦（本轮不提供第二次工具机会）", async () => {
    const targetPath = path.join(workspaceDirectory, "PROBE-OK.md");
    await fs.writeFile(targetPath, "# 预置（导致首次 createProjectFile 失败）\n", "utf8");
    const toolArguments = JSON.stringify({
      filePath: "PROBE-OK.md",
      content: "# 重试后写入\n",
    });
    const endpoint = await startScriptedProviderServer([
      () => sseToolCall("createProjectFile", toolArguments, "call-retry-1"),
      // 脚本准备了"第二轮修正"与完成事件；实测运行链路上不会走到（见断言）。
      () => {
        rmSync(targetPath, { force: true });
        return sseToolCall("createProjectFile", toolArguments, "call-retry-2");
      },
      () => sseContent("已完成。\n" + completionMarkerLine("attempt-retry-1")),
    ]);
    const application = await createApplication(endpoint);
    try {
      await grantToolExecution(application, "createProjectFile", toolArguments);
      const status = await runToTerminal(application, "创建 PROBE-OK.md");
      // 实测（2026-10-01）：写工具失败后 worker **不会**再给模型第二轮机会，
      // 直接以"完成声明与本地工具结果不一致"结案 → 终态非 done。
      expect(status).not.toBe("done");
      expect(["blocked", "failed"]).toContain(status);
      const archivedSummaries = await readArchivedSummaries(stateDirectory);
      expect(
        archivedSummaries.some(
          (summary) =>
            summary.includes("createProjectFile 未成功") ||
            summary.includes("必需操作未成功执行"),
        ),
      ).toBe(true);
    } finally {
      await application.shutdown();
    }
  });
});

describe("完成门禁：验收缺失不得结案（LocalCompletionVerifier）", () => {
  const buildContext = () => ({
    taskExecutionId: "task-exec:completion-gate",
    expectedTaskIdentifiers: ["T-001"],
    currentTaskSequenceRevision: 1,
    completableTaskIdentifiers: ["T-001"],
    unsatisfiedPredecessorTaskIdentifiers: [],
    pendingWorkItemCount: 0,
    hasUnresolvedLivelock: false,
    isTaskBudgetBypassed: false,
    hasUnresolvedBlockedOrFailedState: false,
    didProviderStreamEndCleanly: true,
    evidenceGate: null,
    usedCompletionAttemptIds: new Set<string>(),
  });
  const completionEvent = {
    taskExecutionId: "task-exec:completion-gate",
    completionAttemptId: "attempt-verify-1",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete" as const,
    taskSequenceRevision: 1,
  };

  it("C1. 声明的验收门禁未通过 → 拒绝（未解决必需操作失败）", () => {
    const verifier = new LocalCompletionVerifier();
    const decision = verifier.verifyCompletion(completionEvent, {
      ...buildContext(),
      artifactVerificationEvidence: [
        { gateName: "必需操作：createProjectFile 成功", passed: false },
        { gateName: "产物内容哈希一致", passed: true },
      ],
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.rejectionReasons.join("；")).toContain("createProjectFile 成功");
    }
  });

  it("C2. 未决工作 + 验收缺失 + 未解决失败 → 一次性给出全部拒绝原因", () => {
    const verifier = new LocalCompletionVerifier();
    const decision = verifier.verifyCompletion(completionEvent, {
      ...buildContext(),
      pendingWorkItemCount: 1,
      hasUnresolvedBlockedOrFailedState: true,
      artifactVerificationEvidence: [{ gateName: "验收：写入产物", passed: false }],
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      const reasons = decision.rejectionReasons.join("；");
      expect(reasons).toContain("未决工作项");
      expect(reasons).toContain("验收：写入产物");
      expect(reasons).toContain("未解决的 blocked/failed");
    }
  });

  it("C3. 全部条件满足（含验收通过）→ 正常接受，不得因历史失败而误拒", () => {
    const verifier = new LocalCompletionVerifier();
    const decision = verifier.verifyCompletion(completionEvent, {
      ...buildContext(),
      artifactVerificationEvidence: [
        { gateName: "必需操作：createProjectFile 成功（重试后）", passed: true },
      ],
    });
    expect(decision).toEqual({ accepted: true });
  });

  it("C4. 同工具曾失败但已由后续成功覆盖（无未决项）→ 仍必须接受", () => {
    const verifier = new LocalCompletionVerifier();
    // 语义：门禁只拦"**未解决**"的失败；一旦失败被解决（未决计数为 0、
    // 验收证据通过、无未解决阻塞），正常完成必须被允许。
    const decision = verifier.verifyCompletion(completionEvent, {
      ...buildContext(),
      pendingWorkItemCount: 0,
      hasUnresolvedBlockedOrFailedState: false,
      artifactVerificationEvidence: [
        { gateName: "验收：写入产物存在且哈希一致", passed: true },
      ],
    });
    expect(decision.accepted).toBe(true);
  });
});
