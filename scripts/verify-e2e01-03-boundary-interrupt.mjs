#!/usr/bin/env node
/**
 * E2E-01-03 边界中断场景：**工具调用边界处进程崩溃后，产品仍能看到可信检查点**。
 *
 * 这是卡内验收②"工具调用边界中断后恢复无重复副作用"的**前提**证据：
 *  - 在本会话之前，产品路径**从不写检查点**（`RecoveryCheckpointStore.writeCheckpoint`
 *    只被测试调用），因此崩溃后什么都对不了账；
 *  - S2b 接线后，工具边界会落检查点。本脚本让 CLI 在**工具调用已开始**时被强杀，
 *    再用**安装包自己的公开 SDK**查询恢复视图，断言该 mission 仍有可信检查点、
 *    且处于"需要裁决"而不是"可直接重放"。
 *
 * 设计要点（避免竞态导致的假结论）：假 Provider 在回放一次写类工具调用后**不再响应**，
 * 使 CLI 停在边界附近；harness 轮询检查点目录，一旦看到该工具调用的记录就立刻
 * 杀掉子进程。**无论杀掉时状态是 `started` 还是 `confirmed-success`，断言都成立**：
 * 前者要求恢复不得自动重放，后者要求复用已确认结果——两者都禁止重复副作用。
 *
 * 用法：
 *   node scripts/verify-e2e01-03-boundary-interrupt.mjs --allow-live-request --permission-decision allow-once --mode devolve
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutableName = process.platform === "win32" ? "npm.cmd" : "npm";

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

function fail(message, exitCode = 1) {
  console.error("E2E-01-03 边界中断场景失败: " + message);
  process.exit(exitCode);
}

const argumentsList = process.argv.slice(2);
function takeArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

if (!argumentsList.includes("--allow-live-request")) {
  fail("拒绝执行：本脚本会启动 CLI 并在工具边界强杀它。确认后追加 --allow-live-request。", 2);
}
const runMode = takeArgument("--mode", "devolve");
const modelIdentifier = takeArgument("--model", "e2e01-03-interrupt-model");
const fakeApiKeyEnvironmentVariableName = "ASTARRAY_E2E01_03_INTERRUPT_KEY";
const targetFileName = "TARGET.txt";

/**
 * 真实 Provider 模式（2026-10-09）：给出 `--live-provider-endpoint` 即启用。
 *
 * 与 concurrency harness 不同，**本场景不需要人工编辑窗口**（它要的是"在工具边界强杀"），
 * 因此**不使用扣留代理**——直接指向真实端点纯透传，靠轮询检查点决定强杀时机。
 * 默认（不给该参数）仍走进程内假 Provider。
 */
const liveProviderEndpoint = takeArgument("--live-provider-endpoint", null);
const isLiveProviderRun = liveProviderEndpoint !== null;
const liveCredentialSource = takeArgument("--credential-source", "state");
const liveCredentialReferenceId = takeArgument("--credential-reference-id", "prov-live-1");
const liveApiKeyEnvironmentVariableName = "ASTARRAY_PROVIDER_API_KEY";
const protocolLabel = takeArgument("--protocol-label", "openai-compatible");

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
  const parsedCredentials = JSON.parse(readFileSync(credentialsFilePath, "utf8"));
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

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const runIdentifier = new Date().toISOString().replaceAll(":", "-");
const archiveRoot = path.join(repositoryRoot, ".tmp", "e2e01-03-interrupt", runIdentifier);
const installRoot = path.join(archiveRoot, "install");
const projectDirectory = path.join(archiveRoot, "project");
mkdirSync(installRoot, { recursive: true });
mkdirSync(projectDirectory, { recursive: true });

console.log("=== E2E-01-03 边界中断场景（安装包路径） ===");
console.log("来源提交: " + sourceCommit + "；工作区: " + (sourceStatus === "" ? "干净" : "有未提交改动"));
console.log("运行标识: " + runIdentifier);

