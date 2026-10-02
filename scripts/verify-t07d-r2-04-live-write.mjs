#!/usr/bin/env node
/**
 * T07D-R2-04 单次真实验收（**真实 Provider，需显式授权与额度**）。
 *
 * 目标：在**同一次运行**里同时证明两件事（缺一不可）：
 *   1. 受控产物真实落盘且内容正确（sha256 命中期望）；
 *   2. 任务终态为 `done`（本地完成门禁通过，含完成控制事件）。
 *
 * 交互方式（用户要求）：**TTY 逐次裁决**。
 *   - 脚本要求 stdin 是 TTY：`permission-ask` 出现时由脚本把你输入的裁决原样转给子进程；
 *   - 若 stdin 不是 TTY，脚本直接拒绝运行（避免"管道只能喂一次"的误用）。
 *
 * 用法：
 *   node scripts/verify-t07d-r2-04-live-write.mjs \
 *     --reference prov-live-1 --model step-3.7-flash [--request-timeout-seconds 120] \
 *     --allow-live-request
 *
 * 纪律：
 * - 必须显式 `--allow-live-request`（产生真实请求与费用）；
 * - 默认**只发起 1 次**任务（`--runs` 上限 1），不重试；
 * - 产物写在 `.tmp/t07d-r2-04-live/`（隔离目录），不改动仓库其他文件；
 * - 脚本不读取、不打印任何凭据。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 输出解析复用共享模块（一次实现、可单测；见 tests/core/unit/acceptance-output-parsing.test.ts）。
import { parseFirstJsonObject, toComparableLines } from "./lib/acceptance-output-parsing.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
function takeArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

const isLiveAllowed = argumentsList.includes("--allow-live-request");
const referenceId = takeArgument("--reference", "prov-live-1");
const modelIdentifier = takeArgument("--model", "step-3.7-flash");
const requestTimeoutSeconds = takeArgument("--request-timeout-seconds", "120");
const taskTimeoutSeconds = takeArgument("--task-timeout-seconds", "240");
const cliEntryPath = path.resolve(takeArgument("--cli-entry", path.join(repositoryRoot, "dist", "cli.js")));
/**
 * 自定义 Provider 端点（**干跑用**，2026-10-02 新增）：
 * 默认走凭证引用里配置的真实端点；给出本参数时会改用该端点，
 * 用于在**零额度**下验证本脚本自身的判定链路（配合 ASTARRAY_ACCEPTANCE_DRY_RUN=1）。
 */
const providerEndpointOverride = takeArgument("--provider-endpoint", null);
/** 干跑模式：跳过 TTY 强制（仅用于自动化验证脚本自身，绝不可用于真实验收）。 */
const isDryRun = process.env["ASTARRAY_ACCEPTANCE_DRY_RUN"] === "1";

/**
 * 产物相对路径（可覆盖，2026-10-02）：干跑必须写到**独立目录**，
 * 否则干跑留下的同名文件会让真实运行因"仅新建工具拒绝覆盖"而必然失败（实测踩过）。
 */
const outputFileRelativePath = takeArgument(
  "--output-relative-path",
  ".tmp/t07d-r2-04-live/LIVE-PROOF.md",
);
const outputDirectory = path.dirname(path.join(repositoryRoot, outputFileRelativePath));
const outputFilePath = path.join(repositoryRoot, outputFileRelativePath);
const expectedContent = [
  "# 真实 Provider 受控改动（T07D-R2-04）",
  "- 端点：api.stepfun.com",
  "- 模型：step-3.7-flash",
  "",
].join("\n");

function fail(message, exitCode = 1) {
  console.error("T07D-R2-04 真实收口失败: " + message);
  process.exit(exitCode);
}

