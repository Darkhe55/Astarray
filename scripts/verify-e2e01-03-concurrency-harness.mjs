#!/usr/bin/env node
/**
 * E2E-01-03 基础 harness：**安装包产品路径**下的"陈旧写入被拒绝且人工修改保留"。
 *
 * 为什么需要它：S1 已把 T05D 的陈旧写入守卫接进产品工具路径，并在**工具层**用
 * `executeBuiltinTool` 验证过；但这条链路此前从未在**tarball 隔离安装 + CLI 入口**
 * 下跑过——而那正是本项目反复出现的缺口类型（模块有测试、产品路径没验证）。
 *
 * 机制（关键设计）：harness 自带**进程内** OpenAI 兼容假 Provider，因此能
 * **确定性地**把"人工修改"插进"Agent 已读、尚未写"的窗口：
 *   请求 #1 → 回放 `readFile`（Agent 由此建立读时基线）
 *   请求 #2 → **先**把人工内容写进目标文件，**再**回放 `replaceFileContent`
 *   请求 #3+ → 回放完成控制事件（工具已由本地循环真实执行）
 * 全部离线、零额度、不需要用户参与；真实 Provider 版本见后续切片 S3。
 *
 * 用法：
 *   node scripts/verify-e2e01-03-concurrency-harness.mjs --allow-live-request --permission-decision allow-once
 *   # --run-prepack        连 prepack 一起跑（默认 --ignore-scripts，保证 tarball 可复现）
 *   # --keep-run-directory 保留运行目录便于人工核查
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHumanEditWindowProxy } from "./lib/human-edit-window-proxy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutableName = process.platform === "win32" ? "npm.cmd" : "npm";

/** Windows 上必须用 `node <npm-cli.js>` 调用 npm（`.cmd` 直接 spawn 会 EINVAL，shell 模式会破坏含冒号路径）。 */
const npmCliPath = (() => {
  try {
    const lookupOutput = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["npm"],
      { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const candidateLine of lookupOutput.split(/\r?\n/)) {
      const candidate = candidateLine.trim();
      if (candidate === "") continue;
      const cliCandidate = path.join(path.dirname(candidate), "node_modules", "npm", "bin", "npm-cli.js");
      if (existsSync(cliCandidate)) return cliCandidate;
    }
  } catch {
    // 退回 shell 模式
  }
  return null;
})();

function runNpmSync(npmArguments, options) {
  if (npmCliPath !== null) {
    return execFileSync(process.execPath, [npmCliPath, ...npmArguments], options);
  }
  return execFileSync(npmExecutableName, npmArguments, {
    ...options,
    shell: process.platform === "win32",
  });
}

const argumentsList = process.argv.slice(2);
function takeArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

const isLiveAllowed = argumentsList.includes("--allow-live-request");
const permissionDecision = takeArgument("--permission-decision", null);
if (permissionDecision !== null && permissionDecision !== "allow-once" && permissionDecision !== "deny") {
  fail(`--permission-decision 必须是 allow-once 或 deny（收到: ${permissionDecision}）`, 2);
}
if (!isLiveAllowed) {
  fail("拒绝执行：本脚本会真实调用本地/真实 Provider。确认后追加 --allow-live-request。", 2);
}
if (process.stdin.isTTY !== true && permissionDecision === null) {
  fail(
    "拒绝执行：非交互环境必须显式给出 --permission-decision allow-once（裁决来源会写入判据文件）。",
    2,
  );
}

function fail(message, exitCode = 1) {
  console.error("E2E-01-03 harness 失败: " + message);
  process.exit(exitCode);
}

const modelIdentifier = takeArgument("--model", "e2e01-03-fake-model");
/**
 * 运行模式：默认 `devolve`（放权）。
 *
 * 实测教训（2026-10-07）：`assist` 模式下 `replaceFileContent` 被**权限策略直接拒绝**
 * （回填 `错误(tool-permission-denied)`），工具**根本没走到陈旧写入守卫**——
 * 那样"人工修改被保留"会因为"压根没写"而假通过。要验证守卫必须用允许写的模式。
 */
const runMode = takeArgument("--mode", "devolve");
const fakeApiKeyEnvironmentVariableName = "ASTARRAY_E2E01_03_FAKE_KEY";
const targetFileName = "TARGET.txt";
const initialContent = "初始内容（Agent 读到的是这份）\n";
const humanContent = "人工修改（必须逐字节保留）\n";
const agentContent = "Agent 想写入的内容（不得落盘）\n";

