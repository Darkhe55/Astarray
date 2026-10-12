/**
 * GUI-02-01 片① 反例：**CLI 路径必须登记权限询问的请求实体**（含 owner 身份）。
 *
 * 这是片① 的**功能验证**：步1–4 打通了"身份到达 CLI"的通路，但没有它就无法确认
 * 通路真的生效 —— 我在 mock 运行时下实测**无法触发**权限询问
 * （mock 不请求受限工具，`createProjectFile` 仅出现在提示词文本里），
 * 故必须用**假 Provider**（真的返回受限工具调用）来驱动。
 *
 * **复用既有 harness**：`tests/tui/integration/authorization-retry-closure.test.ts`
 * 的手法 —— 本地 HTTP 假 Provider 返回 `createProjectFile` 工具调用、`spawn` 真实
 * `dist/cli.js`、按"见到完整 JSON 即收口"等待（该 CLI 在给出结果后仍会滞留）。
 *
 * 断言（本文件钉住）：
 *  ① 运行结束后，`<状态目录>/agent-memory/<owner>/permission-ask-requests/` 下
 *     **存在一条**记录；
 *  ② 该记录 `status === "pending"`；
 *  ③ `operationFingerprint` 匹配 `/^sha256:[a-f0-9]{64}$/`；
 *  ④ `argumentsJson` 与假 Provider 发出的**逐字一致**（不得改写、不得截断）；
 *  ⑤ **既有裁决行为不变**：任务仍因权限询问而受阻（`permissionAsk` 或 blocked 状态），
 *     本片只"登记"、不改变裁决。
 *
 * 注：本用例**依赖 `dist/cli.js` 为最新**（初始化时已 `npm run build`），
 * 因为子进程执行的是构建产物而非源码 —— 这是本仓既有 harness 的既定前提。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-askreg-"));
  await fs.mkdir(path.join(projectPath, ".tmp"), { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

/** 假 Provider：先返回受限工具调用，工具被拦后给出完成事件（避免无限重调）。 */
function buildPermissionAskStream(argumentsJson: string): string {
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
                id: "ask-call-1",
                type: "function",
                function: { name: "createProjectFile", arguments: argumentsJson },
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

function buildCompletionStream(): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            content:
              "已完成。\nASTARRAY_TASK_COMPLETION_V1 " +
              JSON.stringify({
                taskExecutionId: "task-exec:T-001",
                completionAttemptId: "attempt-askreg",
                completedTaskIdentifiers: ["T-001"],
                claimedStatus: "complete",
                taskSequenceRevision: 1,
              }),
          },
          finish_reason: "stop",
        },
      ],
    }) +
    "\n\n" +
    "data: [DONE]\n\n"
  );
}

interface ChildRunResult {
  stdoutText: string;
  stderrTail: string;
}

async function runCliAgainstFakeProvider(input: {
  argumentsJson: string;
  standardInput: string;
}): Promise<ChildRunResult> {
  let requestIndex = 0;
  const server = http.createServer((httpRequest, response) => {
    httpRequest.on("data", () => {});
    httpRequest.on("end", () => {
      requestIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      // 首次（及前两次）请求受限工具；工具被拦后不再重调，给出完成事件。
      if (requestIndex <= 2) {
        response.write(buildPermissionAskStream(input.argumentsJson));
      } else {
        response.write(buildCompletionStream());
      }
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const endpoint =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";

  const childProcess = spawn(
    process.execPath,
    [
      cliEntryPath,
      "run",
      "创建 .tmp/ASK-REG.md",
      "--mode",
      "assist",
      "--runtime",
      "openai-compatible",
      "--provider-endpoint",
      endpoint,
      "--provider-model",
      "fake-model",
      "--provider-request-timeout-seconds",
      "20",
      "--timeout-seconds",
      "40",
      "--json",
    ],
    {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );

  let stdoutText = "";
  let stderrTail = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => {
    stdoutText += chunk;
  });
  childProcess.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });
  childProcess.stdin.end(input.standardInput);

  await new Promise<void>((resolve) => {
    let isSettled = false;
    const settle = (): void => {
      if (isSettled) return;
      isSettled = true;
      resolve();
    };
    childProcess.on("close", settle);
    const resultChecker = setInterval(() => {
      const trimmed = stdoutText.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          JSON.parse(trimmed);
        } catch {
          return;
        }
        clearInterval(resultChecker);
        if (!isSettled) {
          childProcess.kill();
          settle();
        }
      }
    }, 100);
    setTimeout(() => {
      clearInterval(resultChecker);
      if (!isSettled) childProcess.kill();
      settle();
    }, 100_000);
  });
  server.close();
  return { stdoutText, stderrTail };
}

