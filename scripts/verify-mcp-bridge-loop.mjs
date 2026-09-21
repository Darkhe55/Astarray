#!/usr/bin/env node
/**
 * BRIDGE-01-04 验证脚本：以真实 stdio MCP 客户端对 **安装产物** 的桥接做闭环。
 *
 * 用法：node scripts/verify-mcp-bridge-loop.mjs [<安装后的 dist/cli.js 路径>]
 * 缺省使用仓库 dist/cli.js；建议传入隔离安装目录内的
 * node_modules/astarray/dist/cli.js，以验证"从 tarball 安装的 bridge"。
 *
 * 场景 1（最小工具面 + 闭环）：initialize 协议协商、tools/list、submit/query/
 *   read-result/cancel、幂等键重放、业务级失败与协议级失败区分、禁止的本地
 *   写/执行工具拒绝、stdout 仅含合法 MCP 消息。
 * 场景 2（主体隔离 + 断连收口）：同一状态目录下，主体 A 提交后断开；主体 B
 *   读取/取消 A 的任务一律 task-not-accessible；B 仍可提交并读取自己的任务；
 *   A 的进程在 stdin 结束后自行退出（未走 SIGKILL）。
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
const EXIT_TIMEOUT_MILLISECONDS = 10_000;

const checkResults = [];
function recordCheck(scenario, checkName, isPassed, detail) {
  checkResults.push({
    scenario,
    checkName,
    isPassed: Boolean(isPassed),
    detail: String(detail),
  });
}

/** 启动一个真实 stdio MCP 客户端连接（每个连接一个桥接会话）。 */
function createBridgeClient(principalIdentifier) {
  const childProcess = spawn(process.execPath, [cliEntryPath, "mcp", "serve"], {
    cwd: verificationDirectoryPath,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ASTARRAY_MCP_PRINCIPAL: principalIdentifier },
  });
  const receivedMessages = [];
  const invalidStdoutLines = [];
  let stderrText = "";
  let stdoutBuffer = "";
  let requestCounter = 0;
  let isKilledByScript = false;

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
          reject(
            new Error(
              `等待消息超时（${description}）；stderr=${stderrText.slice(0, 400)}`,
            ),
          );
          return;
        }
        setTimeout(checkForMessage, 20);
      };
      checkForMessage();
    });
  }

  return {
    principalIdentifier,
    receivedMessages,
    invalidStdoutLines,
    getStderrText: () => stderrText,
    async sendRequest(method, params) {
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
    },
    sendNotification(method, params) {
      childProcess.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    },
    writeRawLine(line) {
      childProcess.stdin.write(`${line}\n`);
    },
    async waitForMessage(description, predicate) {
      return waitForMessage(description, predicate);
    },
    async callTool(toolName, toolArguments) {
      return this.sendRequest("tools/call", {
        name: toolName,
        arguments: toolArguments,
      });
    },
    /** 关闭 stdin（模拟客户端断连）并等待进程自行退出。 */
    async disconnectAndWaitForExit() {
      childProcess.stdin.end();
      return new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          isKilledByScript = true;
          childProcess.kill("SIGKILL");
          resolve({ exitedOnItsOwn: false, exitCode: null });
        }, EXIT_TIMEOUT_MILLISECONDS);
        childProcess.on("close", (exitCode) => {
          clearTimeout(killTimer);
          resolve({ exitedOnItsOwn: !isKilledByScript, exitCode });
        });
      });
    },
  };
}