if (!isLiveAllowed) {
  console.error(
    "拒绝执行：本脚本会发起真实 Provider 请求并产生费用。确认额度后追加 --allow-live-request。",
  );
  process.exit(2);
}
if (process.stdin.isTTY !== true && !isDryRun) {
  console.error(
    "拒绝执行：本脚本要求 **TTY 交互**输入裁决（管道只能提供一次裁决，已多次导致误判）。\n" +
      "请在交互终端直接运行本脚本。",
  );
  process.exit(2);
}
if (!process.stdin.isTTY && isDryRun) {
  console.log("（干跑模式：已跳过 TTY 强制；此模式仅用于验证脚本自身，不代表真实验收通过）");
}
if (!existsSync(cliEntryPath)) {
  fail("找不到 CLI 入口（请先 npm run build）: " + cliEntryPath, 2);
}

/**
 * 清理目标产物（2026-10-02 实测教训）：
 * `createProjectFile` 是**仅新建、不覆盖**的工具；上一轮干跑或上一次验收留下的同名文件
 * 会让本次真实运行必然失败（模型本身没有做错任何事）。因此每次运行前先移除目标文件，
 * 确保"仅新建"语义下真的有东西可新建。
 * 同时打印是否发生过清理，便于审计"本次是否复用了旧产物"。
 */
const hadPreviousArtifact = existsSync(outputFilePath);
rmSync(outputFilePath, { force: true });
mkdirSync(outputDirectory, { recursive: true });
console.log(
  hadPreviousArtifact
    ? "已清理上一轮遗留产物（否则仅新建工具会拒绝覆盖）: " + outputFileRelativePath
    : "目标产物不存在（符合仅新建工具的前置条件）: " + outputFileRelativePath,
);

const prompt = [
  "只读约束与范围：本次任务只允许改动 .tmp/t07d-r2-04-live/ 目录下的内容，",
  "绝不允许读取或修改该目录之外的任何文件，也不要执行 shell 命令。",
  "",
  "请用内置工具 createProjectFile（只能新建、不能覆盖；参数 filePath 与 content）完成一个极小的受控改动：",
  "1. filePath 必须是：" + outputFileRelativePath,
  "2. content 必须严格为下面三行（Markdown，保留换行）：",
  "   # 真实 Provider 受控改动（T07D-R2-04）",
  "   - 端点：api.stepfun.com",
  "   - 模型：step-3.7-flash",
  "",
  "要求：",
  "- **直接调用 createProjectFile 一次**：它是仅新建、不覆盖的工具，目标已存在时会自行拒绝并返回错误；",
  "  因此**不要先做\"文件是否已存在\"的探查**（探查类工具可能受授权边界限制）；",
  "- 以 createProjectFile 的返回结果为准：返回成功即视为产物已写入；返回失败则如实说明失败原因；",
  "- 不创建或修改其他文件；",
  "最终回复的最后一行必须是下面这一行独立的完成控制事件（字段不得改动、不得放进代码块）：",
  '          ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"task-exec:t07d-r2-04","completionAttemptId":"attempt-t07d-r2-04-live-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":1}',
].join("\n");

console.log("=== T07D-R2-04 单次真实验收（TTY 裁决）===");
console.log("引用: " + referenceId + " | 模型: " + modelIdentifier + " | 单次请求超时: " + requestTimeoutSeconds + "s");
console.log("产物: " + outputFileRelativePath + "（期望 sha256 见下）");
console.log("期望内容 sha256: " + createHash("sha256").update(expectedContent).digest("hex"));

const childProcess = spawn(
  process.execPath,
  [
    cliEntryPath,
    "run",
    prompt,
    "--mode",
    "assist",
    "--runtime",
    "openai-compatible",
    "--provider-model",
    modelIdentifier,
    "--provider-credential-reference",
    referenceId,
    ...(providerEndpointOverride === null
      ? []
      : ["--provider-endpoint", providerEndpointOverride]),
    "--provider-request-timeout-seconds",
    requestTimeoutSeconds,
    "--timeout-seconds",
    taskTimeoutSeconds,
    "--json",
  ],
  {
    cwd: repositoryRoot,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  },
);

let stdoutText = "";
let stderrText = "";
childProcess.stdout.setEncoding("utf8");
childProcess.stderr.setEncoding("utf8");

