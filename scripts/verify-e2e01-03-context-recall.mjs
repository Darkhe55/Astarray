#!/usr/bin/env node
/**
 * E2E-01-03 条款 3「上下文预算/回访**实际执行**」验收脚本（真实 Provider + tarball 隔离安装）。
 *
 * 语义（用户定义，2026-10-09 确认）：
 *  - **节点关闭**＝节点被认定为「已完成且后续大概率不会再使用」的上下文部分；
 *  - 关闭后**被视作记忆**（关闭胶囊），只有后续认定需要回溯时才**翻看**（回访）。
 *
 * 产品落点（本脚本据实取证，不臆测）：
 *  - 关闭触发：`orchestration/context-node-lifecycle.ts` 的「任务完成的产品级收口」，
 *    Devolve 默认策略 `continue-with-deferred-review` → 节点 `deferred-review-closed`
 *    ＋ 真实关闭胶囊 ＋ 层级 ≤1 的延迟人工核验待办。
 *  - 回访入口：契约 `ASTARRAY_CONTEXT_RECALL_REQUEST_V1`，产品 CLI `context recall`
 *    （注册于 `packages/tui/src/cli.tsx`）；**调用者身份由 harness 注入**（模型无法自行发起）。
 *  - 证据面：回访**不写** `context-runtime/events.jsonl`，证据是 `recall-ledger.json`
 *    ＋ 命令返回体（2026-10-09 实测）。
 *
 * 判据（先红后绿）：
 *  ① 红：无记忆时回访必须被拒（`status=not-found`）
 *  ② 红：无记忆时不得产生回访账本
 *  ③ 绿：真实运行真正完成（`status=done`）
 *  ④ 绿：节点关闭为 `deferred-review-closed` 且产生关闭胶囊（＝记忆）
 *  ⑤ 绿：产生延迟人工核验待办（优先级层级 ≤1，用户已批准本验收产生该副作用）
 *  ⑥ 绿：回访真正执行（`status=ok`，`tier=closure-capsule`）
 *  ⑦ 绿：回访按 `maximumTokenCount` 计费且未超限
 *  ⑧ 绿：回访账本落盘
 *
 * 用法：
 *   node scripts/verify-e2e01-03-context-recall.mjs --allow-live-request \
 *     --live-provider-endpoint https://api.stepfun.com/v1/chat/completions \
 *     --credential-source state --credential-reference-id prov-live-1 \
 *     --model step-3.7-flash --protocol-label openai-compatible
 *
 * 节省额度：`--reuse-completed-state-directory <dir>` 可跳过真实运行，直接对已有
 * 「已完成运行」的 state 目录复验绿例（红例仍会现场跑）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  console.error("E2E-01-03 回访验收失败: " + message);
  process.exit(exitCode);
}

const argumentsList = process.argv.slice(2);
function takeArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

if (!argumentsList.includes("--allow-live-request")) {
  fail("拒绝执行：本脚本会发起真实 Provider 调用并产生延迟人工核验待办。确认后追加 --allow-live-request。", 2);
}
const runMode = takeArgument("--mode", "devolve");
const modelIdentifier = takeArgument("--model", "step-3.7-flash");
const protocolLabel = takeArgument("--protocol-label", "openai-compatible");
const liveProviderEndpoint = takeArgument(
  "--live-provider-endpoint",
  "https://api.stepfun.com/v1/chat/completions",
);
const liveCredentialSource = takeArgument("--credential-source", "state");
const liveCredentialReferenceId = takeArgument("--credential-reference-id", "prov-live-1");
const liveApiKeyEnvironmentVariableName = "ASTARRAY_PROVIDER_API_KEY";
const reusedStateDirectory = takeArgument("--reuse-completed-state-directory", null);
const maximumRecallTokenCount = 512;
const targetFileName = "NOTES.txt";

function resolveLiveApiKey() {
  if (liveCredentialSource === "env") {
    const providedKey = process.env[liveApiKeyEnvironmentVariableName];
    if (providedKey === undefined || providedKey === "") {
      fail("--credential-source env 要求环境变量 " + liveApiKeyEnvironmentVariableName + " 已设置", 2);
    }
    return providedKey;
  }
  const credentialsFilePath = path.join(repositoryRoot, ".astarray", "providers", "provider-credentials.json");
  if (!existsSync(credentialsFilePath)) {
    fail("--credential-source state 需要受保护凭据文件存在: " + credentialsFilePath, 2);
  }
  const parsedCredentials = JSON.parse(readFileSync(credentialsFilePath, "utf8"));
  const credentialEntry = parsedCredentials?.[liveCredentialReferenceId];
  if (credentialEntry === undefined || typeof credentialEntry.apiKey !== "string" || credentialEntry.apiKey === "") {
    fail("受保护凭据文件中缺少可用条目: " + liveCredentialReferenceId, 2);
  }
  return credentialEntry.apiKey;
}

const checks = [];
function record(checkName, isPassed, detail) {
  checks.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log((isPassed ? "  ✓ " : "  ✗ ") + checkName + " — " + detail);
}

/** 解析 CLI `--json` 的多行输出（取首个 `{` 到末个 `}`）。 */
function parseCliJson(rawText) {
  const startIndex = rawText.indexOf("{");
  const endIndex = rawText.lastIndexOf("}");
  if (startIndex < 0 || endIndex <= startIndex) return null;
  try {
    return JSON.parse(rawText.slice(startIndex, endIndex + 1));
  } catch {
    return null;
  }
}

