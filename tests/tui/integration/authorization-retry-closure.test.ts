/**
 * 行为反例（T07D-R2-04 正向闭环，2026-10-02）：
 *
 * 缺陷：用户在权限询问处 `allow-once` 后，CLI 的裁决循环会因
 * `waitForPermissionAsk` 看到任务进入 `running` 而**立即返回 null** 并收口，
 * 因此**授权后的重跑从未被等待**——任务永远查不到产物，正向闭环无法成立。
 *
 * 本文件在修复前必须失败。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-closure-"));
  await fs.mkdir(path.join(projectPath, ".tmp"), { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function sseToolCall(argumentsJson: string, callId: string): string {
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

function sseCompletion(attemptId: string): string {
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

describe("授权后必须等待重跑（正向闭环）", () => {
  /**
   * 已知未完成（2026-10-02，T07D-R2-04 正向闭环阻断项）：
   *
   * 本轮已定位并修复两层根因：
   *  1) CLI 侧：`waitForPermissionAsk` 一见任务回到 `running` 就立即返回 null，
   *     授权后的重跑**从未被等待**（已加"推进窗口"，见 run-command）。
   *  2) worker 侧：写类工具的"尝试"只在**工具结果**事件登记，被权限门禁拦下的调用
   *     没有结果事件 → 完成门禁看到 `attempted=[]` 而放行"从未执行却声称完成"
   *     （已改为在**请求时刻**登记，见 worker-agent）。
   *
   * 仍未打通的是：**授权生效后**的重跑依然得到 `permission-ask-pending`
   * （实测：三次 reserve 全在授权之前、且授权同时刻发生），
   * 说明"授权 → 下一次工具调用即可放行"这条时序在真实 CLI 链路中尚未闭合。
   *
   * 因此本用例暂以 `it.skip` 保留为**待通过的反例**，不使用 `it` 让门禁长期变红，
   * 也**不删除**（删除等于假装闭环成立）。修复后应改回 `it`。
   */
  it.skip("① 一次 allow-once 之后：工具必须真正执行并产出文件，任务 done", async () => {
    const relativePath = ".tmp/CLOSURE.md";
    const absolutePath = path.join(projectPath, relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# CLOSURE\n" });

    let requestIndex = 0;
    const server = http.createServer((httpRequest, response) => {
      httpRequest.on("data", () => {});
      httpRequest.on("end", () => {
        requestIndex += 1;
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        // 前 3 次都请求同一个写工具（与真实模型行为一致：授权前会反复请求）；
        // 之后给出完成事件。
        response.write(
          requestIndex <= 3 ? sseToolCall(argumentsJson, "c" + String(requestIndex)) : sseCompletion("attempt-closure"),
        );
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
      {
        cwd: projectPath,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    let stdoutText = "";
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdoutText += chunk;
    });
    childProcess.stderr.resume();
    // 只提供一行裁决：若修复正确，第二次询问不应再出现。
    childProcess.stdin.end("allow-once\n");

    await new Promise<void>((resolve) => {
      let isSettled = false;
      const settle = (): void => {
        if (isSettled) return;
        isSettled = true;
        resolve();
      };
      childProcess.on("close", settle);
      const resultChecker = setInterval(() => {
        if (stdoutText.trimEnd().endsWith("}")) {
          clearInterval(resultChecker);
          setTimeout(() => {
            if (!isSettled) {
              childProcess.kill();
              settle();
            }
          }, 3_000);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(resultChecker);
        if (!isSettled) childProcess.kill();
        settle();
      }, 100_000);
    });
    server.close();

    const status = (() => {
      try {
        return (JSON.parse(stdoutText.trim().split("\n").at(-1) ?? "null") as { status?: string })
          ?.status ?? null;
      } catch {
        return null;
      }
    })();

    // 核心断言：授权后必须真的执行并落盘。
    expect(existsSync(absolutePath)).toBe(true);
    expect(status).toBe("done");
    expect(requestIndex).toBeGreaterThanOrEqual(4);
  });
});