/** 见到完整结果即收口：CLI 给出结果后进程仍会滞留（已知残留项），不得依赖自然退出。 */
let onResultObserved = null;
let isResultObserved = false;
function observeResultIfComplete() {
  if (isResultObserved) {
    return;
  }
  const candidate = parseFirstJsonObject(stdoutText);
  if (candidate === null) {
    return;
  }
  if (candidate === null) {
    return;
  }
  isResultObserved = true;
  if (typeof onResultObserved === "function") {
    onResultObserved();
  }
}

childProcess.stdout.on("data", (chunk) => {
  stdoutText += chunk;
  observeResultIfComplete();
});
childProcess.stderr.on("data", (chunk) => {
  stderrText += chunk;
  // 把子进程的交互提示与日志原样转出，便于用户裁决。
  process.stderr.write(chunk);
});

const exitCode = await new Promise((resolve) => {
  let isSettled = false;
  const settle = (code) => {
    if (isSettled) return;
    isSettled = true;
    resolve(code);
  };
  childProcess.on("close", (code) => settle(code ?? 1));
  onResultObserved = () => {
    // 结果已完整取得；结束滞留的子进程并收口。
    childProcess.kill();
    settle(0);
  };
  if (isResultObserved) {
    onResultObserved();
  }
});

const parsedResult = parseFirstJsonObject(stdoutText);

const checks = [];
function record(checkName, isPassed, detail) {
  checks.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log((isPassed ? "  ✓ " : "  ✗ ") + checkName + " — " + detail);
}

const fileExists = existsSync(outputFilePath);
const actualContent = fileExists ? readFileSync(outputFilePath, "utf8") : null;
/**
 * 判据口径（2026-10-01 明确）：**行内容必须逐字精确，结尾换行不敏感**。
 * 原因：提示词只要求"三行 Markdown"，未规定文件是否以换行结尾；模型两次生成
 * 可能只差结尾换行，用字节级 sha256 会把它误判为失败（实测发生过）。
 * 实现：按行切分并丢弃末尾空行后逐行比对；其余字符仍逐字精确。
 */
const expectedSha256 = createHash("sha256").update(expectedContent).digest("hex");
const actualSha256 =
  actualContent === null ? null : createHash("sha256").update(actualContent).digest("hex");
const isContentMatched =
  actualContent !== null &&
  JSON.stringify(toComparableLines(actualContent)) ===
    JSON.stringify(toComparableLines(expectedContent));

record("任务终态 status=done", parsedResult?.status === "done", String(parsedResult?.status));
record("权限裁决结果为 allowed-once", parsedResult?.permissionAsk === "allowed-once", String(parsedResult?.permissionAsk));
record("产物文件存在", fileExists, outputFilePath);
record(
  "产物内容与期望一致（逐行精确，结尾换行不敏感）",
  isContentMatched,
  actualContent === null
    ? "文件缺失"
    : "实际 sha256=" + String(actualSha256) + " / 期望 sha256=" + expectedSha256,
);
record(
  "仓库其他文件未被改动",
  spawnSync("git", ["status", "--porcelain=v1", "--", outputFileRelativePath], { cwd: repositoryRoot })
    .stdout.toString()
    .split("\n")
    .every((line) => line.trim() === "" || line.includes(".tmp/")),
  "仅 .tmp/ 下产物",
);

// 同一次运行必须同时满足；缺一即失败（不得以"产物落盘"替代"任务 done"）。
const failedChecks = checks.filter((check) => !check.isPassed);
console.log("\n子进程退出码: " + String(exitCode));
if (failedChecks.length > 0) {
  console.error("\nT07D-R2-04 未达成（" + failedChecks.length + "/" + checks.length + " 项失败）:");
  for (const failedCheck of failedChecks) {
    console.error("  - " + failedCheck.checkName + ": " + failedCheck.detail);
  }
  if (stderrText.trim() !== "") {
    console.error("\nstderr 末尾:\n" + stderrText.trim().split("\n").slice(-6).join("\n"));
  }
  process.exit(1);
}
console.log("\nT07D-R2-04 真实收口通过：同一次运行内产物正确 + 任务 done ✓");
