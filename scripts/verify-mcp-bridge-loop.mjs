#!/usr/bin/env node
/**
 * BRIDGE-01-04 验证脚本：以真实 stdio MCP 客户端对 **安装产物** 的桥接做闭环。
 *
 * 用法：node scripts/verify-mcp-bridge-loop.mjs [<安装后的 dist/cli.js 路径>]
 * 缺省使用仓库 dist/cli.js；建议传入隔离安装目录内的
 * node_modules/astarray/dist/cli.js，以验证"从 tarball 安装的 bridge"。
 *
 * 覆盖：initialize 协议协商、tools/list 最小工具面、submit/query/read-result/cancel
 * 闭环与幂等键、业务级失败（isError）与协议级失败（-32700/-32601/未知方法）、
 * 禁止的本地写/执行工具拒绝、stdout 仅含合法 MCP 消息、断连即会话收口。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntryPath =
  process.argv[2] ?? path.join(repositoryRootDirectory, "dist", "cli.js");
const verificationDirectoryPath = path.join(
  repositoryRootDirectory,
  ".tmp",
  "mcp-bridge-loop",
  randomUUID(),
);
mkdirSync(verificationDirectoryPath, { recursive: true });

const EXPECTED_TOOL_NAMES = ["cancel_task", "query_task", "read_result", "submit_task"];
const FORBIDDEN_LOCAL_TOOL_NAMES = ["shell", "runCommand", "writeFileTemporary"];
const REQUEST_TIMEOUT_MILLISECONDS = 20_000;

const checkResults = [];
function recordCheck(checkName, isPassed, detail) {
  checkResults.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
}

const childProcess = spawn(process.execPath, [cliEntryPath, "mcp", "serve"], {
  cwd: verificationDirectoryPath,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const receivedMessages = [];
const invalidStdoutLines = [];
let stdoutBuffer = "";
let stderrText = "";

childProcess.stdout.setEncoding("utf8");
childProcess.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line !== "") {
      try {
        const parsedMessage = JSON.parse(line);
        if (
          parsedMessage === null ||
          typeof parsedMessage !== "object" ||
          parsedMessage.jsonrpc !== "2.0"
        ) {
          invalidStdoutLines.push(line);
        }
        receivedMessages.push(parsedMessage);
      } catch {
        invalidStdoutLines.push(line);
      }
    }
    newlineIndex = stdoutBuffer.indexOf("\n");
  }
});
childProcess.stderr.setEncoding("utf8");
childProcess.stderr.on("data", (chunk) => {
  stderrText += chunk;
});

function waitForMessage(description, predicate) {
  return new Promise((resolve, reject) => {
    const deadlineMilliseconds = Date.now() + REQUEST_TIMEOUT_MILLISECONDS;
    const checkForMessage = () => {
      const matchedMessage = receivedMessages.find(predicate);
      if (matchedMessage !== undefined) {
        resolve(matchedMessage);
        return;
      }
      if (Date.now() > deadlineMilliseconds) {
        reject(new Error(`等待消息超时（${description}）；stderr=${stderrText.slice(0, 400)}`));
        return;
      }
      setTimeout(checkForMessage, 20);
    };
    checkForMessage();
  });
}

let requestCounter = 0;
async function sendRequest(method, params) {
  requestCounter += 1;
  const requestIdentifier = `verify-${requestCounter}`;
  childProcess.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: requestIdentifier, method, params })}\n`,
  );
  return waitForMessage(
    `${method} 响应`,
    (message) =>
      message.id === requestIdentifier &&
      (message.result !== undefined || message.error !== undefined),
  );
}

function sendNotification(method, params) {
  childProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function callTool(toolName, toolArguments) {
  return sendRequest("tools/call", { name: toolName, arguments: toolArguments });
}

try {
  const initializeResponse = await sendRequest("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "astarray-verify-mcp-bridge-loop", version: "1.0.0" },
  });
  recordCheck(
    "initialize 返回协议版本与 tools 能力",
    initializeResponse.result?.protocolVersion === "2026-07-28" &&
      initializeResponse.result?.capabilities?.tools !== undefined,
    JSON.stringify(initializeResponse.result ?? initializeResponse.error),
  );
  sendNotification("notifications/initialized", {});

  const listResponse = await sendRequest("tools/list", {});
  const listedToolNames = (listResponse.result?.tools ?? [])
    .map((toolDefinition) => toolDefinition.name)
    .sort();
  recordCheck(
    "tools/list 只暴露四个桥接工具",
    JSON.stringify(listedToolNames) === JSON.stringify(EXPECTED_TOOL_NAMES),
    JSON.stringify(listedToolNames),
  );
  recordCheck(
    "tools/list 不暴露禁止的本地写/执行工具",
    FORBIDDEN_LOCAL_TOOL_NAMES.every((name) => !listedToolNames.includes(name)),
    listedToolNames.join(","),
  );

  const idempotencyKey = `verify-mcp-loop-${randomUUID()}`;
  const submitResponse = await callTool("submit_task", {
    prompt: "只回答：1+1=?",
    idempotencyKey,
  });
  const submittedTaskIdentifier = submitResponse.result?.structuredContent?.taskIdentifier;
  recordCheck(
    "submit_task 返回受理回执（含 taskIdentifier 与 missionIdentifier）",
    submitResponse.result?.isError === false &&
      typeof submittedTaskIdentifier === "string" &&
      submittedTaskIdentifier !== "" &&
      typeof submitResponse.result?.structuredContent?.missionIdentifier === "string",
    JSON.stringify(submitResponse.result?.structuredContent ?? submitResponse.error),
  );

  const repeatedSubmitResponse = await callTool("submit_task", {
    prompt: "只回答：1+1=?",
    idempotencyKey,
  });
  recordCheck(
    "同主体同幂等键重复提交返回同一任务",
    repeatedSubmitResponse.result?.structuredContent?.taskIdentifier ===
      submittedTaskIdentifier,
    JSON.stringify(repeatedSubmitResponse.result?.structuredContent ?? null),
  );

  const queryResponse = await callTool("query_task", {
    taskIdentifier: submittedTaskIdentifier,
  });
  recordCheck(
    "query_task 返回本地权威状态",
    queryResponse.result?.isError === false &&
      typeof queryResponse.result?.structuredContent?.status === "string",
    JSON.stringify(queryResponse.result?.structuredContent ?? queryResponse.error),
  );

  const readResultResponse = await callTool("read_result", {
    taskIdentifier: submittedTaskIdentifier,
  });
  recordCheck(
    "read_result 返回结果字段（未完成时不得伪造结果）",
    readResultResponse.result?.isError === false &&
      typeof readResultResponse.result?.structuredContent?.isCompleted === "boolean",
    JSON.stringify(readResultResponse.result?.structuredContent ?? readResultResponse.error),
  );

  const cancelResponse = await callTool("cancel_task", {
    taskIdentifier: submittedTaskIdentifier,
  });
  recordCheck(
    "cancel_task 受理并返回本地状态",
    cancelResponse.result?.isError === false,
    JSON.stringify(cancelResponse.result?.structuredContent ?? cancelResponse.error),
  );

  const businessFailureResponse = await callTool("query_task", {
    taskIdentifier: "task-does-not-exist",
  });
  recordCheck(
    "业务级失败以 isError=true 返回（协议层不抛 JSON-RPC 错误）",
    businessFailureResponse.result?.isError === true &&
      businessFailureResponse.error === undefined,
    JSON.stringify(businessFailureResponse.result?.structuredContent ?? null),
  );

  const forbiddenToolResponse = await callTool("shell", { command: "echo hi" });
  recordCheck(
    "禁止的本地写/执行工具被桥接拒绝",
    forbiddenToolResponse.result?.isError === true,
    JSON.stringify(forbiddenToolResponse.result?.structuredContent ?? null),
  );

  childProcess.stdin.write("{ this is not json }\n");
  const parseErrorResponse = await waitForMessage(
    "JSON-RPC 解析错误",
    (message) => message.error?.code === -32700,
  );
  recordCheck(
    "非法 JSON 行返回 -32700（解析错误）",
    parseErrorResponse.error?.code === -32700,
    JSON.stringify(parseErrorResponse.error),
  );

  const unknownMethodResponse = await sendRequest("tools/unknown", {});
  recordCheck(
    "未知方法返回 -32601",
    unknownMethodResponse.error?.code === -32601,
    JSON.stringify(unknownMethodResponse.error),
  );
} catch (error) {
  recordCheck("闭环执行未抛异常", false, error instanceof Error ? error.message : String(error));
} finally {
  childProcess.stdin.end();
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      childProcess.kill("SIGKILL");
      resolve();
    }, 10_000);
    childProcess.on("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

recordCheck(
  "stdout 只含合法 MCP 消息（无日志混入）",
  invalidStdoutLines.length === 0,
  invalidStdoutLines.slice(0, 2).join(" | ") || "none",
);

const failedChecks = checkResults.filter((checkResult) => !checkResult.isPassed);
const summary = {
  cliEntryPath,
  stateDirectory: path.join(verificationDirectoryPath, ".astarray"),
  receivedMessageCount: receivedMessages.length,
  checks: checkResults,
  isPassed: failedChecks.length === 0,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failedChecks.length > 0) {
  process.stderr.write(`MCP 桥接闭环校验失败：${failedChecks.map((check) => check.checkName).join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("MCP 桥接闭环校验通过 ✓\n");