async function runToolSurfaceAndClosedLoopScenario() {
  const scenarioName = "最小工具面与闭环";
  const client = createBridgeClient("external-harness:stdio");
  try {
    const initializeResponse = await client.sendRequest("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "astarray-verify-mcp-bridge-loop", version: "1.0.0" },
    });
    recordCheck(
      scenarioName,
      "initialize 返回协议版本与 tools 能力",
      initializeResponse.result?.protocolVersion === "2026-07-28" &&
        initializeResponse.result?.capabilities?.tools !== undefined,
      JSON.stringify(initializeResponse.result ?? initializeResponse.error),
    );
    client.sendNotification("notifications/initialized", {});

    const listResponse = await client.sendRequest("tools/list", {});
    const listedToolNames = (listResponse.result?.tools ?? [])
      .map((toolDefinition) => toolDefinition.name)
      .sort();
    recordCheck(
      scenarioName,
      "tools/list 只暴露四个桥接工具",
      JSON.stringify(listedToolNames) === JSON.stringify(EXPECTED_TOOL_NAMES),
      JSON.stringify(listedToolNames),
    );
    recordCheck(
      scenarioName,
      "tools/list 不暴露禁止的本地写/执行工具",
      FORBIDDEN_LOCAL_TOOL_NAMES.every((name) => !listedToolNames.includes(name)),
      listedToolNames.join(","),
    );

    const idempotencyKey = `verify-mcp-loop-${randomUUID()}`;
    const submitResponse = await client.callTool("submit_task", {
      prompt: "只回答：1+1=?",
      idempotencyKey,
    });
    const submittedTaskIdentifier =
      submitResponse.result?.structuredContent?.taskIdentifier;
    recordCheck(
      scenarioName,
      "submit_task 返回受理回执（含 taskIdentifier 与 missionIdentifier）",
      submitResponse.result?.isError === false &&
        typeof submittedTaskIdentifier === "string" &&
        submittedTaskIdentifier !== "" &&
        typeof submitResponse.result?.structuredContent?.missionIdentifier === "string",
      JSON.stringify(submitResponse.result?.structuredContent ?? submitResponse.error),
    );

    const repeatedSubmitResponse = await client.callTool("submit_task", {
      prompt: "只回答：1+1=?",
      idempotencyKey,
    });
    recordCheck(
      scenarioName,
      "同主体同幂等键重复提交返回同一任务",
      repeatedSubmitResponse.result?.structuredContent?.taskIdentifier ===
        submittedTaskIdentifier,
      JSON.stringify(repeatedSubmitResponse.result?.structuredContent ?? null),
    );

    const queryResponse = await client.callTool("query_task", {
      taskIdentifier: submittedTaskIdentifier,
    });
    recordCheck(
      scenarioName,
      "query_task 返回本地权威状态",
      queryResponse.result?.isError === false &&
        typeof queryResponse.result?.structuredContent?.status === "string",
      JSON.stringify(queryResponse.result?.structuredContent ?? queryResponse.error),
    );

    const readResultResponse = await client.callTool("read_result", {
      taskIdentifier: submittedTaskIdentifier,
    });
    recordCheck(
      scenarioName,
      "read_result 返回结果字段（未完成时不得伪造结果）",
      readResultResponse.result?.isError === false &&
        typeof readResultResponse.result?.structuredContent?.isCompleted === "boolean",
      JSON.stringify(
        readResultResponse.result?.structuredContent ?? readResultResponse.error,
      ),
    );

    const cancelResponse = await client.callTool("cancel_task", {
      taskIdentifier: submittedTaskIdentifier,
    });
    recordCheck(
      scenarioName,
      "cancel_task 受理并返回本地状态",
      cancelResponse.result?.isError === false,
      JSON.stringify(cancelResponse.result?.structuredContent ?? cancelResponse.error),
    );

    const businessFailureResponse = await client.callTool("query_task", {
      taskIdentifier: "task-does-not-exist",
    });
    recordCheck(
      scenarioName,
      "业务级失败以 isError=true 返回（协议层不抛 JSON-RPC 错误）",
      businessFailureResponse.result?.isError === true &&
        businessFailureResponse.error === undefined,
      JSON.stringify(businessFailureResponse.result?.structuredContent ?? null),
    );

    const forbiddenToolResponse = await client.callTool("shell", { command: "echo hi" });
    recordCheck(
      scenarioName,
      "禁止的本地写/执行工具被桥接拒绝",
      forbiddenToolResponse.result?.isError === true,
      JSON.stringify(forbiddenToolResponse.result?.structuredContent ?? null),
    );

    client.writeRawLine("{ this is not json }");
    const parseErrorResponse = await client.waitForMessage(
      "JSON-RPC 解析错误",
      (message) => message.error?.code === -32700,
    );
    recordCheck(
      scenarioName,
      "非法 JSON 行返回 -32700（解析错误）",
      parseErrorResponse.error?.code === -32700,
      JSON.stringify(parseErrorResponse.error),
    );

    const unknownMethodResponse = await client.sendRequest("tools/unknown", {});
    recordCheck(
      scenarioName,
      "未知方法返回 -32601",
      unknownMethodResponse.error?.code === -32601,
      JSON.stringify(unknownMethodResponse.error),
    );

    recordCheck(
      scenarioName,
      "stdout 只含合法 MCP 消息（无日志混入）",
      client.invalidStdoutLines.length === 0,
      client.invalidStdoutLines.slice(0, 2).join(" | ") || "none",
    );
  } catch (error) {
    recordCheck(
      scenarioName,
      "闭环执行未抛异常",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  return client;
}

async function runPrincipalIsolationAndDisconnectScenario() {
  const scenarioName = "主体隔离与断连收口";
  const principalAClient = createBridgeClient("external-harness:verify-a");
  const principalBClient = createBridgeClient("external-harness:verify-b");
  try {
    await principalAClient.sendRequest("initialize", { protocolVersion: "2026-07-28" });
    const submitByA = await principalAClient.callTool("submit_task", {
      prompt: "主体 A 的任务",
      idempotencyKey: `verify-isolation-${randomUUID()}`,
    });
    const taskIdentifierByA = submitByA.result?.structuredContent?.taskIdentifier;
    recordCheck(
      scenarioName,
      "主体 A 提交成功并取得任务标识",
      submitByA.result?.isError === false && typeof taskIdentifierByA === "string",
      JSON.stringify(submitByA.result?.structuredContent ?? submitByA.error),
    );

    const exitResult = await principalAClient.disconnectAndWaitForExit();
    recordCheck(
      scenarioName,
      "A 断连（stdin 结束）后进程自行退出，未走 SIGKILL",
      exitResult.exitedOnItsOwn === true,
      JSON.stringify(exitResult),
    );

    await principalBClient.sendRequest("initialize", { protocolVersion: "2026-07-28" });
    const queryByB = await principalBClient.callTool("query_task", {
      taskIdentifier: taskIdentifierByA,
    });
    recordCheck(
      scenarioName,
      "不同主体读取 A 的任务一律 task-not-accessible（业务级失败）",
      queryByB.result?.isError === true &&
        queryByB.result?.structuredContent?.errorCode === "task-not-accessible" &&
        queryByB.error === undefined,
      JSON.stringify(queryByB.result?.structuredContent ?? queryByB.error),
    );

    const readByB = await principalBClient.callTool("read_result", {
      taskIdentifier: taskIdentifierByA,
    });
    recordCheck(
      scenarioName,
      "不同主体读取 A 的任务结果同样被拒绝",
      readByB.result?.isError === true &&
        readByB.result?.structuredContent?.errorCode === "task-not-accessible",
      JSON.stringify(readByB.result?.structuredContent ?? readByB.error),
    );

    const cancelByB = await principalBClient.callTool("cancel_task", {
      taskIdentifier: taskIdentifierByA,
    });
    recordCheck(
      scenarioName,
      "不同主体不得取消 A 的任务",
      cancelByB.result?.isError === true &&
        cancelByB.result?.structuredContent?.errorCode === "task-not-accessible",
      JSON.stringify(cancelByB.result?.structuredContent ?? cancelByB.error),
    );

    const submitByB = await principalBClient.callTool("submit_task", {
      prompt: "主体 B 的任务",
      idempotencyKey: `verify-isolation-b-${randomUUID()}`,
    });
    const taskIdentifierByB = submitByB.result?.structuredContent?.taskIdentifier;
    const queryOwnTaskByB = await principalBClient.callTool("query_task", {
      taskIdentifier: taskIdentifierByB,
    });
    recordCheck(
      scenarioName,
      "隔离不误伤：B 可提交并读取自己的任务",
      submitByB.result?.isError === false &&
        typeof taskIdentifierByB === "string" &&
        queryOwnTaskByB.result?.isError === false,
      JSON.stringify(queryOwnTaskByB.result?.structuredContent ?? queryOwnTaskByB.error),
    );

    recordCheck(
      scenarioName,
      "stdout 只含合法 MCP 消息（两个主体连接）",
      principalAClient.invalidStdoutLines.length === 0 &&
        principalBClient.invalidStdoutLines.length === 0,
      JSON.stringify({
        a: principalAClient.invalidStdoutLines,
        b: principalBClient.invalidStdoutLines,
      }),
    );
  } catch (error) {
    recordCheck(
      scenarioName,
      "隔离场景执行未抛异常",
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await principalBClient.disconnectAndWaitForExit();
  }
}

const firstClient = await runToolSurfaceAndClosedLoopScenario();
await firstClient.disconnectAndWaitForExit();
await runPrincipalIsolationAndDisconnectScenario();

const failedChecks = checkResults.filter((checkResult) => !checkResult.isPassed);
const summary = {
  cliEntryPath,
  stateDirectory: path.join(verificationDirectoryPath, ".astarray"),
  scenarioCount: new Set(checkResults.map((checkResult) => checkResult.scenario)).size,
  checkCount: checkResults.length,
  checks: checkResults,
  isPassed: failedChecks.length === 0,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failedChecks.length > 0) {
  process.stderr.write(
    `MCP 桥接闭环校验失败：${failedChecks.map((check) => check.checkName).join("; ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("MCP 桥接闭环校验通过 ✓\n");