/** 递归列出文件名匹配的文件（用于在 state 目录里找胶囊/图/待办/账本）。 */
function findFiles(directoryPath, predicate, accumulator = []) {
  if (!existsSync(directoryPath)) return accumulator;
  for (const entryName of readdirSync(directoryPath)) {
    const entryPath = path.join(directoryPath, entryName);
    let entryStat;
    try {
      entryStat = statSync(entryPath);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      findFiles(entryPath, predicate, accumulator);
    } else if (predicate(entryName)) {
      accumulator.push(entryPath);
    }
  }
  return accumulator;
}

async function runInstalledCli(cliArguments, options) {
  const cliProcess = spawn(process.execPath, [options.installedCliPath, ...cliArguments], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ...(options.environment ?? {}) },
  });
  let stdoutText = "";
  let stderrText = "";
  cliProcess.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
  cliProcess.stderr.on("data", (chunk) => (stderrText += String(chunk)));
  if (options.stdinText !== undefined) {
    cliProcess.stdin.end(options.stdinText);
  } else {
    cliProcess.stdin.end();
  }
  const exitCode = await new Promise((resolve) => {
    let isSettled = false;
    const settle = (code) => {
      if (isSettled) return;
      isSettled = true;
      resolve(code);
    };
    cliProcess.on("close", (code) => settle(code ?? 1));
    setTimeout(() => {
      if (!isSettled) {
        cliProcess.kill();
        settle(124);
      }
    }, options.timeoutMilliseconds ?? 300_000);
  });
  return { exitCode, stdoutText, stderrText };
}

// ---------------------------------------------------------------------------
// 1) 打包 + 隔离安装
// ---------------------------------------------------------------------------
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const runIdentifier = new Date().toISOString().replaceAll(":", "-");
const archiveRoot = path.join(repositoryRoot, ".tmp", "e2e01-03-recall", runIdentifier);
const installRoot = path.join(archiveRoot, "install");
const projectDirectory = path.join(archiveRoot, "project");
mkdirSync(installRoot, { recursive: true });
mkdirSync(projectDirectory, { recursive: true });

console.log("=== E2E-01-03 条款 3 回访验收（tarball 隔离安装 + 真实 Provider）===");
console.log("来源提交: " + sourceCommit + "；工作区: " + (sourceStatus === "" ? "干净" : "有未提交改动"));
console.log("真实端点: " + liveProviderEndpoint + "；模型: " + modelIdentifier);

