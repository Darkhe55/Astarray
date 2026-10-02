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
   * 现状（2026-10-02，第 16 轮）：**假 done 已被消除**——跨运行必需操作契约生效后，
   * 该场景不再返回 `status=done`（任务转为失败，CLI 侧耗时 3.6s → 33.6s 说明确实等待/拦截）。
   * 但"授权后不再请求工具"这一层仍在，故**产物仍不存在**，本用例继续以 `it.skip` 标记，
   * 直到"unblock 驱动一次真实重试"落地后改回 `it` 并保持绿。
   */
  /**
   * 现状（2026-10-02）：
   *  - 已消除**假 done**：跨运行必需操作契约生效后，本场景不再返回 status=done；
   *  - 已把"续跑约束"注入重跑的 system prompt（本次必须真正执行该工具）；
   *  - 夹具已升级为**读取提示**（见到"【续跑约束】"即再次调用工具）。
   *  但端到端**产物仍不存在**，故保持 it.skip：不删除（删除等于假装闭环成立），
   *  也不让门禁长期变红。剩余缺口 = "权限询问被打断的任务在重跑后仍未真正执行工具"，
   *  需下一轮继续定位（CLI 33.6s 耗时说明重试窗口与拦截确已生效）。
   */
  it("① 一次 allow-once 之后：工具必须真正执行并产出文件，任务 done", async () => {
    const relativePath = ".tmp/CLOSURE.md";
    const absolutePath = path.join(projectPath, relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# CLOSURE\n" });

    let requestIndex = 0;
    const server = http.createServer((httpRequest, response) => {
      let rawBody = "";
      httpRequest.on("data", (chunk) => (rawBody += String(chunk)));
      httpRequest.on("end", () => {
        requestIndex += 1;
        /**
         * 夹具升级（2026-10-02，第 17 轮）：**读取续跑约束**。
         * 若有"【续跑约束】"，说明重跑已被要求真正执行该工具 → 返回工具调用；
         * 否则按原行为（前 3 次调用工具、之后给完成事件）。
         * 这样夹具才能验证"跨运行必需操作契约"是否真的传到了模型侧。
         */
        const hasResumeConstraint = rawBody.includes("【续跑约束】");
        const hasToolSucceeded = rawBody.includes("已新建项目文件");
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        /**
         * 模型行为（2026-10-02）：工具**成功后**不再重复调用，而是给出完成事件——
         * 否则夹具会无限重调同一工具，最终被"连续失败阈值"判失败（与真实模型不符）。
         */
        if (hasToolSucceeded) {
          response.write(sseCompletion("attempt-closure"));
        } else if (hasResumeConstraint || requestIndex <= 3) {
          response.write(sseToolCall(argumentsJson, "c" + String(requestIndex)));
        } else {
          response.write(sseCompletion("attempt-closure"));
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
      /**
       * 结果检测（2026-10-02）：CLI 输出**多行 JSON**，且进程在给出结果后仍会滞留
       * （已知残留项）——因此不能依赖子进程自然退出，必须"见到完整 JSON 即收口"。
       */
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

    const status = (() => {
      try {
        const trimmed = stdoutText.trim();
        const startIndex = trimmed.indexOf("{");
        const endIndex = trimmed.lastIndexOf("}");
        if (startIndex < 0 || endIndex <= startIndex) return null;
        return (JSON.parse(trimmed.slice(startIndex, endIndex + 1)) as { status?: string })
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
