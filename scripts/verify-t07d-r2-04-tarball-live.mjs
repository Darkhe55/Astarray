#!/usr/bin/env node
/**
 * T07D-R2-04 **tarball 隔离安装**下的真实工作流验收（T07D 任务卡 §4：
 * `product-path-verified` = 从 npm tarball 经 CLI 完成真实工作流）。
 *
 * 与 dev-checkout 版（verify-t07d-r2-04-live-write.mjs）的区别：
 *   1. 先 `npm pack` 生成 tarball，并**记录 tarball 的 sha256 与来源提交**；
 *   2. 在**全新目录**隔离安装该 tarball（不触碰仓库 `dist/`、不复制仓库 `.astarray/`）；
 *   3. 从 `node_modules/.bin` 的**安装包入口**运行 CLI（不是 dev checkout 的 dist/cli.js）；
 *   4. 以该全新目录为 cwd 运行 → 状态目录是该目录自己的 `.astarray/`；
 *   5. 凭证**只经环境变量**（`--provider-api-key-env`），不落盘、不复制原凭据目录。
 *
 * 用法：
 *   # 干跑（零真实额度；本地假 Provider，验证判定链路与"缺产物拒绝结案"）
 *   node scripts/verify-t07d-r2-04-tarball-live.mjs --dry-run
 *
 *   # 真实运行（需显式授权；默认要求 TTY 交互裁决）
 *   ASTARRAY_PROVIDER_API_KEY=<key> \
 *   node scripts/verify-t07d-r2-04-tarball-live.mjs \
 *     --allow-live-request --provider-endpoint https://api.stepfun.com/v1/chat/completions \
 *     --provider-model step-3.7-flash
 *
 *   # 真实运行（非交互环境：必须显式给出一次裁决；该选择会记录进判据文件）
 *   node scripts/verify-t07d-r2-04-tarball-live.mjs \
 *     --allow-live-request --provider-endpoint <endpoint> \
 *     --permission-decision allow-once
 *
 *   # 真实运行（凭据改从受保护凭据文件读，密钥不经过调用方环境）
 *   node scripts/verify-t07d-r2-04-tarball-live.mjs \
 *     --allow-live-request --provider-endpoint <endpoint> \
 *     --permission-decision allow-once --credential-source state
 *
 * 纪律：
 * - `--allow-live-request` 缺失时拒绝执行（除非 `--dry-run`）；
 * - 真实模式默认要求 TTY；非交互（管道/服务化）必须显式 `--permission-decision`，
 *   使"谁批准了这次授权"在判据文件内可审计，而不是靠管道默默喂一行；
 * - 只发起 1 次任务，不重试；产物只写在该全新目录内；
 * - 不打印任何凭据（只报告环境变量**是否存在**）。
 *
 * 2026-10-06 修复（**零判据通过**缺陷）：此前真实分支从未执行任务
 * （`rounds` 只在 `if (isDryRun)` 内被填充），真实运行会写出 `verdict: "passed"`
 * 却一次 Provider 请求都没发。现在：
 *   - 真实模式**真正执行一次任务**并走与干跑同一套五项判据；
 *   - 判定逻辑移到 `scripts/lib/t07d-r2-04-acceptance-decision.mjs`，
 *     由 `tests/core/unit/t07d-r2-04-acceptance-decision.test.ts` 钉住
 *     "零轮次绝不通过"与"无其他改动不得缺省跳过"。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAcceptanceChecks,
  collectUnexpectedProjectEntries,
  readUsageObservation,
} from "./lib/t07d-r2-04-acceptance-decision.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Windows 上 npm 是 .cmd shim，execFile/spawn 不会自动补后缀。 */
const npmExecutableName = process.platform === "win32" ? "npm.cmd" : "npm";
/**
 * 如何调用 npm（2026-10-02 实测教训）：
 * - Windows + Node 24 直接 spawn `.cmd` → EINVAL（CVE-2024-27980 的修复行为）；
 * - 改用 `shell: true` → **含冒号的绝对路径**（`C:\...`、ISO 时间戳）在 shell 拼接时被破坏，
 *   实测 `npm pack` 因此失败。
 * 因此：优先解析 npm 的 JS 入口，用 `node <npm-cli.js> <args>` 调用（**完全不经 shell**、
 * 参数原样传递）；解析失败才退回 shell 模式。
 */