const packOutputRaw = runNpmSync(
  ["pack", "--json", "--pack-destination", archiveRoot, "--ignore-scripts"],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const packOutput = packOutputRaw.replace(/\u001B\[[0-9;]*m/g, "");
const packJsonStartIndex = packOutput.indexOf("[");
if (packJsonStartIndex < 0) fail("npm pack 未返回 JSON", 2);
const packResult = JSON.parse(packOutput.slice(packJsonStartIndex))[0];
const tarballPath = path.join(archiveRoot, packResult.filename);
const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
runNpmSync(["init", "-y"], { cwd: installRoot, stdio: "ignore" });
runNpmSync(["install", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot, stdio: "inherit" });
const installedCliPath = path.join(installRoot, "node_modules", "astarray", "dist", "cli.js");
if (!existsSync(installedCliPath)) fail("隔离安装后找不到安装包入口", 2);
console.log("tarball: " + packResult.filename + "（sha256 " + tarballSha256 + "）");

const targetAbsolutePath = path.join(projectDirectory, targetFileName);
const originalContent = "原始内容（中断前）\n";
writeFileSync(targetAbsolutePath, originalContent, "utf8");

// ---------------------------------------------------------------------------
// 假 Provider：回放一次写类工具调用后**不再响应**，让 CLI 停在边界附近。
// ---------------------------------------------------------------------------
let requestCount = 0;
const fakeProvider = http.createServer((request, response) => {
  let rawBody = "";
  request.on("data", (chunk) => (rawBody += String(chunk)));
  request.on("end", () => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    if (requestCount === 1) {
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc-interrupt-1",
                      function: {
                        name: "replaceFileContent",
                        arguments: JSON.stringify({
                          filePath: targetFileName,
                          content: "Agent 写入（中断场景）\n",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) +
          "\n\n",
      );
      response.end();
      return;
    }
    // 故意不结束响应：让 CLI 在边界之后停滞，便于强杀。
  });
});
await new Promise((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
const providerEndpoint = isLiveProviderRun
  ? liveProviderEndpoint
  : "http://127.0.0.1:" + String(fakeProvider.address().port) + "/v1/chat/completions";

/** 待写入内容必须**逐字**给出：真实模型不会自行编造 content（否则拒绝执行）。 */
const agentInterruptContent = "Agent 写入（中断场景）\n";
const taskPrompt = [
  "只读约束与范围：本次任务只允许改动 " + targetFileName + " 一个文件，不要执行 shell 命令。",
  "请**真正调用**内置工具 replaceFileContent 覆盖 " + targetFileName + "（参数 filePath 与 content）。",
  "content 参数逐字使用下面这段文本，不要改写：",
  "",
  "----- 替换文本开始 -----",
  agentInterruptContent.trimEnd(),
  "----- 替换文本结束 -----",
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
    protocolLabel,
    "--provider-endpoint",
    providerEndpoint,
    "--provider-model",
    modelIdentifier,
    ...(protocolLabel === "openai-compatible" ? [] : ["--provider-protocol", protocolLabel]),
    "--provider-api-key-env",
    isLiveProviderRun ? liveApiKeyEnvironmentVariableName : fakeApiKeyEnvironmentVariableName,
    "--provider-request-timeout-seconds",
    "60",
    "--timeout-seconds",
    "180",
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
childProcess.stdout.resume();
childProcess.stderr.resume();
childProcess.stdin.end("allow-once\n");

// ---------------------------------------------------------------------------
// 轮询检查点：一旦看到写类工具调用的记录，立即强杀（模拟边界崩溃）。
// ---------------------------------------------------------------------------
const checkpointDirectory = path.join(projectDirectory, ".astarray", "recovery-checkpoints");
function readCheckpoints() {
  if (!existsSync(checkpointDirectory)) return [];
  return readdirSync(checkpointDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(path.join(checkpointDirectory, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((checkpoint) => checkpoint !== null);
}

let observedToolCallState = null;
let killedAfterMilliseconds = null;
const killStartedAt = Date.now();
while (Date.now() - killStartedAt < 20_000) {
  const checkpoints = readCheckpoints();
  const writeCall = checkpoints
    .flatMap((checkpoint) => (Array.isArray(checkpoint.toolCalls) ? checkpoint.toolCalls : []))
    .find((call) => call.toolName === "replaceFileContent");
  if (writeCall !== undefined) {
    observedToolCallState = writeCall.state;
    killedAfterMilliseconds = Date.now() - killStartedAt;
    childProcess.kill();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 15));
}
if (observedToolCallState === null) {
  childProcess.kill();
}
console.log(
  "强杀时机: " +
    (killedAfterMilliseconds === null ? "未在窗口内观察到边界记录" : String(killedAfterMilliseconds) + " ms") +
    "；观察到的工具调用状态: " + String(observedToolCallState),
);
/**
 * 注意：假 Provider **保持监听**直到恢复尝试结束。
 * 否则"恢复没有重放"可能只是因为 Provider 不在、重放必然失败——那是假证据。
 */

// ---------------------------------------------------------------------------
// 用**安装包自己的公开 SDK**查询恢复视图：崩溃后是否仍有可信检查点、是否需要裁决。
// ---------------------------------------------------------------------------
const sdkQueryScriptPath = path.join(installRoot, "query-recovery-overview.mjs");
writeFileSync(
  sdkQueryScriptPath,
  [
    'import { AstarrayApplicationFacade } from "astarray";',
    "const [stateDirectory] = process.argv.slice(2);",
    'const application = await AstarrayApplicationFacade.create({ stateDirectory, runtime: "mock", mode: "devolve" });',
    "const overview = await application.queryRecoveryOverview();",
    "console.log(JSON.stringify(overview));",
    "process.exit(0);",
  ].join("\n") + "\n",
  "utf8",
);

const sdkProcess = spawn(
  process.execPath,
  [sdkQueryScriptPath, path.join(projectDirectory, ".astarray")],
  { cwd: installRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
);
let sdkStdout = "";
let sdkStderr = "";
sdkProcess.stdout.on("data", (chunk) => (sdkStdout += String(chunk)));
sdkProcess.stderr.on("data", (chunk) => (sdkStderr += String(chunk)));
const sdkExitCode = await new Promise((resolve) => {
  let isSettled = false;
  const settle = (code) => {
    if (isSettled) return;
    isSettled = true;
    resolve(code);
  };
  sdkProcess.on("close", (code) => settle(code ?? 1));
  setTimeout(() => {
    if (!isSettled) {
      sdkProcess.kill();
      settle(124);
    }
  }, 60_000);
});

let parsedOverview = null;
try {
  parsedOverview = sdkStdout.trim() === "" ? null : JSON.parse(sdkStdout.trim().split("\n").at(-1));
} catch {
  parsedOverview = null;
}
const recoveryMissions = Array.isArray(parsedOverview?.missions) ? parsedOverview.missions : [];
const missionWithTrustedCheckpoint = recoveryMissions.find(
  (mission) => mission?.hasTrustedCheckpoint === true,
);

console.log("\n--- 判据 ---");
record(
  "⑪ 工具边界确实落下了检查点（中断前已可观察）",
  observedToolCallState !== null,
  "观察到的状态=" + String(observedToolCallState),
);
record(
  "⑫ 边界状态语义正确：非幂等写类工具要么未确认（started/result-unknown）要么已确认成功",
  ["started", "result-unknown", "confirmed-success"].includes(String(observedToolCallState)),
  "状态=" + String(observedToolCallState),
);
record(
  "⑬ 崩溃后产品仍能看到**可信检查点**（此前产品路径从不写检查点）",
  missionWithTrustedCheckpoint !== undefined,
  "missions=" +
    String(recoveryMissions.length) +
    "，hasTrustedCheckpoint=" +
    String(missionWithTrustedCheckpoint?.hasTrustedCheckpoint) +
    "，status=" +
    String(missionWithTrustedCheckpoint?.status),
);
record(
  "⑭ 目标文件未出现重复副作用（内容为原始内容或单次写入）",
  readFileSync(targetAbsolutePath, "utf8") === originalContent ||
    readFileSync(targetAbsolutePath, "utf8") === "Agent 写入（中断场景）\n",
  JSON.stringify(readFileSync(targetAbsolutePath, "utf8")),
);
/**
 * ⑮ 最强判据：产品把该 mission 标为**需要裁决**（`requiresDecisionMissions`），
 * 而不是"可直接恢复/自动重放"。这正是"非幂等工具结果未知 → 禁止自动二次执行"的产品面表达。
 */
const requiresDecisionMissions = Array.isArray(parsedOverview?.requiresDecisionMissions)
  ? parsedOverview.requiresDecisionMissions
  : [];
record(
  "⑮ 产品将边界中断的 mission 标为需要裁决（不自动重放）",
  missionWithTrustedCheckpoint !== undefined &&
    requiresDecisionMissions.includes(missionWithTrustedCheckpoint.missionIdentifier),
  "requiresDecisionMissions=" + JSON.stringify(requiresDecisionMissions),
);

/**
 * ⑯⑰ 真正驱动**产品恢复路径**：`recover resume [--execute]`。
 *
 * 关键：此刻假 Provider **仍在监听**。若恢复真的重放了那个非幂等写，它必然打到
 * Provider（请求数上升）并可能改写目标文件。因此"请求数不变 + 文件内容不变"
 * 是"恢复没有重复副作用"的决定性证据，而不是"因为没有 Provider 所以跑不动"的假象。
 */
const missionIdentifier = missionWithTrustedCheckpoint?.missionIdentifier ?? null;
const requestsBeforeResume = requestCount;
const contentBeforeResume = readFileSync(targetAbsolutePath, "utf8");

async function runInstalledCliResume(cliArguments) {
  const resumeProcess = spawn(process.execPath, [installedCliPath, ...cliArguments], {
    cwd: projectDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let resumeStdout = "";
  let resumeStderr = "";
  resumeProcess.stdout.on("data", (chunk) => (resumeStdout += String(chunk)));
  resumeProcess.stderr.on("data", (chunk) => (resumeStderr += String(chunk)));
  const resumeExitCode = await new Promise((resolve) => {
    let isSettled = false;
    const settle = (code) => {
      if (isSettled) return;
      isSettled = true;
      resolve(code);
    };
    resumeProcess.on("close", (code) => settle(code ?? 1));
    setTimeout(() => {
      if (!isSettled) {
        resumeProcess.kill();
        settle(124);
      }
    }, 90_000);
  });
  return { exitCode: resumeExitCode, stdout: resumeStdout, stderr: resumeStderr };
}

const resumeInspectResult =
  missionIdentifier === null
    ? null
    : await runInstalledCliResume(["recover", "resume", missionIdentifier, "--json"]);
const resumeExecuteResult =
  missionIdentifier === null
    ? null
    : await runInstalledCliResume(["recover", "resume", missionIdentifier, "--execute", "--json"]);

const contentAfterResume = readFileSync(targetAbsolutePath, "utf8");
const resumeOutputText = [resumeInspectResult?.stdout, resumeExecuteResult?.stdout]
  .filter((text) => typeof text === "string")
  .join("\n");
record(
  "⑯ 恢复尝试未产生新的 Provider 请求（未重放非幂等写）",
  requestCount === requestsBeforeResume,
  "恢复前请求数=" + String(requestsBeforeResume) + "，恢复后=" + String(requestCount),
);
record(
  "⑰ 恢复尝试未改变目标文件（无重复副作用）",
  contentAfterResume === contentBeforeResume,
  JSON.stringify(contentAfterResume),
);
console.log(
  "\n--- 恢复路径原始输出（供人工核对判定语义）---\n" +
    (resumeOutputText.trim() === "" ? "(空)" : resumeOutputText.trim().slice(0, 1200)),
);

fakeProvider.close();

writeFileSync(
  path.join(archiveRoot, "boundary-interrupt-verdict.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      checkIdentifier: "e2e01-03-boundary-interrupt",
      verdict: checks.every((check) => check.isPassed) ? "passed" : "failed",
      isFakeProvider: !isLiveProviderRun,
      /**
       * 真实验收证据需：真实端点 + 全部判据通过。
       * 注意：本场景**不需要**人工编辑窗口（目标是边界强杀），故不以"检测到人工编辑"为条件。
       */
      isRealAcceptanceEvidence: isLiveProviderRun && checks.every((check) => check.isPassed),
      liveProviderEndpoint: isLiveProviderRun ? liveProviderEndpoint : null,
      credentialReferenceId: isLiveProviderRun ? liveCredentialReferenceId : null,
      sourceCommit,
      sourceStatus,
      tarballSha256,
      tarballSizeBytes: packResult.size,
      recordedAtIso: new Date().toISOString(),
      observedToolCallState,
      killedAfterMilliseconds,
      missionIdentifier,
      requestsBeforeResume,
      requestsAfterResume: requestCount,
      resumeInspectOutput: resumeInspectResult?.stdout ?? null,
      resumeInspectExitCode: resumeInspectResult?.exitCode ?? null,
      resumeExecuteOutput: resumeExecuteResult?.stdout ?? null,
      resumeExecuteExitCode: resumeExecuteResult?.exitCode ?? null,
      requestCount,
      sdkExitCode,
      sdkStderr,
      recoveryOverview: parsedOverview,
      finalTargetContent: readFileSync(targetAbsolutePath, "utf8"),
      checks,
    },
    null,
    2,
  ) + "\n",
);
console.log("\n判据文件: " + path.join(archiveRoot, "boundary-interrupt-verdict.json"));

const failedChecks = checks.filter((check) => !check.isPassed);
if (failedChecks.length > 0) {
  console.error("\n边界中断场景未通过（" + String(failedChecks.length) + " 项失败）");
  process.exit(1);
}
console.log("\nE2E-01-03 边界中断场景通过：崩溃后仍有可信检查点（假 Provider，非真实验收）");
