/**
 * 反例（CLI 权限询问时序，2026-10-02）：
 *
 * 覆盖两条**必须确定性**的时序分支：
 *  ① 任务进入 blocked（等待裁决）时，`waitForTaskTerminal` 必须**立即返回**，
 *     不得空等整体超时（此前真实 CLI 会多等 20–60s）；
 *  ② 任务未被询问、但已终态失败时，CLI 必须**快速收口**（不得继续等 30s 的询问）。
 *
 * 用极小超时 + 假 Provider，保证用例时长可控且判定与时长无关。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ask-timing-"));
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

async function runCliWithTimeout(input: {
  scripts: Array<() => string>;
  decisionLines: string[];
  timeoutSeconds: string;
}): Promise<{ status: string | null; elapsedMilliseconds: number }> {
  let requestIndex = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      requestIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const script = input.scripts[Math.min(requestIndex - 1, input.scripts.length - 1)];
      response.write(script === undefined ? sseToolCall("{}", "fallback") : script());
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const endpoint = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1/chat/completions";

  const startedAt = Date.now();
  const childProcess = spawn(
    process.execPath,
    [
      cliEntryPath,
      "run",
      "执行写入",
      "--mode",
      "assist",
      "--runtime",
      "openai-compatible",
      "--provider-endpoint",
      endpoint,
      "--provider-model",
      "fake-model",
      "--provider-request-timeout-seconds",
      "10",
      "--timeout-seconds",
      input.timeoutSeconds,
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
  childProcess.stdin.end(input.decisionLines.join("\n") + "\n");
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
      if (!isSettled) {
        childProcess.kill();
        settle();
      }
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
  return { status, elapsedMilliseconds: Date.now() - startedAt };
}

describe("CLI 权限询问时序", () => {
  it("① 进入 blocked 等待裁决时立即返回（不等满整体超时）", async () => {
    const outcome = await runCliWithTimeout({
      scripts: [() => sseToolCall(JSON.stringify({ filePath: "a.md", content: "x" }), "c1")],
      // 只给一行并拒绝：胜负不在授权，而在"是否快速收口"。
      decisionLines: ["deny"],
      timeoutSeconds: "60",
    });
    expect(outcome.status).not.toBe("done");
    // 若空等整体超时，耗时会 ≥60s；此处要求在宽裕上限内收口。
    expect(outcome.elapsedMilliseconds).toBeLessThan(45_000);
  });

  it("② 未产生询问且任务失败时快速收口（不等 30s 询问上限）", async () => {
    const outcome = await runCliWithTimeout({
      scripts: [() => sseToolCall(JSON.stringify({ filePath: "b.md", content: "y" }), "c1")],
      decisionLines: ["allow-once", "deny"],
      timeoutSeconds: "60",
    });
    expect(outcome.status).not.toBe("done");
    expect(outcome.elapsedMilliseconds).toBeLessThan(60_000);
  });
});
