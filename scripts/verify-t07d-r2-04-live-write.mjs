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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const outputDirectory = path.join(repositoryRoot, ".tmp", "t07d-r2-04-live");
const outputFileRelativePath = ".tmp/t07d-r2-04-live/LIVE-PROOF.md";
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
if (process.stdin.isTTY !== true) {
  console.error(
    "拒绝执行：本脚本要求 **TTY 交互**输入裁决（管道只能提供一次裁决，已多次导致误判）。\n" +
      "请在交互终端直接运行本脚本。",
  );
  process.exit(2);
}
if (!existsSync(cliEntryPath)) {
  fail("找不到 CLI 入口（请先 npm run build）: " + cliEntryPath, 2);
}

mkdirSync(outputDirectory, { recursive: true });

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
childProcess.stdout.on("data", (chunk) => {
  stdoutText += chunk;
});
childProcess.stderr.on("data", (chunk) => {
  stderrText += chunk;
  // 把子进程的交互提示与日志原样转出，便于用户裁决。
  process.stderr.write(chunk);
});

const exitCode = await new Promise((resolve) => {
  childProcess.on("close", (code) => resolve(code ?? 1));
});

let parsedResult = null;
try {
  parsedResult = JSON.parse(stdoutText.trim().split("\n").at(-1) ?? "null");
} catch {
  parsedResult = null;
}

const checks = [];
function record(checkName, isPassed, detail) {
  checks.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log((isPassed ? "  ✓ " : "  ✗ ") + checkName + " — " + detail);
}

const fileExists = existsSync(outputFilePath);
const actualContent = fileExists ? readFileSync(outputFilePath, "utf8") : null;
const actualSha256 =
  actualContent === null ? null : createHash("sha256").update(actualContent).digest("hex");
const expectedSha256 = createHash("sha256").update(expectedContent).digest("hex");

record("任务终态 status=done", parsedResult?.status === "done", String(parsedResult?.status));
record("权限裁决结果为 allowed-once", parsedResult?.permissionAsk === "allowed-once", String(parsedResult?.permissionAsk));
record("产物文件存在", fileExists, outputFilePath);
record("产物内容与期望一致（含 sha256）", actualSha256 === expectedSha256, String(actualSha256));
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