const packOutputRaw = runNpmSync(["pack", "--json", "--pack-destination", archiveRoot, "--ignore-scripts"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
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

// ---------------------------------------------------------------------------
// 2) 红：无记忆时回访必须被拒、且不留痕迹
// ---------------------------------------------------------------------------
const redStateRoot = path.join(archiveRoot, "red-empty-state");
mkdirSync(redStateRoot, { recursive: true });
const redRequest = {
  schemaVersion: 1,
  requestId: "req-red-1",
  taskExecutionId: "task-exec-red-1",
  contextNodeIdentifier: "node-RED-404",
  nodeRevision: 1,
  reasonCode: "capsule-insufficient",
  requiredInformation: "空状态下不应有可回访的记忆",
  maximumTokenCount: maximumRecallTokenCount,
};
const redResult = await runInstalledCli(
  ["context", "recall", "--agent", "worker:red:T-001:1", "--graph", "graph-red", "--request", JSON.stringify(redRequest), "--json"],
  { installedCliPath, cwd: redStateRoot, timeoutMilliseconds: 120_000 },
);
const parsedRedResult = parseCliJson(redResult.stdoutText);
const redLedgerFiles = findFiles(path.join(redStateRoot, ".astarray"), (name) => name === "recall-ledger.json");
record(
  "① 红：无记忆时回访被拒（status=not-found）",
  parsedRedResult?.status === "not-found",
  "status=" + String(parsedRedResult?.status) + "，退出码=" + String(redResult.exitCode),
);
record(
  "② 红：无记忆时不得产生回访账本",
  redLedgerFiles.length === 0,
  "账本文件数=" + String(redLedgerFiles.length),
);

// ---------------------------------------------------------------------------
// 3) 绿：真实运行真正完成 → 关闭胶囊（记忆）＋ 延迟核验待办
// ---------------------------------------------------------------------------
let greenStateDirectory;
let greenRunResult = null;
if (reusedStateDirectory !== null) {
  greenStateDirectory = path.resolve(reusedStateDirectory);
  console.log("（复用已完成运行的 state 目录，跳过真实运行：" + greenStateDirectory + "）");
} else {
  writeFileSync(
    path.join(projectDirectory, targetFileName),
    "项目笔记：本文件用于上下文关闭与回访验收。\n结论：管道 A 已完成，结论为 42。\n",
    "utf8",
  );
  greenRunResult = await runInstalledCli(
    [
      "run",
      "只读任务：请用内置工具 readFile 读取 " + targetFileName + "，如实汇报其内容；不要修改任何文件。完成后按系统提示的完成控制事件收口。",
      "--mode",
      runMode,
      "--runtime",
      protocolLabel,
      "--provider-endpoint",
      liveProviderEndpoint,
      "--provider-model",
      modelIdentifier,
      ...(protocolLabel === "openai-compatible" ? [] : ["--provider-protocol", protocolLabel]),
      "--provider-api-key-env",
      liveApiKeyEnvironmentVariableName,
      "--timeout-seconds",
      "300",
      "--json",
    ],
    {
      installedCliPath,
      cwd: projectDirectory,
      environment: { [liveApiKeyEnvironmentVariableName]: resolveLiveApiKey() },
      timeoutMilliseconds: 420_000,
    },
  );
  greenStateDirectory = path.join(projectDirectory, ".astarray");
  writeFileSync(path.join(archiveRoot, "green-run-stdout.txt"), greenRunResult.stdoutText, "utf8");
  writeFileSync(path.join(archiveRoot, "green-run-stderr.txt"), greenRunResult.stderrText, "utf8");
}
const parsedGreenRun = greenRunResult === null ? null : parseCliJson(greenRunResult.stdoutText);
if (reusedStateDirectory === null) {
  record(
    "③ 绿：真实运行真正完成（status=done）",
    parsedGreenRun?.status === "done",
    "status=" + String(parsedGreenRun?.status) + "，退出码=" + String(greenRunResult?.exitCode),
  );
}

const capsuleFiles = findFiles(greenStateDirectory, (name) => name.startsWith("capsule-") && name.endsWith(".json"));
const graphFiles = findFiles(greenStateDirectory, (name) => name === "context-graph.json");
const deferredTaskFiles = findFiles(
  greenStateDirectory,
  (name) => name.startsWith("verify-") && name.endsWith(".json"),
);
const capsules = capsuleFiles
  .map((filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  })
  .filter((capsule) => capsule !== null);
const capsule = capsules.at(-1) ?? null;
const graphs = graphFiles
  .map((filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  })
  .filter((graph) => graph !== null);
const graph = graphs.at(-1) ?? null;
const graphNode = Array.isArray(graph?.nodes)
  ? graph.nodes.find((node) => node.contextNodeIdentifier === capsule?.contextNodeIdentifier)
  : undefined;

record(
  "④ 绿：节点关闭为 deferred-review-closed 且产生关闭胶囊（=记忆）",
  capsule !== null &&
    graphNode?.state === "deferred-review-closed" &&
    capsule.verificationState === "deferred-review-closed",
  "节点状态=" + String(graphNode?.state) + "，胶囊=" + String(capsule?.capsuleIdentifier),
);
const parsedDeferredTask = (() => {
  const firstPath = deferredTaskFiles[0];
  if (firstPath === undefined) return null;
  try {
    return JSON.parse(readFileSync(firstPath, "utf8"));
  } catch {
    return null;
  }
})();
record(
  "⑤ 绿：产生延迟人工核验待办（优先级层级 ≤1）",
  parsedDeferredTask !== null && Number(parsedDeferredTask.priorityTier) <= 1,
  "待办=" + String(parsedDeferredTask?.taskIdentifier) + "，priorityTier=" + String(parsedDeferredTask?.priorityTier),
);

// ---------------------------------------------------------------------------
// 4) 绿：对"记忆"发起一次合法回访，必须真正执行并落账本
// ---------------------------------------------------------------------------
let parsedGreenRecall = null;
let greenRecallResult = null;
if (capsule !== null && graph !== null) {
  /**
   * 复用模式：上一次回访会命中**回执冷却**（账本键 = 调用者/节点/revision），
   * 本次将返回 `repeat-receipt` 而非真正执行 —— 那会让 ⑥ 失真。
   * 这里清掉本脚本自己在复用目录里产生的回访账本，使复验等价于"首次翻看"。
   */
  if (reusedStateDirectory !== null) {
    for (const ledgerFilePath of findFiles(greenStateDirectory, (name) => name === "recall-ledger.json")) {
      rmSync(ledgerFilePath, { force: true });
    }
  }
  const greenRequest = {
    schemaVersion: 1,
    requestId: "req-green-1",
    taskExecutionId: "task-exec-green-1",
    contextNodeIdentifier: capsule.contextNodeIdentifier,
    nodeRevision: capsule.contextGraphRevision,
    reasonCode: "capsule-insufficient",
    requiredInformation: "此前任务的结论",
    maximumTokenCount: maximumRecallTokenCount,
  };
  greenRecallResult = await runInstalledCli(
    [
      "context",
      "recall",
      "--agent",
      capsule.agentInstanceId,
      "--graph",
      graph.graphIdentifier,
      "--request",
      JSON.stringify(greenRequest),
      "--json",
    ],
    { installedCliPath, cwd: greenStateDirectory.replace(/[\\/]\.astarray$/, ""), timeoutMilliseconds: 120_000 },
  );
  parsedGreenRecall = parseCliJson(greenRecallResult.stdoutText);
  writeFileSync(path.join(archiveRoot, "green-recall-stdout.txt"), greenRecallResult.stdoutText, "utf8");
}
record(
  "⑥ 绿：回访真正执行（status=ok 且 tier=closure-capsule）",
  parsedGreenRecall?.status === "ok" && parsedGreenRecall?.tier === "closure-capsule",
  "status=" + String(parsedGreenRecall?.status) + "，tier=" + String(parsedGreenRecall?.tier),
);
record(
  "⑦ 绿：回访按 maximumTokenCount 计费且未超限",
  typeof parsedGreenRecall?.estimatedTokenCount === "number" &&
    parsedGreenRecall.estimatedTokenCount <= maximumRecallTokenCount,
  "estimatedTokenCount=" +
    String(parsedGreenRecall?.estimatedTokenCount) +
    "（上限 " +
    String(maximumRecallTokenCount) +
    "），remaining=" +
    String(parsedGreenRecall?.remainingTokenCount),
);
const greenLedgerFiles = findFiles(greenStateDirectory, (name) => name === "recall-ledger.json");
record(
  "⑧ 绿：回访账本落盘（recall-ledger.json）",
  greenLedgerFiles.length >= 1,
  "账本文件=" + JSON.stringify(greenLedgerFiles.map((filePath) => path.basename(path.dirname(filePath)) + "/" + path.basename(filePath))),
);

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
const failedChecks = checks.filter((check) => !check.isPassed);
const verdict = {
  schemaVersion: 1,
  checkIdentifier: "e2e01-03-context-recall",
  verdict: failedChecks.length > 0 ? "failed" : "passed",
  isFakeProvider: false,
  /**
   * 真实验收证据 = 全部判据通过 **且本次确实跑了真实运行**。
   *
   * 复用模式（`--reuse-completed-state-directory`）会**跳过**判据③（真实运行本身），
   * 因此那种情况下不得标记为真实验收证据——否则又会出现"字段夸大"的同类缺陷。
   */
  isRealAcceptanceEvidence: failedChecks.length === 0 && reusedStateDirectory === null,
  sourceCommit,
  sourceStatus,
  tarballSha256,
  tarballSizeBytes: packResult.size,
  liveProviderEndpoint,
  credentialReferenceId: liveCredentialReferenceId,
  modelIdentifier,
  runMode,
  reusedCompletedStateDirectory: reusedStateDirectory,
  capsuleIdentifier: capsule?.capsuleIdentifier ?? null,
  contextNodeIdentifier: capsule?.contextNodeIdentifier ?? null,
  contextNodeState: graphNode?.state ?? null,
  deferredVerificationTaskIdentifier: parsedDeferredTask?.taskIdentifier ?? null,
  deferredVerificationPriorityTier: parsedDeferredTask?.priorityTier ?? null,
  redRecallStatus: parsedRedResult?.status ?? null,
  greenRecallStatus: parsedGreenRecall?.status ?? null,
  greenRecallTier: parsedGreenRecall?.tier ?? null,
  greenRecallEstimatedTokenCount: parsedGreenRecall?.estimatedTokenCount ?? null,
  recordedAtIso: new Date().toISOString(),
  checks,
  failedCheckNames: failedChecks.map((check) => check.checkName),
};
const verdictPath = path.join(archiveRoot, "context-recall-verdict.json");
writeFileSync(verdictPath, JSON.stringify(verdict, null, 2) + "\n");
console.log("\n判据记录文件: " + verdictPath);

if (failedChecks.length > 0) {
  console.error("\n回访验收未通过（" + String(failedChecks.length) + " 项失败）:");
  for (const failedCheck of failedChecks) {
    console.error("  - " + failedCheck.checkName + ": " + failedCheck.detail);
  }
  if (greenRunResult !== null && greenRunResult.stderrText.trim() !== "") {
    console.error("\nCLI stderr 末尾:\n" + greenRunResult.stderrText.trim().split("\n").slice(-8).join("\n"));
  }
  process.exit(1);
}
console.log(
  "\nE2E-01-03 条款 3：节点关闭（＝记忆）与回访实际执行 ✓" +
    (verdict.isRealAcceptanceEvidence ? "（**真实 Provider + tarball 隔离安装**：真实验收证据）" : "（非真实验收）"),
);