/** 收集状态目录下所有权限询问请求实体（含其解析后的内容）。 */
async function readRegisteredRequests(): Promise<
  Array<{ filePath: string; record: Record<string, unknown> }>
> {
  const agentMemoryRoot = path.join(projectPath, ".astarray", "agent-memory");
  let ownerEntries: string[];
  try {
    ownerEntries = await fs.readdir(agentMemoryRoot);
  } catch {
    return [];
  }
  const results: Array<{ filePath: string; record: Record<string, unknown> }> = [];
  for (const ownerEntry of ownerEntries) {
    const requestDirectory = path.join(
      agentMemoryRoot,
      ownerEntry,
      "permission-ask-requests",
    );
    if (!existsSync(requestDirectory)) {
      continue;
    }
    for (const fileName of await fs.readdir(requestDirectory)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(requestDirectory, fileName);
      results.push({
        filePath,
        record: JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>,
      });
    }
  }
  return results;
}

describe("GUI-02-01 片①：CLI 路径登记权限询问请求实体", () => {
  it(
    "① 任务请求受限工具后，状态目录下出现 pending 请求实体，且参数逐字保留",
    async () => {
      const argumentsJson = JSON.stringify({
        filePath: ".tmp/ASK-REG.md",
        content: "# ASK-REG\n",
      });

      const { stdoutText, stderrTail } = await runCliAgainstFakeProvider({
        argumentsJson,
        standardInput: "deny\n",
      });

      const registered = await readRegisteredRequests();
      expect(
        registered.length,
        "应恰好登记一条请求实体。stdout=" +
          stdoutText.slice(0, 600) +
          " stderr尾=" +
          stderrTail.slice(-800),
      ).toBe(1);

      const record = registered[0]!.record;
      expect(record["status"]).toBe("pending");
      expect(String(record["operationFingerprint"])).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(
        record["argumentsJson"],
        "本地权威参数必须与 Provider 发出的逐字一致（不得改写、不得截断）",
      ).toBe(argumentsJson);
      expect(record["toolName"]).toBe("createProjectFile");
      expect(record["requestRevision"]).toBe(1);
      expect(String(record["ownerAgentInstanceId"]).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "② 登记不改变既有裁决行为：拒绝后不得留下产物，且任务不报 done",
    async () => {
      const argumentsJson = JSON.stringify({
        filePath: ".tmp/ASK-REG-2.md",
        content: "# ASK-REG-2\n",
      });

      const { stdoutText } = await runCliAgainstFakeProvider({
        argumentsJson,
        standardInput: "deny\n",
      });

      // 既有行为：未授权 ⇒ 任务保持受阻（blocked），不得虚报 done。
      const parsed = (() => {
        try {
          return JSON.parse(stdoutText.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      expect(parsed).not.toBeNull();
      expect(parsed?.["status"]).not.toBe("done");
      // 产物不得存在（拒绝授权 ⇒ 工具未真正执行）
      expect(existsSync(path.join(projectPath, ".tmp/ASK-REG-2.md"))).toBe(false);
    },
    120_000,
  );
});