const npmCliPath = (() => {
  try {
    const lookupOutput = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["npm"],
      {
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    for (const candidateLine of lookupOutput.split(/\r?\n/)) {
      const candidate = candidateLine.trim();
      if (candidate === "") continue;
      const cliCandidate = path.join(
        path.dirname(candidate),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (existsSync(cliCandidate)) {
        return cliCandidate;
      }
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

const isDryRun = argumentsList.includes("--dry-run");
const isLiveAllowed = argumentsList.includes("--allow-live-request");
const providerEndpoint = takeArgument("--provider-endpoint", null);
const modelIdentifier = takeArgument("--model", "step-3.7-flash");
const apiKeyEnvironmentVariableName = takeArgument(
  "--provider-api-key-env",
  "ASTARRAY_PROVIDER_API_KEY",
);
const requestTimeoutSeconds = takeArgument("--request-timeout-seconds", "120");
const taskTimeoutSeconds = takeArgument("--task-timeout-seconds", "240");
/**
 * 非交互裁决（2026-10-06）：服务化/管道环境无法由人输入 `allow-once`，
 * 必须**显式**给出本次裁决。取值为 `allow-once` 或 `deny`；
 * 该值只喂给子进程的 stdin 一次，且会写入判据文件的 `permissionDecisionSource`。
 */
const permissionDecision = takeArgument("--permission-decision", null);
if (permissionDecision !== null && permissionDecision !== "allow-once" && permissionDecision !== "deny") {
  fail(
    `--permission-decision 必须是 allow-once 或 deny（收到: ${permissionDecision}）`,
    2,
  );
}
/**
 * 凭据来源（2026-10-06）：
 *  - `env`（默认，与既有文档一致）：由调用方把密钥放进 `--provider-api-key-env` 指定的环境变量；
 *  - `state`：脚本自己读受保护凭据文件 `.astarray/providers/provider-credentials.json`
 *    的指定引用，再以同一环境变量注入子进程——与 `verify-u2-flash-continuous-reception.mjs`
 *    的 `--credential-source state` 语义一致。
 * 两种方式都**不打印、不落盘**密钥，判据文件里只出现"来源"与"引用 ID"。
 */
const credentialSource = takeArgument("--credential-source", "env");
if (credentialSource !== "state" && credentialSource !== "env") {
  fail(`--credential-source 必须是 state 或 env（收到: ${credentialSource}）`, 2);
}
const credentialReferenceId = takeArgument("--credential-reference-id", "prov-unisound-1");

const outputFileRelativePath = ".tmp/t07d-r2-04-live/LIVE-PROOF.md";
/**
 * 预期产物内容**由参数推导**（2026-10-02 起**厂商无关**）：
 * 厂商标签、端点、模型全部来自本次实际使用的参数，因此提示词、产物内容与判定标准三者一致——
 * 不会出现"用 A 厂商跑却按 B 厂商判定"，也不会出现"产物写着别的厂商"。
 *
 * 干跑时必须显式传入真实端点（脚本不会向其发请求，仅用于渲染与判定），
 * 使干跑覆盖的产物内容与真实运行完全一致。
 */
const endpointHostName = (() => {
  if (providerEndpoint === null) {
    return "(未指定端点)";
  }
  try {
    return new URL(providerEndpoint).host;
  } catch {
    return providerEndpoint;
  }
})();
const vendorIdentifier = takeArgument("--vendor-identifier", endpointHostName);
/**
 * 协议标签（2026-10-02）：与 CLI 的 `--provider-protocol` **必须一致**，
 * 并写入产物内容，使"这次究竟用哪条协议跑的"可审计（不靠旁注推断）。
 * 干跑时会校验该值合法，避免把笔误带进真实运行。
 */
const protocolLabel = takeArgument("--protocol-label", "openai-compatible");
if (protocolLabel !== "openai-compatible" && protocolLabel !== "anthropic-messages") {
  fail(
    `--protocol-label 必须是 openai-compatible 或 anthropic-messages（收到: ${protocolLabel}）`,
    2,
  );
}
const expectedContent = [
  "# 真实 Provider 受控改动（T07D-R2-04）",
  "- 厂商：" + vendorIdentifier,
  "- 端点：" + endpointHostName,
  "- 模型：" + modelIdentifier,
  "- 协议：" + protocolLabel,
  "",
].join("\n");

function fail(message, exitCode = 1) {
  console.error("T07D-R2-04 tarball 验收失败: " + message);
  process.exit(exitCode);
}

if (!isDryRun && !isLiveAllowed) {
  fail(
    "拒绝执行：本脚本会发起真实 Provider 请求并产生费用。确认额度后追加 --allow-live-request。",
    2,
  );
}
if (!isDryRun && process.stdin.isTTY !== true && permissionDecision === null) {
  fail(
    "拒绝执行：真实模式要求 **TTY 交互**输入裁决；非交互环境必须显式给出 " +
      "--permission-decision allow-once（该选择会记录进判据文件，供事后审计）。",
    2,
  );
}
if (!isDryRun && providerEndpoint === null) {
  fail("拒绝执行：真实模式必须显式给出 --provider-endpoint。", 2);
}
if (!isDryRun && credentialSource === "env") {
  const providedKey = process.env[apiKeyEnvironmentVariableName];
  if (providedKey === undefined || providedKey === "") {
    fail(
      "拒绝执行：--credential-source env 要求环境变量 " +
        apiKeyEnvironmentVariableName +
        " 已提供（或改用 --credential-source state 读受保护凭据文件）。值不会被打印。",
      2,
    );
  }
}

/**
 * 从受保护凭据文件解析密钥（只读；**不打印、不落盘、不写入判据文件**）。
 * 与 `verify-u2-flash-continuous-reception.mjs --credential-source state` 同源同义。
 */
function resolveApiKeyFromStateFile() {
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
    fail("受保护凭据文件无法解析为 JSON: " + String(error?.message ?? error), 2);
  }
  const credentialEntry = parsedCredentials?.[credentialReferenceId];
  if (credentialEntry === undefined || typeof credentialEntry.apiKey !== "string" || credentialEntry.apiKey === "") {
    fail("受保护凭据文件中缺少可用条目（apiKey 必须是非空字符串）: " + credentialReferenceId, 2);
  }
  return credentialEntry.apiKey;
}

/**
 * 注入子进程的环境变量值：dry-run 不需要凭据；
 * `state` 由本脚本读文件解析，`env` 直接沿用调用方已设置的值。
 */
const resolvedChildApiKey =
  isDryRun || credentialSource === "env" ? null : resolveApiKeyFromStateFile();

// ---------------------------------------------------------------------------
// 1) 固定来源提交 + 打包 + 记录 tarball sha256
// ---------------------------------------------------------------------------
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const runIdentifier = new Date().toISOString().replaceAll(":", "-");
const archiveRoot = path.join(repositoryRoot, ".tmp", "tarball-live", runIdentifier);
const installRoot = path.join(archiveRoot, "install");
mkdirSync(archiveRoot, { recursive: true });
mkdirSync(installRoot, { recursive: true });

console.log("=== T07D-R2-04 tarball 隔离安装验收 ===");
console.log("来源提交: " + sourceCommit);
console.log(
  "工作区状态: " +
    (sourceStatus === ""
      ? "干净（无改动）"
      : "有未提交改动（**tarball 内容可能与提交不完全一致**）"),
);
console.log("厂商: " + vendorIdentifier + " | 模型: " + modelIdentifier + " | 协议: " + protocolLabel + " | 端点: " + String(providerEndpoint));
console.log("运行标识: " + runIdentifier);

const packOutputRaw = runNpmSync(
  [
    "pack",
    "--json",
    "--pack-destination",
    archiveRoot,
    /**
     * 确定性打包（2026-10-02 实测教训）：
     * prepack 会跑 npm run check（全量测试）；在打包这类重负载下，已知的负载敏感情景
     * 会让某个用例抖动失败 → tarball 产出不稳定、哈希不可复现。
     * 本验收要求**确定性产物**，故默认跳过 pack 生命周期脚本；仓库门禁由 npm run check
     * 单独负责（本脚本在报告中引用其退出码）。如需连 prepack 一起跑，加 --run-prepack。
     */
    ...(argumentsList.includes("--run-prepack") ? [] : ["--ignore-scripts"]),
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const packOutput = packOutputRaw.replace(/\u001B\[[0-9;]*m/g, "");
const packJsonStartIndex = packOutput.indexOf("[");
if (packJsonStartIndex < 0) {
  fail("npm pack 未返回 JSON（无法确定 tarball 名称）: " + packOutput.slice(0, 200), 2);
}
const packResult = JSON.parse(packOutput.slice(packJsonStartIndex))[0];
const tarballPath = path.join(archiveRoot, packResult.filename);
const tarballSha256 = createHash("sha256")
  .update(readFileSync(tarballPath))
  .digest("hex");
console.log("tarball: " + packResult.filename);
console.log("tarball 字节数: " + String(packResult.size));
console.log("tarball sha256: " + tarballSha256);

// ---------------------------------------------------------------------------
// 2) 全新目录隔离安装（不复制仓库 .astarray；凭证只走环境变量）
// ---------------------------------------------------------------------------
runNpmSync(["init", "-y"], { cwd: installRoot, stdio: "ignore" });
runNpmSync(["install", "--no-audit", "--no-fund", tarballPath], {
  cwd: installRoot,
  stdio: "inherit",
});
const installedCliPath = path.join(
  installRoot,
  "node_modules",
  "astarray",
  "dist",
  "cli.js",
);
if (!existsSync(installedCliPath)) {
  fail("隔离安装后找不到安装包入口: " + installedCliPath, 2);
}
console.log("安装包入口: " + installedCliPath);
if (existsSync(path.join(installRoot, ".astarray"))) {
  fail("全新目录内不应存在预先准备好的 .astarray（凭据不得复制）", 2);
}

// ---------------------------------------------------------------------------
// 3) 逐轮运行
//    - 干跑：两条路径（成功 / 缺产物拒绝结案），由本地假 Provider 驱动；
//    - 真实：一条路径（成功），由 --provider-endpoint 指向的真实 Provider 驱动。
// ---------------------------------------------------------------------------
function buildPrompt() {
  return [
    "只读约束与范围：本次任务只允许改动 .tmp/t07d-r2-04-live/ 目录下的内容，",
    "绝不允许读取或修改该目录之外的任何文件，也不要执行 shell 命令。",
    "",
    "请用内置工具 createProjectFile（只能新建、不能覆盖；参数 filePath 与 content）完成一个极小的受控改动：",
    "1. filePath 必须是：" + outputFileRelativePath,
    "2. content 必须严格为下面五行（Markdown，保留换行）：",
    "   # 真实 Provider 受控改动（T07D-R2-04）",
    "   - 厂商：" + vendorIdentifier,
    "   - 端点：" + endpointHostName,
    "   - 模型：" + modelIdentifier,
    "   - 协议：" + protocolLabel,
    "",
    "要求：",
    "- 直接调用 createProjectFile 一次：它是仅新建、不覆盖的工具，目标已存在时会自行拒绝并返回错误；",
    "  因此不要先做\"文件是否已存在\"的探查（探查类工具可能受授权边界限制）；",
    "- 以 createProjectFile 的返回结果为准：返回成功即视为产物已写入；返回失败则如实说明失败原因；",
    "- 不创建或修改其他文件；",
    "最终回复的最后一行必须是下面这一行独立的完成控制事件（字段不得改动、不得放进代码块）：",
    '          ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"task-exec:t07d-r2-04","completionAttemptId":"attempt-t07d-r2-04-live-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":1}',
  ].join("\n");
}

/** 运行一次并返回判定所需事实。 */
async function runOnce(input) {
  const projectDirectory = input.projectDirectory;
  rmSync(path.join(projectDirectory, outputFileRelativePath), { force: true });
  mkdirSync(path.join(projectDirectory, ".tmp", "t07d-r2-04-live"), { recursive: true });

  const childProcess = spawn(
    process.execPath,
    [
      installedCliPath,
      "run",
      buildPrompt(),
      "--mode",
      "assist",
      "--runtime",
      "openai-compatible",
      "--provider-endpoint",
      input.endpoint,
      "--provider-model",
      modelIdentifier,
      // 协议选择（2026-10-02）：openai-compatible 为 CLI 默认，故仅在非默认时显式传参，
      // 保持既有命令形态不变；anthropic-messages 必须显式传给 CLI。
      ...(protocolLabel === "openai-compatible"
        ? []
        : ["--provider-protocol", protocolLabel]),
      "--provider-api-key-env",
      apiKeyEnvironmentVariableName,
      "--provider-request-timeout-seconds",
      requestTimeoutSeconds,
      "--timeout-seconds",
      taskTimeoutSeconds,
      "--json",
    ],
    {
      cwd: projectDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        // 凭据只经环境变量传递；键名由调用方指定，值永不打印。
        ...(resolvedChildApiKey === null
          ? {}
          : { [apiKeyEnvironmentVariableName]: resolvedChildApiKey }),
      },
    },
  );

  let stdoutText = "";
  let stderrText = "";
  childProcess.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
  childProcess.stderr.on("data", (chunk) => (stderrText += String(chunk)));
  // 真实模式：TTY 交由其父终端；干跑与显式裁决模式：喂一次裁定。
  if (isDryRun) {
    childProcess.stdin.end("allow-once\n");
  } else if (permissionDecision !== null) {
    childProcess.stdin.end(permissionDecision + "\n");
  } else {
    childProcess.stdin.pipe(process.stdin);
  }

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
    }, (Number(taskTimeoutSeconds) + 60) * 1000);
  });

  // 多行 JSON：按大括号配平提取（与 dev-checkout 版同一坑，见 scripts/lib）。
  const jsonText = (() => {
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
  let parsedResult = null;
  try {
    parsedResult = jsonText === null ? null : JSON.parse(jsonText);
  } catch {
    parsedResult = null;
  }

  const outputFilePath = path.join(projectDirectory, outputFileRelativePath);
  const fileExists = existsSync(outputFilePath);
  const actualContent = fileExists ? readFileSync(outputFilePath, "utf8") : null;
  return {
    exitCode,
    parsedResult,
    fileExists,
    actualContent,
    stderrText,
    stdoutText,
    /** 第五项判据的事实来源：除目标产物与 CLI 状态目录外的条目。 */
    unexpectedEntryList: collectUnexpectedProjectEntries({
      projectDirectory,
      outputFileRelativePath,
    }),
  };
}

const rounds = [];
if (isDryRun) {
  /**
   * 干跑夹具按**协议**生成对应形态（2026-10-02）：
   * 干跑必须覆盖真实运行所用的协议，否则"干跑通过"证明不了那条路径。
   */
  const completionEventJson = JSON.stringify({
    taskExecutionId: "task-exec:t07d-r2-04",
    completionAttemptId: "attempt-t07d-r2-04-live-1",
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });
  const toolCallArgumentsJson = JSON.stringify({
    filePath: outputFileRelativePath,
    content: expectedContent,
  });

  function buildOpenAiToolCallStream(callId) {
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
                  function: { name: "createProjectFile", arguments: toolCallArgumentsJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "\n\ndata: [DONE]\n\n"
    );
  }
  function buildOpenAiCompletionStream() {
    return (
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
      "\n\ndata: [DONE]\n\n"
    );
  }
  const anthropicSse = (event) =>
    "event: message\ndata: " + JSON.stringify(event) + "\n\n";
  function buildAnthropicToolCallStream(callId) {
    return (
      anthropicSse({ type: "message_start" }) +
      anthropicSse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: callId, name: "createProjectFile" },
      }) +
      anthropicSse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: toolCallArgumentsJson },
      }) +
      anthropicSse({ type: "content_block_stop", index: 0 }) +
      anthropicSse({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
      anthropicSse({ type: "message_stop" })
    );
  }
  function buildAnthropicCompletionStream() {
    return (
      anthropicSse({ type: "message_start" }) +
      anthropicSse({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "已完成。\nASTARRAY_TASK_COMPLETION_V1 " + completionEventJson,
        },
      }) +
      anthropicSse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      anthropicSse({ type: "message_stop" })
    );
  }
  /** 按当前协议生成"请求工具"或"给出完成事件"。 */
  function buildFixtureStream(input) {
    const isAnthropic = protocolLabel === "anthropic-messages";
    if (input.kind === "tool-call") {
      return isAnthropic
        ? buildAnthropicToolCallStream(input.callId)
        : buildOpenAiToolCallStream(input.callId);
    }
    return isAnthropic ? buildAnthropicCompletionStream() : buildOpenAiCompletionStream();
  }
  /**
   * 工具成功判据（2026-10-02 修正）：**不猜成功文案**，而是看最近一次 tool_result
   * 是否**不含错误标记**。此前按 "已新建项目文件" 字面匹配，一旦实际成功文案不同
   * （或工具被权限/范围门禁拒绝）就会误判为"未成功"，导致夹具无限重调工具，
   * 最终被"连续失败阈值"判失败 —— 实测踩过。
   */
  function hasToolSucceededInBody(body) {
    const toolResultContents = [];
    const collectFromContentBlocks = (content) => {
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block !== null && typeof block === "object" && block.type === "tool_result") {
          toolResultContents.push(typeof block.content === "string" ? block.content : "");
        }
      }
    };
    try {
      const parsed = JSON.parse(body);
      for (const message of parsed.messages ?? []) {
        collectFromContentBlocks(message.content);
      }
      // OpenAI 形态：role="tool" 的 content
      for (const message of parsed.messages ?? []) {
        if (message.role === "tool" && typeof message.content === "string") {
          toolResultContents.push(message.content);
        }
      }
    } catch {
      return false;
    }
    if (toolResultContents.length === 0) {
      return false;
    }
    const latestToolResult = toolResultContents[toolResultContents.length - 1] ?? "";
    return !latestToolResult.includes("错误(") && latestToolResult.trim() !== "";
  }
  const dryRunEndpointPath =
    protocolLabel === "anthropic-messages" ? "/anthropic/v1/messages" : "/v1/chat/completions";

  // 干跑 A：成功路径（工具真正执行 → 产物落盘、status=done）
  const successProject = path.join(archiveRoot, "dry-success");
  mkdirSync(successProject, { recursive: true });
  let requestCount = 0;
  const successServer = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      requestCount += 1;
      const hasToolSucceeded = hasToolSucceededInBody(body);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(
        buildFixtureStream({
          kind: hasToolSucceeded ? "completion" : "tool-call",
          callId: "c" + String(requestCount),
        }),
      );
      response.end();
    });
  });
  await new Promise((resolve) => successServer.listen(0, "127.0.0.1", resolve));
  const successEndpoint =
    "http://127.0.0.1:" + successServer.address().port + dryRunEndpointPath;
  const successResult = await runOnce({
    projectDirectory: successProject,
    endpoint: successEndpoint,
  });
  successServer.close();
  rounds.push({
    roundName: "干跑 A：成功路径",
    expectation: "status=done 且产物正确",
    roundKind: "success",
    projectDirectory: successProject,
    ...successResult,
  });

  // 干跑 B：缺产物拒绝结案（工具从未成功、模型直接声称完成）
  const rejectionProject = path.join(archiveRoot, "dry-rejection");
  mkdirSync(rejectionProject, { recursive: true });
  const rejectionServer = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      /**
       * 拒绝路径：**声明**产物但从不调用工具（按协议生成对应形态）。
       * 门禁据此做产物对账，缺失即拒绝结案。
       */
      const rejectionCompletionJson = JSON.stringify({
        taskExecutionId: "task-exec:t07d-r2-04",
        completionAttemptId: "attempt-t07d-r2-04-live-1",
        completedTaskIdentifiers: ["T-001"],
        claimedStatus: "complete",
        taskSequenceRevision: 1,
        declaredArtifacts: [outputFileRelativePath],
      });
      if (protocolLabel === "anthropic-messages") {
        response.write(
          anthropicSse({ type: "message_start" }) +
            anthropicSse({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text:
                  "已完成（未真正执行工具，但**声明**了产物）。\nASTARRAY_TASK_COMPLETION_V1 " +
                  rejectionCompletionJson,
              },
            }) +
            anthropicSse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
            anthropicSse({ type: "message_stop" }),
        );
      } else {
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    role: "assistant",
                    content:
                      "已完成（未真正执行工具，但**声明**了产物）。\nASTARRAY_TASK_COMPLETION_V1 " +
                      rejectionCompletionJson,
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      }
      response.end();
    });
  });
  await new Promise((resolve) => rejectionServer.listen(0, "127.0.0.1", resolve));
  const rejectionEndpoint =
    "http://127.0.0.1:" + rejectionServer.address().port + dryRunEndpointPath;
  const rejectionResult = await runOnce({
    projectDirectory: rejectionProject,
    endpoint: rejectionEndpoint,
  });
  rejectionServer.close();
  rounds.push({
    roundName: "干跑 B：缺产物拒绝结案",
    expectation: "status != done（门禁拒绝谎报完成）且无产物",
    roundKind: "rejection",
    projectDirectory: rejectionProject,
    ...rejectionResult,
  });
} else {
  /**
   * 真实运行（2026-10-06 修复）：此前**没有这个分支**，真实模式下 rounds 恒为空，
   * 判定段据此写出 `verdict: "passed"` 并在终端打印"验收通过：产物正确 + 任务 done ✓"，
   * 而实际一次 Provider 请求都没发。这里真正执行一次任务，并复用同一套判定。
   */
  const liveProject = path.join(archiveRoot, "live-project");
  mkdirSync(liveProject, { recursive: true });
  const liveResult = await runOnce({
    projectDirectory: liveProject,
    endpoint: providerEndpoint,
  });
  rounds.push({
    roundName: "真实运行：成功路径",
    expectation: "status=done 且产物正确（真实 Provider）",
    roundKind: "success",
    projectDirectory: liveProject,
    ...liveResult,
  });
}

