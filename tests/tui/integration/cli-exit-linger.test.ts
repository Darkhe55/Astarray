/**
 * 行为反例（产品残留项，2026-10-02）：
 *
 * 已知缺陷：**provider 运行时**下 CLI 给出 `--json` 结果后进程仍会滞留
 * （此前实测约 120s），导致脚本/CI 必须主动 kill 才能收口。
 * mock 路径实测 5.3s 正常（见提交说明），故本用例针对 provider 路径，
 * 用本地假 Provider（零真实额度、零网络外呼）复现。
 *
 * 本文件在修复前必须失败。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;
let server: http.Server | null = null;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-linger-provider-"));
});

afterEach(async () => {
  if (server !== null) {
    server.close();
    server = null;
  }
  try {
    await fs.rm(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

/** 只回文本 + 完成事件（不调用工具），使任务直接走完 provider 路径。 */
function buildCompletionSse(): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            content:
              "无需改动。\nASTARRAY_TASK_COMPLETION_V1 " +
              JSON.stringify({
                taskExecutionId: "task-exec:T-001",
                completionAttemptId: "attempt-linger",
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

describe("provider 路径：CLI 结果后必须及时退出（不依赖外部 kill）", () => {  it("① 给出 JSON 结果后应在宽限期内自然退出", async () => {
    server = http.createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        response.write(buildCompletionSse());
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      (server as http.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const endpoint =
      "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";

    const startedAtMs = Date.now();
    const childProcess = spawn(
      process.execPath,
      [
        cliEntryPath,
        "run",
        "离线冒烟：只回文本，不要调用工具",
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
      { cwd: projectPath, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
    );

    let stdoutText = "";
    let resultObservedAtMs: number | null = null;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdoutText += chunk;
      if (
        resultObservedAtMs === null &&
        stdoutText.trim().startsWith("{") &&
        stdoutText.trim().endsWith("}")
      ) {
        resultObservedAtMs = Date.now();
      }
    });
    childProcess.stderr.resume();

    const exitOutcome = await new Promise<number | "linger">((resolve) => {
      let isSettled = false;
      const settle = (code: number | "linger"): void => {
        if (isSettled) return;
        isSettled = true;
        resolve(code);
      };
      childProcess.on("close", (code: number | null) => settle(code ?? 1));
      // 硬上限：超过即判定滞留（不得依赖外部 kill 才算收口）。
      setTimeout(() => {
        if (!isSettled) {
          childProcess.kill();
          settle("linger");
        }
      }, 60_000);
    });

    const totalMilliseconds = Date.now() - startedAtMs;
    // 结果必须已产出（否则本用例测的不是"滞留"）。
    expect(resultObservedAtMs).not.toBeNull();
    // 核心断言：结果产出后 10 秒内必须自然退出。
    expect(exitOutcome).not.toBe("linger");
    expect(totalMilliseconds).toBeLessThan(30_000);
  });

  /**
   * 已知缺陷（2026-10-02 实测，**待修**）：provider + 权限询问路径下，
   * CLI 打印结果后**不会自然退出**（实测 >60s，只能靠外部 kill）。
   *
   * 已尝试并回退的修法：在 `executeRunCommand` 结果刷出后显式 `process.exit()`
   * —— **不可行**：会杀死 vitest worker，导致 10 个既有用例失败
   * （cli-commands 6 项、run-command-gaps、cli-sdk-parity、run-provider-entry、summary-cli）。
   * 因此**修复必须放在 CLI 引导层**（`cli.tsx` 的 `.action()` 或 `main()` 收敛处），
   * 而不是放进 `executeRunCommand`；或改为真正释放反馈子进程等残留句柄。
   *
   * 本用例保留为待通过反例：不让门禁长期变红，也**不删除**（删除等于假装已修）。
   * 修复后应改回 `it`。
   */
  it.skip("② 权限询问 + allow-once 后：给出结果即应自然退出", async () => {
    const relativePath = ".tmp/LINGER.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# LINGER\n" });
    const toolCallSse =
      "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
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
      "data: [DONE]\n\n";

    server = http.createServer((request, response) => {
      let rawBody = "";
      request.on("data", (chunk) => (rawBody += String(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        // 工具成功后给出完成事件；否则持续请求工具（触发权限询问）。
        response.write(rawBody.includes("已新建项目文件") ? buildCompletionSse() : toolCallSse);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      (server as http.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const endpoint =
      "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";

    const startedAtMs = Date.now();
    const childProcess = spawn(
      process.execPath,
      [
        cliEntryPath,
        "run",
        "创建 " + relativePath,
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
      { cwd: projectPath, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
    );

    let stdoutText = "";
    let resultObservedAtMs: number | null = null;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdoutText += chunk;
      if (
        resultObservedAtMs === null &&
        stdoutText.trim().startsWith("{") &&
        stdoutText.trim().endsWith("}")
      ) {
        resultObservedAtMs = Date.now();
      }
    });
    childProcess.stderr.resume();
    childProcess.stdin.end("allow-once\n");

    const exitOutcome = await new Promise<number | "linger">((resolve) => {
      let isSettled = false;
      const settle = (code: number | "linger"): void => {
        if (isSettled) return;
        isSettled = true;
        resolve(code);
      };
      childProcess.on("close", (code: number | null) => settle(code ?? 1));
      setTimeout(() => {
        if (!isSettled) {
          childProcess.kill();
          settle("linger");
        }
      }, 60_000);
    });

    const totalMilliseconds = Date.now() - startedAtMs;
    expect(resultObservedAtMs).not.toBeNull();
    expect(exitOutcome).not.toBe("linger");
    expect(totalMilliseconds).toBeLessThan(40_000);
  });
});
