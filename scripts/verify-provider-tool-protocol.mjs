#!/usr/bin/env node
/**
 * 真实 Provider 工具循环协议验收（离线，不消耗真实额度）。
 *
 * 背景（2026-10-01 实测发现）：工具循环曾把工具结果回填为 `role: "function"`，
 * 真实 OpenAI 兼容端点（stepfun `step-3.7-flash`）以
 * `400 {"error":{"message":"invalid msg role: function"}}` 拒绝第二个请求，
 * 导致**任何涉及工具调用**的任务在真实 Provider 上一次都跑不通。
 *
 * 本脚本用本地拦截代理驱动一次完整的工具循环，断言运行时实际发出的续发请求
 * 符合 OpenAI Chat Completions 规范：
 *   1. assistant 消息携带 `tool_calls`（id/type/function.name/function.arguments）；
 *   2. 工具结果消息 `role="tool"` 且 `tool_call_id` 与 assistant 的调用一一对应；
 *   3. **不得**出现 `role="function"`；
 *   4. body 里保留 tools 声明与 tool_choice。
 *
 * 用法：node scripts/verify-provider-tool-protocol.mjs [--cli-entry <dist/cli.js>]
 *   缺省 --cli-entry 为仓库 dist/cli.js；执行前请先 `npm run build`。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
const cliEntryArgumentIndex = argumentsList.indexOf("--cli-entry");
const cliEntryPath =
  cliEntryArgumentIndex >= 0
    ? path.resolve(argumentsList[cliEntryArgumentIndex + 1])
    : path.join(repositoryRoot, "dist", "cli.js");

const workRoot = path.join(repositoryRoot, ".tmp", "provider-tool-protocol");
mkdirSync(workRoot, { recursive: true });
const captureFilePath = path.join(workRoot, "second-request.json");

const CHECKS = [];
function recordCheck(checkName, isPassed, detail) {
  CHECKS.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log(`${isPassed ? "  ✓" : "  ✗"} ${checkName} — ${detail}`);
}

const completionMarker =
  'ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"task-exec:protocol","completionAttemptId":"attempt-protocol-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":1}';

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const chunk of chunks) {
    response.write("data: " + JSON.stringify(chunk) + "\n\n");
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

let requestIndex = 0;
const server = http.createServer((request, response) => {
  let bodyText = "";
  request.on("data", (chunk) => {
    bodyText += String(chunk);
  });
  request.on("end", () => {
    requestIndex += 1;
    if (requestIndex === 1) {
      // 第 1 轮：驱动一次工具调用，迫使运行时发出续发请求。
      writeSse(response, [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_protocol_1",
                    type: "function",
                    function: {
                      name: "createProjectFile",
                      arguments: JSON.stringify({
                        filePath: "tasks/PROBE-PROTOCOL.md",
                        content: "# 协议验收探针\n",
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return;
    }
    writeFileSync(captureFilePath, bodyText, "utf8");
    writeSse(response, [
      {
        choices: [
          {
            delta: { role: "assistant", content: "协议验收完成。\n" + completionMarker },
            finish_reason: "stop",
          },
        ],
      },
    ]);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const endpoint = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";

const childProcess = spawn(
  process.execPath,
  [
    cliEntryPath,
    "run",
    "创建 tasks/PROBE-PROTOCOL.md（协议验收探针）",
    "--mode",
    "assist",
    "--runtime",
    "openai-compatible",
    "--provider-endpoint",
    endpoint,
    "--provider-model",
    "protocol-probe-model",
    "--timeout-seconds",
    "90",
    "--json",
  ],
  {
    cwd: workRoot,
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
childProcess.stdin.end();
await new Promise((resolve) => {
  const killTimer = setTimeout(() => {
    childProcess.kill();
  }, 120_000);
  childProcess.on("close", () => {
    clearTimeout(killTimer);
    resolve();
  });
});
await new Promise((resolve) => server.close(() => resolve()));

let secondRequest = null;
try {
  secondRequest = JSON.parse(readFileSync(captureFilePath, "utf8"));
} catch {
  secondRequest = null;
}
if (secondRequest === null) {
  console.error("未能捕获工具循环的续发请求（第 1 轮可能失败）");
  console.error("CLI stderr: " + stderrText.trim());
  process.exit(1);
}

const messages = Array.isArray(secondRequest.messages) ? secondRequest.messages : [];
const assistantMessage = messages.find((message) => message.role === "assistant");
const toolMessages = messages.filter((message) => message.role === "tool");
const legacyFunctionMessages = messages.filter((message) => message.role === "function");

recordCheck(
  "续发请求含 assistant.tool_calls",
  assistantMessage !== undefined &&
    Array.isArray(assistantMessage.tool_calls) &&
    assistantMessage.tool_calls.length > 0 &&
    assistantMessage.tool_calls[0]?.type === "function" &&
    typeof assistantMessage.tool_calls[0]?.function?.name === "string",
  assistantMessage === undefined ? "缺少 assistant 消息" : "tool_calls 结构正确",
);
recordCheck(
  "工具结果消息为 role=tool 且 tool_call_id 一一对应",
  toolMessages.length > 0 &&
    toolMessages.every(
      (message) =>
        typeof message.tool_call_id === "string" &&
        (assistantMessage?.tool_calls ?? []).some((call) => call.id === message.tool_call_id),
    ),
  `role=tool 数量 ${toolMessages.length}`,
);
recordCheck(
  "不得出现 role=function（真实端点会 400）",
  legacyFunctionMessages.length === 0,
  legacyFunctionMessages.length === 0 ? "无遗留形态" : `出现 ${legacyFunctionMessages.length} 条`,
);
recordCheck(
  "保留 tools 声明与 tool_choice",
  Array.isArray(secondRequest.tools) &&
    secondRequest.tools.length > 0 &&
    secondRequest.tool_choice === "auto",
  `tools=${Array.isArray(secondRequest.tools) ? secondRequest.tools.length : "n/a"}`,
);
recordCheck(
  "消息顺序为 system → user → assistant → tool",
  messages.map((message) => message.role).join(",") === "system,user,assistant,tool",
  messages.map((message) => message.role).join(","),
);

const failedChecks = CHECKS.filter((check) => !check.isPassed);
if (failedChecks.length > 0) {
  console.error("\n真实 Provider 工具循环协议验收失败:");
  for (const failedCheck of failedChecks) {
    console.error(`  - ${failedCheck.checkName}: ${failedCheck.detail}`);
  }
  process.exit(1);
}
console.log("\n真实 Provider 工具循环协议验收通过（离线，未消耗真实额度）✓");