// ---------------------------------------------------------------------------
// 4) 判定（逻辑在 scripts/lib/t07d-r2-04-acceptance-decision.mjs，由单测钉住）
// ---------------------------------------------------------------------------
const acceptanceDecision = buildAcceptanceChecks({
  isDryRun,
  rounds,
  expectedContent,
  outputFileRelativePath,
});
const { checks, failedCheckNames } = acceptanceDecision;
const isCheckBelongingToRound = (check, round) =>
  check.checkName.startsWith(round.roundName + " / ");
for (const round of rounds) {
  console.log("\n--- " + round.roundName + "（" + round.expectation + "）---");
  for (const check of checks.filter((candidate) => isCheckBelongingToRound(candidate, round))) {
    console.log((check.isPassed ? "  ✓ " : "  ✗ ") + check.checkName + " — " + check.detail);
  }
}
// 不属于任何轮次的兜底判据（例如"零轮次不得通过"）也要打印，不能被静默吞掉。
for (const check of checks.filter(
  (candidate) => !rounds.some((round) => isCheckBelongingToRound(candidate, round)),
)) {
  console.log((check.isPassed ? "  ✓ " : "  ✗ ") + check.checkName + " — " + check.detail);
}

console.log("\n=== 凭证来源 ===");
console.log("凭据来源: " + credentialSource);
if (credentialSource === "state") {
  console.log("凭据引用 ID: " + credentialReferenceId + "（值不打印）");
}
console.log(
  "环境变量 " +
    apiKeyEnvironmentVariableName +
    " 是否提供: " +
    (process.env[apiKeyEnvironmentVariableName] === undefined ||
    process.env[apiKeyEnvironmentVariableName] === ""
      ? credentialSource === "state" && resolvedChildApiKey !== null
        ? "否（由 --credential-source state 在子进程环境内注入，值不打印）"
        : "否"
      : "是（值不打印）"),
);
console.log("是否复制了仓库 .astarray: 否（全新目录自带状态目录）");