/**
 * 真实 Provider 模式（2026-10-08）：给出 `--live-provider-endpoint` 即启用。
 *
 * 真实端点下无法拦截响应，而模型"读完立刻写"的窗口只有 1 秒级——故改用
 * `scripts/lib/human-edit-window-proxy.mjs` 做**纯透传代理**：扣住含
 * `replaceFileContent` 的那次响应，直到检测到目标文件被人工编辑才放行。
 * 默认（不给该参数）时行为与既有假 Provider 路径完全一致。
 */
const liveProviderEndpoint = takeArgument("--live-provider-endpoint", null);
const isLiveProviderRun = liveProviderEndpoint !== null;
const humanEditDeadlineSeconds = Number.parseInt(
  takeArgument("--human-edit-deadline-seconds", "300"),
  10,
);
const liveCredentialSource = takeArgument("--credential-source", "state");
const liveCredentialReferenceId = takeArgument("--credential-reference-id", "prov-unisound-1");
/**
 * 协议标签：真实端点下的必填信息——`anthropic-messages` 与 `openai-compatible` 的
 * 请求/响应形态不同（system 顶层、tool_result 走 user 消息等），必须显式传给 CLI。
 */
const protocolLabel = takeArgument("--protocol-label", "openai-compatible");
if (protocolLabel !== "openai-compatible" && protocolLabel !== "anthropic-messages") {
  fail(`--protocol-label 必须是 openai-compatible 或 anthropic-messages（收到: ${protocolLabel}）`, 2);
}
const liveApiKeyEnvironmentVariableName = "ASTARRAY_PROVIDER_API_KEY";
let detectedHumanContent = null;

/**
 * 真实模式下的密钥解析（只读；**不打印、不落盘**）。
 * `env` 表示由调用方自己把密钥放进 `ASTARRAY_PROVIDER_API_KEY`。
 */
function resolveLiveApiKey() {
  if (liveCredentialSource === "env") {
    const providedKey = process.env[liveApiKeyEnvironmentVariableName];
    if (providedKey === undefined || providedKey === "") {
      fail("--credential-source env 要求环境变量 " + liveApiKeyEnvironmentVariableName + " 已设置", 2);
    }
    return providedKey;
  }
  const credentialsFilePath = path.join(
    repositoryRoot,
    ".astarray",
    "providers",
    "provider-credentials.json",
  );
  if (!existsSync(credentialsFilePath)) {
    fail("--credential-source state 需要受保护凭据文件存在: " + credentialsFilePath, 2);
  }
  let parsedCredentials;
  try {
    parsedCredentials = JSON.parse(readFileSync(credentialsFilePath, "utf8"));
  } catch (error) {
    fail("受保护凭据文件无法解析: " + String(error?.message ?? error), 2);
  }
  const credentialEntry = parsedCredentials?.[liveCredentialReferenceId];
  if (
    credentialEntry === undefined ||
    typeof credentialEntry.apiKey !== "string" ||
    credentialEntry.apiKey === ""
  ) {
    fail("受保护凭据文件中缺少可用条目: " + liveCredentialReferenceId, 2);
  }
  return credentialEntry.apiKey;
}

const checks = [];
function record(checkName, isPassed, detail) {
  checks.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log((isPassed ? "  ✓ " : "  ✗ ") + checkName + " — " + detail);
}

// ---------------------------------------------------------------------------
// 1) 固定来源提交 + 打包 + 隔离安装
// ---------------------------------------------------------------------------
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const runIdentifier = new Date().toISOString().replaceAll(":", "-");
const archiveRoot = path.join(repositoryRoot, ".tmp", "e2e01-03", runIdentifier);
const installRoot = path.join(archiveRoot, "install");
const projectDirectory = path.join(archiveRoot, "project");
mkdirSync(installRoot, { recursive: true });
mkdirSync(projectDirectory, { recursive: true });

console.log("=== E2E-01-03 harness（安装包路径：陈旧写入被拒绝且人工修改保留） ===");
console.log("来源提交: " + sourceCommit);
console.log("工作区状态: " + (sourceStatus === "" ? "干净（无改动）" : "有未提交改动"));
console.log("运行标识: " + runIdentifier);

