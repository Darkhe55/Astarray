/**
 * 公开 CLI 反例（产物缺失 / 错目录 / 未执行却声称完成），2026-10-02 用户指定阻断项：
 *
 * 这三条必须**红→绿**：
 *  ① 写工具**从未成功执行**（被门禁拦下）却声称完成 → 不得 `done`（当前为缺陷：会 done）；
 *  ② 本 AGENT 声明写入成功但**目标路径无产物** → 不得 `done`；
 *  ③ 完成事件声明的产物**在别处存在、目标目录内不存在** → 不得 `done`。
 *
 * 全部走**公开 CLI**（真实子进程 + 假 Provider，零真实额度）。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实 CLI 子进程 + 编排，放宽预算（不改变断言）。
vi.setConfig({ testTimeout: 120_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-artifact-cli-"));
  await fs.mkdir(path.join(projectPath, ".tmp", "fixture"), { recursive: true });
});

afterEach(async () => {
  // Windows 下子进程句柄可能稍晚释放：清理失败不得让用例失败。
  try {
    await fs.rm(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // 忽略清理失败（临时目录由系统回收）
  }
});

function sseTool(toolName: string, argumentsJson: string, callId: string): string {
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

function sseCompletion(attemptId: string, declaredArtifacts?: string[]): string {
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
                completionAttemptId: attemptId,
                completedTaskIdentifiers: ["T-001"],
                claimedStatus: "complete",
                taskSequenceRevision: 1,
                ...(declaredArtifacts === undefined ? {} : { declaredArtifacts }),
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

/** 假 Provider：固定返回写工具调用（策略由调用方决定）。 */
async function startProvider(
  scripts: Array<() => string>,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  let requestIndex = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      requestIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const script = scripts[Math.min(requestIndex - 1, scripts.length - 1)];
      response.write(script === undefined ? sseCompletion("attempt-fallback") : script());
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return {
    endpoint: "http://127.0.0.1:" + address.port + "/v1/chat/completions",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runCli(input: {
  endpoint: string;
  prompt: string;
  decisionLines: string[];
}): Promise<{ exitCode: number | null; status: string | null; stderrText: string }> {
  const childProcess = spawn(
    process.execPath,
    [
      cliEntryPath,
      "run",
      input.prompt,
      "--mode",
      "assist",
      "--runtime",
      "openai-compatible",
      "--provider-endpoint",
      input.endpoint,
      "--provider-model",
      "fake-model",
      "--provider-request-timeout-seconds",
      "30",
      "--timeout-seconds",
      "8",
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
  let stderrText = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk) => {
    stdoutText += chunk;
  });
  childProcess.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });
  childProcess.stdin.end(input.decisionLines.join("\n") + "\n");
  /**
   * 本用例只判定**运行结果**：stdout 出现完整 JSON（`}` 结尾）即视为收口完成。
   * 进程可能因残留句柄多存活（已记录为独立缺陷），此处 5s 宽限后主动终止，
   * 避免把用例时长绑在那个缺陷上（判定不受影响）。
   */
  const exitCode = await new Promise<number | null>((resolve) => {
    let isSettled = false;
    const settle = (code: number | null): void => {
      if (isSettled) return;
      isSettled = true;
      resolve(code);
    };
    const resultChecker = setInterval(() => {
      if (stdoutText.trimEnd().endsWith("}")) {
        clearInterval(resultChecker);
        setTimeout(() => {
          if (!isSettled) {
            childProcess.kill();
            settle(childProcess.exitCode ?? 0);
          }
        }, 5_000);
      }
    }, 100);
    childProcess.on("close", (code) => {
      clearInterval(resultChecker);
      settle(code);
    });
    setTimeout(() => {
      clearInterval(resultChecker);
      if (!isSettled) {
        childProcess.kill();
        settle(null);
      }
    }, 90_000);
  });
  const status = (() => {
    try {
      return (JSON.parse(stdoutText.trim().split("\n").at(-1) ?? "null") as { status?: string })
        ?.status ?? null;
    } catch {
      return null;
    }
  })();
  return { exitCode, status, stderrText };
}

describe("公开 CLI：产物缺失 / 未执行却声称完成", () => {
  it("① 写工具从未成功执行（门禁拦下）却声称完成 → 不得 done", async () => {
    const relativePath = ".tmp/fixture/NEVER-EXECUTED.md";
    const provider = await startProvider([
      // 第 1 次：请求写工具（会被权限门禁拦下，工具不执行）。
      () =>
        sseTool(
          "createProjectFile",
          JSON.stringify({ filePath: relativePath, content: "# X\n" }),
          "call-1",
        ),
      // 第 2 次（unblock 后）：直接声称完成，且不声明任何产物。
      () => sseCompletion("attempt-never-executed"),
    ]);
    try {
      const outcome = await runCli({
        endpoint: provider.endpoint,
        prompt: "创建 " + relativePath,
        decisionLines: ["allow-once"],
      });
      expect(existsSync(path.join(projectPath, relativePath))).toBe(false);
      expect(outcome.status).not.toBe("done");
    } finally {
      await provider.close();
    }
  });

  it("② 声称完成但目标路径无产物 → 不得 done", async () => {
    const relativePath = ".tmp/fixture/NO-ARTIFACT.md";
    const provider = await startProvider([
      () =>
        sseTool(
          "createProjectFile",
          JSON.stringify({ filePath: relativePath, content: "# Y\n" }),
          "call-1",
        ),
      () => sseCompletion("attempt-no-artifact", [relativePath]),
    ]);
    try {
      const outcome = await runCli({
        endpoint: provider.endpoint,
        prompt: "创建 " + relativePath,
        decisionLines: ["allow-once"],
      });
      expect(existsSync(path.join(projectPath, relativePath))).toBe(false);
      expect(outcome.status).not.toBe("done");
    } finally {
      await provider.close();
    }
  });

  it("③ 声明的产物只存在于别处 → 目标目录内不存在时不得 done", async () => {
    const relativePath = ".tmp/fixture/WRONG-DIR.md";
    // 在另一个目录放一个同名文件：不得因此被判定为产物存在。
    await fs.mkdir(path.join(projectPath, "elsewhere"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "elsewhere", "WRONG-DIR.md"), "# Z\n", "utf8");
    const provider = await startProvider([
      () =>
        sseTool(
          "createProjectFile",
          JSON.stringify({ filePath: relativePath, content: "# Z\n" }),
          "call-1",
        ),
      () => sseCompletion("attempt-wrong-dir", [relativePath]),
    ]);
    try {
      const outcome = await runCli({
        endpoint: provider.endpoint,
        prompt: "创建 " + relativePath,
        decisionLines: ["allow-once"],
      });
      expect(existsSync(path.join(projectPath, relativePath))).toBe(false);
      expect(outcome.status).not.toBe("done");
    } finally {
      await provider.close();
    }
  });
});