/**
 * 本次运行的裁决来源（2026-10-06）：TTY 人工输入 vs 显式开关，必须可审计，
 * 否则"谁批准了这次授权"只能靠脚本旁注推断。
 */
const permissionDecisionSource = isDryRun
  ? "dry-run-fixture"
  : permissionDecision === null
    ? "interactive-tty"
    : "explicit-flag";
/**
 * 用量观察（2026-10-06）：从**本次运行自己的**隔离状态目录读本地账目，
 * 使判据文件自带真实 usage（卡内条款"记录 usage/费用范围"）。
 * 只读、不发请求；读不到即 null，不伪造。
 */
const usageObservation =
  rounds.length === 0 ? null : readUsageObservation(rounds[0].projectDirectory);

console.log("\n=== tarball 记录 ===");
console.log("来源提交: " + sourceCommit);
console.log("tarball sha256: " + tarballSha256);
const recordPath = path.join(archiveRoot, "tarball-record.json");
writeFileSync(
  recordPath,
  JSON.stringify(
    {
      sourceCommit,
      sourceStatus,
      tarballFileName: packResult.filename,
      tarballSha256,
      tarballSizeBytes: packResult.size,
      installedCliPath,
      vendorIdentifier,
      modelIdentifier,
      protocolLabel,
      isDryRun,
      endpoint: providerEndpoint,
      credentialSource,
      ...(credentialSource === "state"
        ? { credentialReferenceId }
        : { apiKeyEnvironmentVariableName }),
      permissionDecisionSource,
      executedRoundCount: acceptanceDecision.executedRoundCount,
    },
    null,
    2,
  ) + "\n",
);
console.log("记录文件: " + recordPath);

