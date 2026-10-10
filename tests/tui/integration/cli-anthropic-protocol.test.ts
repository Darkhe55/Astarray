/**
 * CLI 端到端：`--provider-protocol anthropic-messages`（2026-10-02，多协议装配）。
 *
 * 用本地假 Anthropic Messages 服务器（零真实额度）验证完整链路：
 *   协议头（x-api-key / anthropic-version）→ SSE 解析 → 工具调用 →
 *   权限询问 → allow-once → 工具执行 → 完成事件 → `status=done` + 产物落盘。
 *
 * 这在 `--provider-protocol` 与 Anthropic runtime 装配之前必然失败（未知选项/协议不支持）。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let projectPath: string;
let server: http.Server | null = null;

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-anthropic-cli-"));
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

function sse(event: unknown): string {
  return "event: message\ndata: " + JSON.stringify(event) + "\n\n";
}

describe("CLI 端到端：anthropic-messages 协议", () => {
  /**
   * 2026-10-10 结案（本用例由 `it.skip` 改回 `it` 并转绿）。
   *
   * 真实根因有两层，都在**装配顺序**上（`ScopeGatedToolPort(PolicyWrapper(...))`：范围门禁外、权限引擎内）：
   *
   * 1. **范围授权被"从未执行的拒绝"永久烧掉**——
   *    范围门禁先授权并消费该操作的范围记录，紧接着内层权限引擎判 `ask` 抛
   *    `permission-ask-pending`（工具从未执行）。结算走 "确定无副作用" 的释放路径时，
   *    只恢复了"逻辑操作授权快照"（范围裁决路径下它本就是空的），**范围记录仍停在已消费**，
   *    因此重跑恒得 `auth-scope-replay-rejected`（实测请求序列：permission-ask-pending →
   *    replay-rejected × 6 + 任务 blocked），用户 `allow-once` 也无法让工具真正执行。
   *    修复：把本次消费的范围记录指纹挂到预留上，并在"确定无副作用"的释放路径恢复它
   *    （`packages/core/src/tools/scope-authorization-gate.ts`；成功后仍停在已消费，
   *    重放保护不放宽）。
   * 2. **父目录不存在导致工具失败**——需求是"创建 .tmp/ANTHROPIC.md"，而 `.tmp/` 尚不存在时
   *    `createProjectFile` 以 `wx` 直接打开目标文件 → `ENOENT`，授权后仍失败。
   *    修复：工具自行补建父目录后仍以 `wx` 排他创建（"仅新建、不覆盖"语义不变）。
   *
   * 诊断纪律（本次有效）：交接文档记录的"谁先消费了 stdin"假设被 **STDIN-TRACE 实测证伪**
   * （`data len=11 value="allow-once\n"` 正常到达）。定位靠的是在门禁状态变更点打序号痕迹，
   * 而不是继续推测读取器。
   *
   * 协议层本身自始就是通的（请求确实走 Anthropic 运行时、顶层 `system`、工具用 `input_schema`、
   * 回填为 `assistant.tool_use` + `user.tool_result`），本用例同时守住这份协议契约。
   */
  it("① 工具调用 → 权限询问 → allow-once → 产物落盘且 status=done", async () => {
    const relativePath = ".tmp/ANTHROPIC.md";
    const absolutePath = path.join(projectPath, relativePath);
    const fileContent = "# ANTHROPIC\n";
    const toolUseArguments = JSON.stringify({ filePath: relativePath, content: fileContent });

    const toolUseStream =
      sse({ type: "message_start" }) +
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "createProjectFile" },
      }) +
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: toolUseArguments },
      }) +
      sse({ type: "content_block_stop", index: 0 }) +
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
      sse({ type: "message_stop" });

    const completionStream =
      sse({ type: "message_start" }) +
      sse({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text:
            "已完成。\nASTARRAY_TASK_COMPLETION_V1 " +
            JSON.stringify({
              taskExecutionId: "task-exec:T-001",
              completionAttemptId: "attempt-anthropic-1",
              completedTaskIdentifiers: ["T-001"],
              claimedStatus: "complete",
              taskSequenceRevision: 1,
            }),
        },
      }) +
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      sse({ type: "message_stop" });

    const capturedRequests: Array<{ headers: http.IncomingHttpHeaders; bodyText: string }> = [];
    server = http.createServer((request, response) => {
      let rawBody = "";
      request.on("data", (chunk) => (rawBody += String(chunk)));
      request.on("end", () => {
        capturedRequests.push({ headers: request.headers, bodyText: rawBody });
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        // 工具成功后给完成事件；否则持续请求工具（触发权限询问）。
        // 成功判据：最近一次 tool_result 不含错误标记（不猜成功文案）。
        const toolResultTexts = [];
        try {
          const parsedBody = JSON.parse(rawBody);
          for (const message of parsedBody.messages ?? []) {
            if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block !== null && typeof block === "object" && block.type === "tool_result") {
                  toolResultTexts.push(typeof block.content === "string" ? block.content : "");
                }
              }
            }
          }
        } catch {
          // 保持 fail-closed 语义：解析失败视为未成功
        }
        const latestToolResult = toolResultTexts[toolResultTexts.length - 1] ?? "";
        const hasToolSucceeded =
          latestToolResult.trim() !== "" && !latestToolResult.includes("错误(");
        response.write(hasToolSucceeded ? completionStream : toolUseStream);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      (server as http.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const endpoint = "http://127.0.0.1:" + String(port) + "/anthropic/v1/messages";

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
        "--provider-protocol",
        "anthropic-messages",
        "--provider-endpoint",
        endpoint,
        "--provider-model",
        "u2-flash",
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
        env: { ...process.env, NO_COLOR: "1", ASTARRAY_PROVIDER_API_KEY: "test-key" },
      },
    );

    let stdoutText = "";
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdoutText += chunk;
    });
    childProcess.stderr.resume();
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
        if (stdoutText.trim().startsWith("{") && stdoutText.trim().endsWith("}")) {
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
      }, 60_000);
    });

    const parsedResult = JSON.parse(stdoutText.trim()) as { status?: string; permissionAsk?: string };
    expect(parsedResult.status).toBe("done");
    expect(parsedResult.permissionAsk).toBe("allowed-once");
    expect(existsSync(absolutePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(fileContent);

    // 协议契约：x-api-key + anthropic-version；请求体含顶层 system、max_tokens、input_schema。
    expect(capturedRequests.length).toBeGreaterThan(0);
    const firstRequest = capturedRequests[0] as { headers: http.IncomingHttpHeaders; bodyText: string };
    expect(firstRequest.headers["x-api-key"]).toBe("test-key");
    expect(firstRequest.headers["anthropic-version"]).toBe("2023-06-01");
    const firstBody = JSON.parse(firstRequest.bodyText) as Record<string, unknown>;
    expect(typeof firstBody["system"]).toBe("string");
    expect(typeof firstBody["max_tokens"]).toBe("number");
    const tools = firstBody["tools"] as Array<Record<string, unknown>>;
    expect(tools.some((tool) => tool["input_schema"] !== undefined)).toBe(true);
  });
});