const packOutputRaw = runNpmSync(
  [
    "pack",
    "--json",
    "--pack-destination",
    archiveRoot,
    ...(argumentsList.includes("--run-prepack") ? [] : ["--ignore-scripts"]),
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const packOutput = packOutputRaw.replace(/\u001B\[[0-9;]*m/g, "");
const packJsonStartIndex = packOutput.indexOf("[");
if (packJsonStartIndex < 0) {
  fail("npm pack 未返回 JSON: " + packOutput.slice(0, 200), 2);
}
const packResult = JSON.parse(packOutput.slice(packJsonStartIndex))[0];
const tarballPath = path.join(archiveRoot, packResult.filename);
const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
console.log("tarball: " + packResult.filename + "（" + String(packResult.size) + " 字节，sha256 " + tarballSha256 + "）");

runNpmSync(["init", "-y"], { cwd: installRoot, stdio: "ignore" });
runNpmSync(["install", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot, stdio: "inherit" });
const installedCliPath = path.join(installRoot, "node_modules", "astarray", "dist", "cli.js");
if (!existsSync(installedCliPath)) {
  fail("隔离安装后找不到安装包入口: " + installedCliPath, 2);
}
console.log("安装包入口: " + installedCliPath);

// ---------------------------------------------------------------------------
// 2) 项目目录 + 目标文件 + 进程内假 Provider（确定性控制"已读未写"窗口）
// ---------------------------------------------------------------------------
const targetAbsolutePath = path.join(projectDirectory, targetFileName);
writeFileSync(targetAbsolutePath, initialContent, "utf8");

let requestCount = 0;
let humanEditAppliedAtIso = null;
let humanEditInstructionAtIso = null;
let firstRequestAtIso = null;
const requestBodyTexts = [];

function writeSseToolCall(response, callId, toolName, argumentsJson) {
  response.write(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: callId, function: { name: toolName, arguments: argumentsJson } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      "\n\n",
  );
}

function writeSseCompletion(response) {
  const completionEventJson = JSON.stringify({
    taskExecutionId: "task-exec:e2e01-03",
    completionAttemptId: "attempt-e2e01-03-1",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });
  response.write(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              role: "assistant",
              content: "已完成。\nASTARRAY_TASK_COMPLETION_V1 " + completionEventJson,
            },
            finish_reason: "stop",
          },
        ],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
}

const fakeProvider = http.createServer((request, response) => {
  let rawBody = "";
  request.on("data", (chunk) => {
    rawBody += String(chunk);
  });
  request.on("end", () => {
    requestCount += 1;
    if (firstRequestAtIso === null) {
      firstRequestAtIso = new Date().toISOString();
    }
    requestBodyTexts.push(rawBody);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    if (requestCount === 1) {
      // Agent 读文件 → 建立读时基线。
      writeSseToolCall(response, "tc-read-1", "readFile", JSON.stringify({ filePath: targetFileName }));
      response.end();
      return;
    }
    if (requestCount === 2) {
      /**
       * **同步点**：先把人工修改落盘，再回放 `replaceFileContent`。
       * 这样人工改动必然落在"Agent 已读、尚未写"的窗口内（确定性，不依赖时序运气）。
       */
      writeFileSync(targetAbsolutePath, humanContent, "utf8");
      humanEditAppliedAtIso = new Date().toISOString();
      console.log("    [同步点] 已在请求 #2 回放前写入人工修改");
      writeSseToolCall(
        response,
        "tc-replace-1",
        "replaceFileContent",
        JSON.stringify({ filePath: targetFileName, content: agentContent }),
      );
      response.end();
      return;
    }
    writeSseCompletion(response);
    response.end();
  });
});

await new Promise((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
const fakeProviderPort = fakeProvider.address().port;
let providerEndpoint = "http://127.0.0.1:" + String(fakeProviderPort) + "/v1/chat/completions";
let humanEditWindowProxy = null;
if (isLiveProviderRun) {
  /**
   * 真实 Provider 模式：CLI 指向本地透传代理，代理再转发到真实端点。
   * 代理会在含 `replaceFileContent` 的响应上扣留，等待人工编辑目标文件。
   */
  humanEditWindowProxy = await startHumanEditWindowProxy({
    upstreamEndpoint: liveProviderEndpoint,
    targetFilePath: targetAbsolutePath,
    initialTargetContent: initialContent,
    humanEditDeadlineMilliseconds: humanEditDeadlineSeconds * 1_000,
    onHumanEditInstruction: (detail) => {
      humanEditInstructionAtIso = new Date().toISOString();
      /**
       * 除日志外再写一份**固定路径**的提示文件：协调时可只盯这一个路径，
       * 不必去猜带时间戳的运行目录。
       */
      const instructionFilePath = path.join(repositoryRoot, ".tmp", "e2e01-03", "HUMAN-EDIT-NOW.txt");
      writeFileSync(
        instructionFilePath,
        "请立即编辑（窗口 " +
          String(detail.deadlineMilliseconds / 1_000) +
          " 秒）：\n" +
          detail.targetFilePath +
          "\n",
        "utf8",
      );
      console.log(
        "\n>>> 需要人工编辑（窗口 " +
          String(detail.deadlineMilliseconds / 1_000) +
          " 秒）：请修改 " +
          detail.targetFilePath +
          "\n>>> 提示文件: " +
          instructionFilePath +
          "\n",
      );
    },
    onHumanEditDetected: (detail) => {
      humanEditAppliedAtIso = new Date().toISOString();
      detectedHumanContent = detail.detectedContent;
      console.log(">>> 已检测到人工编辑，放行被扣留的响应\n");
    },
  });
  providerEndpoint = humanEditWindowProxy.endpoint;
  console.log("真实端点: " + liveProviderEndpoint);
  console.log("透传代理端点: " + providerEndpoint + "（真实密钥由 harness 注入 CLI 环境变量）");
} else {
  console.log("假 Provider 端点: " + providerEndpoint);
}

// ---------------------------------------------------------------------------
// 3) 经安装包 CLI 运行（assist 模式；非交互裁决经 stdin 喂一次）
// ---------------------------------------------------------------------------
const taskPrompt = [
  "只读约束与范围：本次任务只允许改动 " + targetFileName + " 一个文件，不要执行 shell 命令。",
  "",
  "请按两步完成：",
  "1. 先用内置工具 readFile 读取 " + targetFileName + "（参数 filePath）；",
  "2. 再用内置工具 replaceFileContent 把它的内容覆盖为指定文本（参数 filePath 与 content）。",
  "以工具返回结果为准：返回失败就如实说明失败原因，不得声称写入成功。",
].join("\n");

const childProcess = spawn(
  process.execPath,
  [
    installedCliPath,
    "run",
    taskPrompt,
    "--mode",
    runMode,
    "--runtime",
    "openai-compatible",
    "--provider-endpoint",
    providerEndpoint,
    "--provider-model",
    modelIdentifier,
    // 协议非默认时必须显式传给 CLI（默认是 openai-compatible）。
    ...(protocolLabel === "openai-compatible" ? [] : ["--provider-protocol", protocolLabel]),
    "--provider-api-key-env",
    isLiveProviderRun ? liveApiKeyEnvironmentVariableName : fakeApiKeyEnvironmentVariableName,
    "--provider-request-timeout-seconds",
    /**
     * 真实模式下必须**大于人工编辑窗口**：否则 CLI 会在用户编辑完成前自行超时中止，
     * 窗口白开（2026-10-08 实测：窗口 600s、请求超时 60s → 60s 后任务以
     * "Provider 请求失败或超时（60000ms）" 失败，一次真实调用被浪费）。
     */
    String(isLiveProviderRun ? humanEditDeadlineSeconds + 180 : 60),
    "--timeout-seconds",
    /**
     * CLI 自身的任务等待上限也必须**大于人工编辑窗口**（2026-10-09 实测：
     * 硬编码 240s + harness 看门狗 300s 双双短于 900s 窗口 → CLI 在 300s 被强杀，
     * exit 124、②③④⑩ 失败，一次真实调用被浪费）。
     */
    String(isLiveProviderRun ? humanEditDeadlineSeconds + 180 : 240),
    "--json",
  ],
  {
    cwd: projectDirectory,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(isLiveProviderRun
        ? // 真实密钥只经环境变量注入子进程；**不打印、不落盘**。
          { [liveApiKeyEnvironmentVariableName]: resolveLiveApiKey() }
        : { [fakeApiKeyEnvironmentVariableName]: "offline-no-auth-required" }),
    },
  },
);

let stdoutText = "";
let stderrText = "";
childProcess.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
childProcess.stderr.on("data", (chunk) => (stderrText += String(chunk)));
childProcess.stdin.end((permissionDecision ?? "allow-once") + "\n");

const exitCode = await new Promise((resolve) => {
  let isSettled = false;
  const settle = (code) => {
    if (isSettled) return;
    isSettled = true;
    resolve(code);
  };
  childProcess.on("close", (code) => settle(code ?? 1));
  setTimeout(() => {
    if (!isSettled) {
      childProcess.kill();
      settle(124);
    }
  }, isLiveProviderRun ? (humanEditDeadlineSeconds + 300) * 1_000 : 300_000);
});
fakeProvider.close();

console.log("\nCLI 退出码: " + String(exitCode));
if (isLiveProviderRun && humanEditWindowProxy !== null) {
  /**
   * 真实模式下请求证据来自**透传代理**（假 Provider 未被使用，其计数器恒为 0）。
   * 不修正这一点会让判据①③永远看空数组——2026-10-08 实测踩到。
   */
  requestBodyTexts.push(...humanEditWindowProxy.getRequestBodyTexts());
  requestCount = humanEditWindowProxy.getRequestCount();
}
console.log("Provider 收到的请求数: " + String(requestCount));

/** 再跑一次安装包 CLI 的只读子命令（判据⑦⑧ 用）。 */
async function runInstalledCliReadonly(cliArguments, workingDirectory) {
  const readonlyProcess = spawn(process.execPath, [installedCliPath, ...cliArguments], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let readonlyStdout = "";
  let readonlyStderr = "";
  readonlyProcess.stdout.on("data", (chunk) => (readonlyStdout += String(chunk)));
  readonlyProcess.stderr.on("data", (chunk) => (readonlyStderr += String(chunk)));
  const readonlyExitCode = await new Promise((resolve) => {
    let isSettled = false;
    const settle = (code) => {
      if (isSettled) return;
      isSettled = true;
      resolve(code);
    };
    readonlyProcess.on("close", (code) => settle(code ?? 1));
    setTimeout(() => {
      if (!isSettled) {
        readonlyProcess.kill();
        settle(124);
      }
    }, 120_000);
  });
  return { exitCode: readonlyExitCode, stdout: readonlyStdout, stderr: readonlyStderr };
}

/** 直接跑一个 `node <script> <args...>`（不是安装包 CLI 的子命令）。 */
async function runNodeScript(scriptPath, scriptArguments, workingDirectory) {
  const scriptProcess = spawn(process.execPath, [scriptPath, ...scriptArguments], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let scriptStdout = "";
  let scriptStderr = "";
  scriptProcess.stdout.on("data", (chunk) => (scriptStdout += String(chunk)));
  scriptProcess.stderr.on("data", (chunk) => (scriptStderr += String(chunk)));
  const scriptExitCode = await new Promise((resolve) => {
    let isSettled = false;
    const settle = (code) => {
      if (isSettled) return;
      isSettled = true;
      resolve(code);
    };
    scriptProcess.on("close", (code) => settle(code ?? 1));
    setTimeout(() => {
      if (!isSettled) {
        scriptProcess.kill();
        settle(124);
      }
    }, 120_000);
  });
  return { exitCode: scriptExitCode, stdout: scriptStdout, stderr: scriptStderr };
}

function extractCliJson(text) {
  const startIndex = text.indexOf("{");
  if (startIndex < 0) return null;
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (isInsideString) {
      if (isEscaped) isEscaped = false;
      else if (character === "\\") isEscaped = true;
      else if (character === '"') isInsideString = false;
      continue;
    }
    if (character === '"') isInsideString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4) 判据
// ---------------------------------------------------------------------------
const cliJsonText = (() => {
  const startIndex = stdoutText.indexOf("{");
  if (startIndex < 0) return null;
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;
  for (let index = startIndex; index < stdoutText.length; index += 1) {
    const character = stdoutText[index];
    if (isInsideString) {
      if (isEscaped) isEscaped = false;
      else if (character === "\\") isEscaped = true;
      else if (character === '"') isInsideString = false;
      continue;
    }
    if (character === '"') isInsideString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return stdoutText.slice(startIndex, index + 1);
    }
  }
  return null;
})();
let parsedCliResult = null;
try {
  parsedCliResult = cliJsonText === null ? null : JSON.parse(cliJsonText);
} catch {
  parsedCliResult = null;
}

const finalContent = readFileSync(targetAbsolutePath, "utf8");
const secondRequestBody = requestBodyTexts[1] ?? "";
const thirdRequestBody = requestBodyTexts[2] ?? "";

/**
 * 保留原始证据（用于事后复核"到底是**本守卫**拒绝的，还是被权限门禁挡下的"）：
 * 判据③只看 CLI 回填给 Provider 的工具结果，因此必须把请求体与 CLI 输出一起落盘。
 */
writeFileSync(
  path.join(archiveRoot, "provider-requests.jsonl"),
  requestBodyTexts.map((bodyText, index) => JSON.stringify({ requestIndex: index + 1, bodyText })).join("\n") + "\n",
);
writeFileSync(path.join(archiveRoot, "cli-stdout.txt"), stdoutText, "utf8");
writeFileSync(path.join(archiveRoot, "cli-stderr.txt"), stderrText, "utf8");
console.log("原始证据: provider-requests.jsonl / cli-stdout.txt / cli-stderr.txt");

// 诊断：把回填给 Provider 的工具结果文本摘出来（判定拒绝来源）。
const toolResultSnippets = (() => {
  const snippets = [];
  for (const bodyText of requestBodyTexts) {
    for (const match of bodyText.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
      const decoded = match[1] ?? "";
      if (
        decoded.includes("stale-human-change") ||
        decoded.includes("权限") ||
        decoded.includes("错误(") ||
        decoded.includes("拒绝")
      ) {
        snippets.push(decoded.replace(/\\n/g, " ").slice(0, 220));
      }
    }
  }
  return snippets;
})();
if (toolResultSnippets.length > 0) {
  console.log("\n--- 回填给 Provider 的相关文本（诊断用）---");
  for (const snippet of [...new Set(toolResultSnippets)].slice(0, 8)) {
    console.log("    · " + snippet);
  }
}

console.log("\n--- 判据 ---");
/**
 * 真实 Provider 模式下：请求体与请求数由**透传代理**采集（模型可能发多于 3 次请求），
 * 且"人工编辑内容"由用户决定 → 相关判据改为对**全部请求体**与**检测到的内容**断言。
 */
const allRequestBodyText = requestBodyTexts.join("\n");
const hasStaleRejectionAnywhere = allRequestBodyText.includes("stale-human-change");
const hasReadFileAnywhere = allRequestBodyText.includes("readFile");
const expectedHumanContent = isLiveProviderRun ? detectedHumanContent : humanContent;
record(
  "① Agent 确实执行了两步（read 之后才有 replace）",
  isLiveProviderRun
    ? requestCount >= 2 && hasReadFileAnywhere
    : requestCount >= 3 && secondRequestBody.includes("readFile"),
  "请求数=" + String(requestCount) + "，含 readFile=" + String(hasReadFileAnywhere),
);
record(
  "② 人工修改落在「已读、尚未写」窗口内",
  isLiveProviderRun
    ? humanEditAppliedAtIso !== null &&
      humanEditInstructionAtIso !== null &&
      humanEditAppliedAtIso > humanEditInstructionAtIso &&
      (humanEditWindowProxy?.getHeldResponseCount() ?? 0) >= 1
    : humanEditAppliedAtIso !== null &&
      firstRequestAtIso !== null &&
      humanEditAppliedAtIso > firstRequestAtIso,
  isLiveProviderRun
    ? "扣留次数=" +
      String(humanEditWindowProxy?.getHeldResponseCount() ?? 0) +
      "，提示=" +
      String(humanEditInstructionAtIso) +
      "，编辑=" +
      String(humanEditAppliedAtIso)
    : "首次请求=" + String(firstRequestAtIso) + "，人工修改=" + String(humanEditAppliedAtIso),
);
record(
  "③ 陈旧写入被拒绝（错误回填给 Provider）",
  isLiveProviderRun ? hasStaleRejectionAnywhere : thirdRequestBody.includes("stale-human-change"),
  isLiveProviderRun
    ? "全部请求体中含 stale-human-change=" + String(hasStaleRejectionAnywhere)
    : "请求 #3 含 stale-human-change=" + String(thirdRequestBody.includes("stale-human-change")),
);
record(
  "④ 人工修改逐字节保留",
  expectedHumanContent !== null && finalContent === expectedHumanContent,
  JSON.stringify(finalContent),
);
record("⑤ Agent 待写内容未落盘", !finalContent.includes(agentContent.trim()), "目标文件未被覆盖为 Agent 内容");
record("⑥ 未在人工改动后仍结案为 done", parsedCliResult?.status !== "done", "status=" + String(parsedCliResult?.status));

/**
 * ⑦ 上下文预算/回访**实际执行**：产品路径在每次 Worker 装配 prompt 时会写
 * `<state>/context-runtime/events.jsonl` 的 `context-assembly` 事件（含
 * `effectiveBudgetTokens` 与 `budgetPolicyRevision`）。这里断言"确有事件"且"预算字段是真实数值"，
 * 而不是只看 CLI 有没有打印一句话。
 */
const contextEventsPath = path.join(projectDirectory, ".astarray", "context-runtime", "events.jsonl");
const contextAssemblyEvents = (() => {
  if (!existsSync(contextEventsPath)) return [];
  return readFileSync(contextEventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null && event.eventType === "context-assembly");
})();
record(
  "⑦ 上下文预算实际执行（context-assembly 事件含有效预算）",
  contextAssemblyEvents.length >= 1 &&
    contextAssemblyEvents.every(
      (event) =>
        typeof event.effectiveBudgetTokens === "number" &&
        event.effectiveBudgetTokens > 0 &&
        typeof event.budgetPolicyRevision === "number" &&
        event.budgetPolicyRevision >= 1 &&
        typeof event.estimatedInjectedTokenCount === "number",
    ),
  "事件数=" +
    String(contextAssemblyEvents.length) +
    "，effectiveBudgetTokens=" +
    JSON.stringify([...new Set(contextAssemblyEvents.map((event) => event.effectiveBudgetTokens))]) +
    "，budgetPolicyRevision=" +
    JSON.stringify([...new Set(contextAssemblyEvents.map((event) => event.budgetPolicyRevision))]),
);

// CLI 持久化状态视图 + SDK 查询（验收④ 的两侧）。
const statusCommandResult = await runInstalledCliReadonly(
  ["status", String(parsedCliResult?.missionId ?? ""), "--json"],
  projectDirectory,
);
const statusCommandJson = extractCliJson(statusCommandResult.stdout);
let parsedStatusCommand = null;
try {
  parsedStatusCommand = statusCommandJson === null ? null : JSON.parse(statusCommandJson);
} catch {
  parsedStatusCommand = null;
}

// SDK 侧：用**安装包自己的**公开 SDK 查询（脚本放在 install 根目录，故 bare specifier 可解析）。
const sdkQueryScriptPath = path.join(installRoot, "query-mission-state.mjs");
writeFileSync(
  sdkQueryScriptPath,
  [
    'import { AstarrayApplicationFacade } from "astarray";',
    "const [stateDirectory, missionIdentifier] = process.argv.slice(2);",
    'const application = await AstarrayApplicationFacade.create({ stateDirectory, runtime: "mock", mode: "devolve" });',
    "const mission = await application.queryMission(missionIdentifier);",
    "console.log(JSON.stringify(mission));",
    "process.exit(0);",
  ].join("\n") + "\n",
  "utf8",
);
const sdkQueryResult = await runNodeScript(
  sdkQueryScriptPath,
  [path.join(projectDirectory, ".astarray"), String(parsedCliResult?.missionId ?? "")],
  installRoot,
);
let parsedSdkMission = null;
try {
  parsedSdkMission =
    sdkQueryResult.stdout.trim() === ""
      ? null
      : JSON.parse(sdkQueryResult.stdout.trim().split("\n").at(-1));
} catch {
  parsedSdkMission = null;
}

/**
 * ⑧ 卡内验收④："CLI/SDK 最终状态一致"。
 *
 * 口径必须是**同一件事**：CLI 的**持久化 mission 状态视图**（`status <mission> --json`）
 * 对 SDK 的 `queryMission(...)`。二者当前一致（见下）。
 *
 * ⚠️ 与之**不同**的一件事（另列为 finding，不作为本判据失败）：`run --json` 的 `status`
 * 字段报的是**本次运行的等待结果**（此处 `blocked`），而持久化 mission 状态是 `cancelled`
 * （CLI 进程收尾时取消未完成 mission）。这是 `run` 命令的状态语义问题，不是 CLI↔SDK 分歧。
 */
const cliAndSdkAgree =
  parsedStatusCommand?.status !== undefined &&
  parsedSdkMission?.status === parsedStatusCommand.status &&
  parsedSdkMission?.missionIdentifier === parsedStatusCommand?.missionId;
record(
  "⑧ CLI 持久化状态视图与 SDK 查询一致（验收④）",
  cliAndSdkAgree,
  "status=" +
    String(parsedStatusCommand?.status) +
    " / sdk=" +
    String(parsedSdkMission?.status) +
    "（missionId " +
    String(parsedStatusCommand?.missionId) +
    "）",
);

/** ⑨ 登记项（不门控本 harness）：`run --json` 的 status 与持久化 mission 状态是否同值。 */
const runStatusMatchesPersisted =
  parsedCliResult?.status !== undefined && parsedCliResult.status === parsedStatusCommand?.status;
const registeredFindings = runStatusMatchesPersisted
  ? []
  : [
      {
        findingIdentifier: "e2e01-03-run-status-vs-persisted-mission-status",
        description:
          "`run --json` 的 status 与持久化 mission 状态不同值：前者报本次运行等待结果，后者是 mission 终态。需产品裁定是否为有意语义。",
        runReportedStatus: parsedCliResult?.status ?? null,
        persistedMissionStatus: parsedStatusCommand?.status ?? null,
        sdkReportedStatus: parsedSdkMission?.status ?? null,
        persistedTaskStatus:
          Array.isArray(parsedStatusCommand?.tasks) && parsedStatusCommand.tasks.length > 0
            ? (parsedStatusCommand.tasks[0]?.status ?? null)
            : null,
      },
    ];
console.log(
  "\n--- 登记项（不门控）---\n  · " +
    (registeredFindings.length === 0
      ? "无"
      : "run 报 " +
        String(parsedCliResult?.status) +
        "，持久化 mission 报 " +
        String(parsedStatusCommand?.status) +
        "，任务节点报 " +
        String(registeredFindings[0]?.persistedTaskStatus)),
);

writeFileSync(
  path.join(archiveRoot, "cli-status-command.json"),
  JSON.stringify({ exitCode: statusCommandResult.exitCode, stderr: statusCommandResult.stderr, parsed: parsedStatusCommand }, null, 2) + "\n",
);
writeFileSync(
  path.join(archiveRoot, "sdk-query-mission.json"),
  JSON.stringify({ exitCode: sdkQueryResult.exitCode, stderr: sdkQueryResult.stderr, parsed: parsedSdkMission }, null, 2) + "\n",
);

/**
 * ⑩ 验收②的**前提**：工具调用边界真的写出了恢复检查点（S2b 接线验证）。
 *
 * 此前 `RecoveryCheckpointStore.writeCheckpoint` 只被测试调用——产品路径从不写检查点。
 * 这里断言**运行结束后磁盘上确有检查点**，且其中的工具调用状态符合边界语义：
 * 只读 `readFile` 成功 → `confirmed-success`；写类 `replaceFileContent` 被拒 →
 * `result-unknown`（保守，非幂等，禁止自动二次执行）。
 */
const recoveryCheckpointDirectory = path.join(
  projectDirectory,
  ".astarray",
  "recovery-checkpoints",
);
const recoveryCheckpointFiles = existsSync(recoveryCheckpointDirectory)
  ? readdirSync(recoveryCheckpointDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(recoveryCheckpointDirectory, name))
  : [];
const recoveryCheckpoints = recoveryCheckpointFiles
  .map((filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  })
  .filter((checkpoint) => checkpoint !== null);
const latestCheckpoint = recoveryCheckpoints.at(-1) ?? null;
const checkpointToolCalls = Array.isArray(latestCheckpoint?.toolCalls)
  ? latestCheckpoint.toolCalls
  : [];
const readToolCall = checkpointToolCalls.find((call) => call.toolName === "readFile");
const writeToolCall = checkpointToolCalls.find(
  (call) => call.toolName === "replaceFileContent",
);
record(
  "⑩ 工具调用边界真的写出了恢复检查点（验收②前提）",
  recoveryCheckpoints.length >= 1 &&
    readToolCall?.state === "confirmed-success" &&
    (writeToolCall?.state === "result-unknown" || writeToolCall?.state === "confirmed-failure") &&
    writeToolCall?.isIdempotent === false,
  "检查点数=" +
    String(recoveryCheckpoints.length) +
    "，readFile=" +
    String(readToolCall?.state) +
    "，replaceFileContent=" +
    String(writeToolCall?.state) +
    "（isIdempotent=" +
    String(writeToolCall?.isIdempotent) +
    "）",
);

const failedChecks = checks.filter((check) => !check.isPassed);
if (humanEditWindowProxy !== null) {
  await humanEditWindowProxy.close();
}
const verdict = {
  schemaVersion: 1,
  checkIdentifier: "e2e01-03-stale-write-preserves-human-edit",
  verdict: failedChecks.length > 0 ? "failed" : "passed",
  isFakeProvider: !isLiveProviderRun,
  isRealAcceptanceEvidence:
    isLiveProviderRun &&
    failedChecks.length === 0 &&
    (humanEditWindowProxy?.wasHumanEditDetected() ?? false),
  isRealAcceptanceEvidence: false,
  sourceCommit,
  sourceStatus,
  tarballSha256,
  tarballSizeBytes: packResult.size,
  installedCliPath,
  modelIdentifier,
  providerEndpoint,
  permissionDecisionSource: permissionDecision === null ? "interactive-tty" : "explicit-flag",
  recordedAtIso: new Date().toISOString(),
  cliExitCode: exitCode,
  fakeProviderRequestCount: requestCount,
  liveProviderEndpoint: isLiveProviderRun ? liveProviderEndpoint : null,
  credentialReferenceId: isLiveProviderRun ? liveCredentialReferenceId : null,
  humanEditDetected: humanEditWindowProxy?.wasHumanEditDetected() ?? false,
  heldResponseCount: humanEditWindowProxy?.getHeldResponseCount() ?? 0,
  detectedHumanContent,
  cliReportedStatus: parsedCliResult?.status ?? null,
  persistedMissionStatus: parsedStatusCommand?.status ?? null,
  sdkReportedMissionStatus: parsedSdkMission?.status ?? null,
  registeredFindings,
  checks,
  failedCheckNames: failedChecks.map((check) => check.checkName),
};
const verdictPath = path.join(archiveRoot, "acceptance-verdict.json");
writeFileSync(verdictPath, JSON.stringify(verdict, null, 2) + "\n");
console.log("\n判据记录文件: " + verdictPath);

if (failedChecks.length > 0) {
  console.error("\nharness 未通过（" + String(failedChecks.length) + " 项失败）:");
  for (const failedCheck of failedChecks) {
    console.error("  - " + failedCheck.checkName + ": " + failedCheck.detail);
  }
  if (stderrText.trim() !== "") {
    console.error("\nCLI stderr 末尾:\n" + stderrText.trim().split("\n").slice(-8).join("\n"));
  }
  process.exit(1);
}
console.log("\nE2E-01-03 S1b：安装包路径下陈旧写入被拒绝且人工修改保留 ✓（假 Provider，非真实验收）");