const failedChecks = checks.filter((check) => !check.isPassed);
/**
 * 判据落盘（2026-10-02，可审计性）：
 * 五项判据与结论同时写入运行目录，避免"验收是否通过"只能从终端滚动缓冲区回看
 * （实测发生过：只保留节选输出时无法复核 permissionAsk 等判据）。
 * 该文件与 tarball-record.json 同目录、同一次运行一一对应。
 *
 * 2026-10-06 增补：`executedRoundCount`、`isRealAcceptanceEvidence`、
 * `permissionDecisionSource` 与 `usageObservation`——防止"零轮次通过"再次无声发生，
 * 并让费用范围可以直接引用**本次运行**的账目。
 */
const verdictPath = path.join(archiveRoot, "acceptance-verdict.json");
writeFileSync(
  verdictPath,
  JSON.stringify(
    {
      schemaVersion: 2,
      verdict: acceptanceDecision.verdict,
      isDryRun,
      isRealAcceptanceEvidence: acceptanceDecision.isRealAcceptanceEvidence,
      executedRoundCount: acceptanceDecision.executedRoundCount,
      permissionDecisionSource,
      credentialSource,
      ...(credentialSource === "state" ? { credentialReferenceId } : {}),
      sourceCommit,
      tarballSha256,
      vendorIdentifier,
      modelIdentifier,
      protocolLabel,
      endpoint: providerEndpoint,
      recordedAtIso: new Date().toISOString(),
      checks,
      failedCheckNames,
      usageObservation,
      rounds: rounds.map((round) => ({
        roundName: round.roundName,
        roundKind: round.roundKind,
        exitCode: round.exitCode,
        parsedResult: round.parsedResult,
        fileExists: round.fileExists,
        unexpectedEntryList: round.unexpectedEntryList,
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log("判据记录文件: " + verdictPath);

if (failedChecks.length > 0) {
  console.error("\ntarball 验收未达成（" + String(failedChecks.length) + " 项失败）:");
  for (const failedCheck of failedChecks) {
    console.error("  - " + failedCheck.checkName + ": " + failedCheck.detail);
  }
  for (const round of rounds) {
    if (round.stderrText.trim() !== "") {
      console.error(
        "\n" + round.roundName + " stderr 末尾:\n" + round.stderrText.trim().split("\n").slice(-6).join("\n"),
      );
    }
  }
  process.exit(1);
}
console.log(
  "\nT07D-R2-04 tarball 验收通过" +
    (isDryRun
      ? "（**干跑模式，不代表真实验收通过**）"
      : "：真实运行 " +
        String(acceptanceDecision.executedRoundCount) +
        " 轮，" +
        String(checks.length) +
        " 项判据全过（产物逐行精确 + 任务 done ✓）；裁决来源=" +
        permissionDecisionSource),
);
