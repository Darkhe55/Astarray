#!/usr/bin/env node
/**
 * 三入口运行时选择 + 受保护凭据引用的**tarball 级安装验收**。
 *
 * 覆盖 `run` / `gui` / `mcp serve` 三个产品入口在**隔离安装产物**上的行为：
 * 1. `--help` 暴露 `--runtime` / `--provider-*` / `--provider-credential-reference`
 *    / `--runtime-diagnostics-file`（缺参数必须可诊断，不能锁死 mock）；
 * 2. `--runtime openai-compatible` 缺 provider 参数 → **退出码 2** 且 stderr 给出原因
 *    （绝不静默回退 mock）；
 * 3. `config provider` 管理的受保护凭据引用（`<cwd>/.astarray/providers/provider-credentials.json`，
 *    即 CLI 缺省状态目录）被真实选用：诊断报告 `runtimeKind === "provider"` 且记录引用 ID；
 * 4. 引用缺失 → 退出码 2，不写报告（fail-closed）；
 * 5. 未给运行时参数 → 仍为 mock 默认（离线路径未被破坏，且不误报 provider）；
 * 6. 报告为公开诊断面：不得包含凭据值。
 *
 * 用法：
 *   node scripts/verify-entry-runtime-selection.mjs [--tarball <路径>] [--skip-pack]
 *     [--skip-prepack] [--cli-entry <dist/cli.js 路径>]
 *
 * 纪律：`config provider` 目前只有 list/show/doctor（**缺少写入面**），因此本脚本按
 * 受保护凭据存储的公开文件名（`provider-credentials.json`）以 CLI 之外的本地步骤
 * 预置引用；该缺口记入交接残留，不在本检查点内扩面。
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, promises as fsPromises, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runIdentifier = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID();
const consumerRoot = path.join(repositoryRoot, ".tmp", "entry-runtime-selection", runIdentifier);
const packageArchiveRoot = path.join(repositoryRoot, ".tmp", "packages", runIdentifier);
// `defaultStateDirectory()` = <cwd>/.astarray；凭据与报告都落在隔离安装目录内。
const stateDirectory = path.join(consumerRoot, ".astarray");

const argumentsList = process.argv.slice(2);
const skipPack = argumentsList.includes("--skip-pack");
// 门禁（npm run check）单独执行；打包验收不该被套件偶发竞态或重复门禁卡住。
const skipPrepack = argumentsList.includes("--skip-prepack");
const tarballArgumentIndex = argumentsList.indexOf("--tarball");
const explicitTarballPath =
  tarballArgumentIndex >= 0 ? argumentsList[tarballArgumentIndex + 1] : undefined;
const cliEntryArgumentIndex = argumentsList.indexOf("--cli-entry");
const explicitCliEntryPath =
  cliEntryArgumentIndex >= 0 ? argumentsList[cliEntryArgumentIndex + 1] : undefined;

const CHECKS = [];
function recordCheck(checkName, isPassed, detail) {
  CHECKS.push({ checkName, isPassed: Boolean(isPassed), detail: String(detail) });
  console.log(`${isPassed ? "  ✓" : "  ✗"} ${checkName} — ${detail}`);
}
function fail(message) {
  console.error("\n三入口运行时选择安装验收失败: " + message);
  printSummary();
  process.exit(1);
}
function printSummary() {
  const passedCount = CHECKS.filter((check) => check.isPassed).length;
  console.log(`\n检查项: ${passedCount}/${CHECKS.length} 通过`);
}

function resolveTarballPath() {
  if (explicitTarballPath !== undefined) {
    const resolved = path.resolve(explicitTarballPath);
    if (!existsSync(resolved)) fail("指定的 tarball 不存在: " + resolved);
    return resolved;
  }
  const candidates = readdirSync(repositoryRoot)
    .filter((entry) => /^astarray-.*\.tgz$/.test(entry))
    .map((entry) => path.join(repositoryRoot, entry))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (candidates.length === 0) fail("仓库根下找不到 astarray-*.tgz（或显式传 --tarball）");
  return candidates[0];
}

mkdirSync(consumerRoot, { recursive: true });
mkdirSync(packageArchiveRoot, { recursive: true });
mkdirSync(stateDirectory, { recursive: true });

// ── 1. 隔离安装 ────────────────────────────────────────────────────────────────
let cliEntryPath;
if (explicitCliEntryPath !== undefined) {
  cliEntryPath = path.resolve(explicitCliEntryPath);
  if (!existsSync(cliEntryPath)) fail("指定的 CLI 入口不存在: " + cliEntryPath);
  console.log("使用仓库内 CLI 入口（开发模式）: " + cliEntryPath);
} else {
  let tarballPath;
  if (skipPack) {
    tarballPath = resolveTarballPath();
  } else {
    if (skipPrepack) {
      // --skip-prepack 只跳过 npm run check；dist 必须重建，否则会打到过期产物。
      execSync("npm run build", { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
    }
    const prepackFlag = skipPrepack ? " --ignore-scripts" : "";
    const packOutput = execSync(
      `npm pack --json --pack-destination "${packageArchiveRoot}"${prepackFlag}`,
      { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
    )
      .replace(/\u001B\[[0-9;]*m/g, "")
      .trim();
    const packResult = JSON.parse(packOutput.slice(packOutput.indexOf("[")))[0];
    tarballPath = path.join(packageArchiveRoot, packResult.filename);
  }
  const tarballSha256 = execFileSync("node", [
    "-e",
    "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
    tarballPath,
  ])
    .toString()
    .trim();
  console.log("使用 tarball: " + tarballPath);
  console.log("tarball sha256: " + tarballSha256);

  writeFileSync(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ name: "astarray-entry-runtime-consumer", private: true }, null, 2),
  );
  execSync(`npm install "${tarballPath}" --no-audit --no-fund`, {
    cwd: consumerRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  cliEntryPath = path.join(consumerRoot, "node_modules", "astarray", "dist", "cli.js");
  if (!existsSync(cliEntryPath)) fail("隔离安装后找不到 astarray CLI 入口: " + cliEntryPath);
}

// ── 2. 本地协议服务器（记录是否被真实请求） ──────────────────────────────────────
let protocolRequestCount = 0;
// 正式任务运行路径要求版本化完成控制事件（缺事件即被本地门禁判 blocked）。
const completionMarker = JSON.stringify({
  taskExecutionId: "task-exec:install-verify",
  completionAttemptId: "attempt-install-verify-1",
  completedTaskIdentifiers: ["T-001"],
  claimedStatus: "complete",
  taskSequenceRevision: 1,
});
const protocolServer = http.createServer((request, response) => {
  request.on("data", () => {});
  request.on("end", () => {
    protocolRequestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write(
      "data: " +
        JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }) +
        "\n\n",
    );
    response.write(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                content: "本地协议服务器完成。\nASTARRAY_TASK_COMPLETION_V1 " + completionMarker,
              },
              finish_reason: "stop",
            },
          ],
        }) +
        "\n\n",
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
});
await new Promise((resolve) => protocolServer.listen(0, "127.0.0.1", () => resolve()));
const protocolEndpoint =
  "http://127.0.0.1:" + protocolServer.address().port + "/v1/chat/completions";

// 受保护凭据引用：只用公共写入面 `config provider credential-set`（STDIN JSON）预置，
// 不再手工写凭据文件——这样"写入面 → 引用运行"在隔离安装产物上是同一闭环。
const protectedCredentialReferenceId = "cred-ref-install-1";
const protectedApiKeyValue = "install-verify-secret-key";
const protectedEndpointWithQuery =
  protocolEndpoint + "?tenant=install-verify-tenant";

/** 在隔离安装产物上运行 CLI（不经 shell，退出码/stderr 可精确断言）。 */
function runInstalledCli(commandArguments, stdinText) {
  return new Promise((resolve) => {
    const childProcess = spawn(
      process.execPath,
      [cliEntryPath, ...commandArguments],
      {
        cwd: consumerRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", ASTARRAY_MCP_PRINCIPAL: "install-verify:stdio" },
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
    childProcess.stdin.end(stdinText ?? "");
    const killTimer = setTimeout(() => {
      childProcess.kill();
    }, 120_000);
    childProcess.on("close", (exitCode) => {
      clearTimeout(killTimer);
      resolve({ exitCode, stdoutText, stderrText });
    });
  });
}

async function waitForReport(reportFilePath, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const rawContent = await fsPromises.readFile(reportFilePath, "utf8");
      const parsed = JSON.parse(rawContent);
      if (parsed?.entryRuntimeKind !== undefined) {
        return parsed;
      }
    } catch {
      // 尚未写入。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("运行时诊断报告未在期限内写入: " + reportFilePath);
}

/** 启动一个长驻入口，等待其诊断报告，再关闭 stdin 驱动收口。 */
async function runLongRunningEntry(commandArguments, reportFilePath) {
  const childProcess = spawn(process.execPath, [cliEntryPath, ...commandArguments], {
    cwd: consumerRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ASTARRAY_MCP_PRINCIPAL: "install-verify:stdio" },
  });
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
  let report = null;
  try {
    report = await waitForReport(reportFilePath);
  } finally {
    childProcess.stdin.end();
  }
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      childProcess.kill();
    }, 20_000);
    childProcess.on("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
  return { report, stdoutText, stderrText };
}

console.log("\n[1] 受保护凭据写入面（config provider credential-set / register）");
const credentialSetResult = await runInstalledCli(
  ["config", "provider", "credential-set", "--json"],
  JSON.stringify({
    referenceId: protectedCredentialReferenceId,
    baseUrl: protectedEndpointWithQuery,
    apiKey: protectedApiKeyValue,
  }) + "\n",
);
let credentialSetReport = null;
try {
  credentialSetReport = JSON.parse(credentialSetResult.stdoutText);
} catch {
  credentialSetReport = null;
}
recordCheck(
  "credential-set：STDIN → 引用落盘（输出只含引用 ID 与端点主机）",
  credentialSetResult.exitCode === 0 &&
    credentialSetReport?.referenceId === protectedCredentialReferenceId &&
    credentialSetReport?.endpointHost === "127.0.0.1" &&
    credentialSetReport?.apiKeyPresent === true &&
    !JSON.stringify(credentialSetReport).includes(protectedApiKeyValue),
  `退出码 ${credentialSetResult.exitCode}，endpointHost=${String(credentialSetReport?.endpointHost)}`,
);
recordCheck(
  "credential-set：不回显 key、查询串或内联 secret",
  !credentialSetResult.stdoutText.includes(protectedApiKeyValue) &&
    !credentialSetResult.stderrText.includes(protectedApiKeyValue) &&
    !credentialSetResult.stdoutText.includes("install-verify-tenant"),
  "stdout/stderr 均无凭据值与查询串",
);

const providerRegisterResult = await runInstalledCli([
  "config",
  "provider",
  "register",
  "install-verify-provider",
  "--protocol",
  "generic-openai-compatible",
  "--api-version",
  "2024-06-01",
  "--capability",
  "text",
  "tool-calling",
  "--support-level",
  "fake-server-conformant",
  "--credential-reference",
  protectedCredentialReferenceId,
]);
recordCheck(
  "register：引用存在即登记（人读面显示引用 ID）",
  providerRegisterResult.exitCode === 0 &&
    providerRegisterResult.stdoutText.includes("install-verify-provider") &&
    providerRegisterResult.stdoutText.includes(protectedCredentialReferenceId) &&
    !providerRegisterResult.stdoutText.includes(protectedApiKeyValue),
  `退出码 ${providerRegisterResult.exitCode}`,
);

const providerListResult = await runInstalledCli([
  "config",
  "provider",
  "list",
  "--json",
]);
recordCheck(
  "list：公开面列出 Provider 且不含凭据引用",
  providerListResult.exitCode === 0 &&
    providerListResult.stdoutText.includes("install-verify-provider") &&
    !providerListResult.stdoutText.includes(protectedCredentialReferenceId) &&
    !providerListResult.stdoutText.includes(protectedApiKeyValue),
  `退出码 ${providerListResult.exitCode}`,
);

const providerDoctorResult = await runInstalledCli([
  "doctor",
  "--provider",
  "install-verify-provider",
  "--json",
]);
let providerDoctorReport = null;
try {
  providerDoctorReport = JSON.parse(providerDoctorResult.stdoutText);
} catch {
  providerDoctorReport = null;
}
recordCheck(
  "doctor --provider：引用已解析（写入面 → 读取面闭环）",
  providerDoctorResult.exitCode === 0 &&
    providerDoctorReport?.credentialReferenceResolved === true &&
    !providerDoctorResult.stdoutText.includes(protectedApiKeyValue),
  `退出码 ${providerDoctorResult.exitCode}，credentialReferenceResolved=${String(providerDoctorReport?.credentialReferenceResolved)}`,
);

const missingReferenceRegisterResult = await runInstalledCli([
  "config",
  "provider",
  "register",
  "ghost-provider",
  "--protocol",
  "generic-openai-compatible",
  "--api-version",
  "2024-06-01",
  "--capability",
  "text",
  "--support-level",
  "adapter-only",
  "--credential-reference",
  "cred-ref-absent",
]);
recordCheck(
  "register：引用不存在 → 退出码 2，不登记",
  missingReferenceRegisterResult.exitCode === 2 &&
    missingReferenceRegisterResult.stderrText.includes("受保护凭据引用不存在"),
  `退出码 ${missingReferenceRegisterResult.exitCode}`,
);

console.log("\n[2] --help 必须暴露运行时选择与受保护凭据引用选项");
for (const commandArguments of [["gui", "--help"], ["mcp", "serve", "--help"]]) {
  const helpResult = await runInstalledCli(commandArguments);
  const helpText = helpResult.stdoutText + helpResult.stderrText;
  const requiredOptions = [
    "--runtime",
    "--provider-endpoint",
    "--provider-model",
    "--provider-credential-reference",
    "--runtime-diagnostics-file",
  ];
  const missingOptions = requiredOptions.filter((option) => !helpText.includes(option));
  recordCheck(
    `help ${commandArguments.join(" ")}`,
    helpResult.exitCode === 0 && missingOptions.length === 0,
    missingOptions.length === 0
      ? `退出码 ${helpResult.exitCode}，选项齐全`
      : `缺少选项: ${missingOptions.join(", ")}`,
  );
}

console.log("\n[3] 缺 provider 参数必须 fail-closed（退出码 2，不回退 mock）");
const missingParameterCases = [
  { commandArguments: ["gui", "--runtime", "openai-compatible"], expectedReason: "provider-endpoint" },
  {
    commandArguments: ["mcp", "serve", "--runtime", "openai-compatible"],
    expectedReason: "provider-endpoint",
  },
  {
    commandArguments: [
      "gui",
      "--runtime",
      "openai-compatible",
      "--provider-endpoint",
      protocolEndpoint,
    ],
    expectedReason: "provider-model",
  },
  {
    commandArguments: [
      "mcp",
      "serve",
      "--runtime",
      "openai-compatible",
      "--provider-model",
      "fake-model",
    ],
    expectedReason: "provider-endpoint",
  },
];
for (const testCase of missingParameterCases) {
  const result = await runInstalledCli(testCase.commandArguments);
  const reasonReported = result.stderrText.includes(testCase.expectedReason);
  recordCheck(
    `缺参 ${testCase.commandArguments[0]} → 退出码 2`,
    result.exitCode === 2 && reasonReported,
    `退出码 ${result.exitCode}，stderr ${reasonReported ? "含" : "缺少"} ${testCase.expectedReason}`,
  );
}

console.log("\n[4] 受保护凭据引用被选用（gui / mcp serve）");
for (const entryName of ["gui", "mcp"]) {
  const reportFilePath = path.join(stateDirectory, `runtime-diagnostics-${entryName}.json`);
  const commandArguments =
    entryName === "gui"
      ? [
          "gui",
          "--no-open",
          "--port",
          "0",
          "--runtime",
          "openai-compatible",
          "--provider-model",
          "fake-model",
          "--provider-credential-reference",
          protectedCredentialReferenceId,
        ]
      : [
          "mcp",
          "serve",
          "--runtime",
          "openai-compatible",
          "--provider-model",
          "fake-model",
          "--provider-credential-reference",
          protectedCredentialReferenceId,
        ];
  const { report, stdoutText, stderrText } = await runLongRunningEntry(
    [...commandArguments, "--runtime-diagnostics-file", reportFilePath],
    reportFilePath,
  );
  const isProviderSelected =
    report?.entryRuntimeKind === "provider" &&
    report?.providerId === "openai-compatible" &&
    report?.protectedCredentialReferenceId === protectedCredentialReferenceId &&
    report?.runtimeDiagnostics?.runtimeKind === "provider";
  recordCheck(
    `${entryName}：引用路径被选用`,
    isProviderSelected,
    JSON.stringify({
      entryRuntimeKind: report?.entryRuntimeKind,
      providerId: report?.providerId,
      protectedCredentialReferenceId: report?.protectedCredentialReferenceId,
      runtimeKind: report?.runtimeDiagnostics?.runtimeKind,
    }),
  );
  const serializedReport = JSON.stringify(report);
  recordCheck(
    `${entryName}：报告不含凭据值`,
    !serializedReport.includes(protectedApiKeyValue),
    serializedReport.includes(protectedApiKeyValue) ? "报告泄漏了凭据值" : "未出现凭据值",
  );
  recordCheck(
    `${entryName}：报告不含端点内联 secret`,
    !serializedReport.toLowerCase().includes("apikey"),
    serializedReport.toLowerCase().includes("apikey") ? "报告含 apiKey 字段" : "无 apiKey 字段",
  );
  if (stderrText.trim() !== "") {
    console.log(`    （${entryName} stderr）: ${stderrText.trim().split("\n")[0]}`);
  }
  void stdoutText;
}

console.log("\n[5] 引用缺失 → 退出码 2 且不写报告（fail-closed）");
const missingReferenceReportPath = path.join(stateDirectory, "runtime-diagnostics-missing.json");
const missingReferenceResult = await runInstalledCli([
  "gui",
  "--no-open",
  "--runtime",
  "openai-compatible",
  "--provider-model",
  "fake-model",
  "--provider-credential-reference",
  "cred-ref-does-not-exist",
  "--runtime-diagnostics-file",
  missingReferenceReportPath,
]);
recordCheck(
  "引用缺失 → 退出码 2 且 stderr 给出原因",
  missingReferenceResult.exitCode === 2 &&
    missingReferenceResult.stderrText.includes("受保护凭据引用不存在"),
  `退出码 ${missingReferenceResult.exitCode}`,
);
recordCheck(
  "引用缺失 → 不写报告",
  !existsSync(missingReferenceReportPath),
  existsSync(missingReferenceReportPath) ? "仍写入了报告" : "未写入报告",
);

console.log("\n[6] 未给运行时参数 → mock 默认（离线路径未被破坏，不误报 provider）");
const mockReportPath = path.join(stateDirectory, "runtime-diagnostics-mock.json");
const mockResult = await runLongRunningEntry(
  ["gui", "--no-open", "--port", "0", "--runtime-diagnostics-file", mockReportPath],
  mockReportPath,
);
recordCheck(
  "无 --runtime → 报告 mock 且 providerId 为 null",
  mockResult.report?.entryRuntimeKind === "mock" && mockResult.report?.providerId === null,
  JSON.stringify({
    entryRuntimeKind: mockResult.report?.entryRuntimeKind,
    providerId: mockResult.report?.providerId,
  }),
);

console.log("\n[7] run 入口同源：受保护引用可驱动任务到 done（真实 HTTP 请求）");
const runResult = await runInstalledCli([
  "run",
  "安装验收探针",
  "--mode",
  "assist",
  "--runtime",
  "openai-compatible",
  "--provider-model",
  "fake-model",
  "--provider-credential-reference",
  protectedCredentialReferenceId,
  "--json",
]);
let runStatus = null;
try {
  runStatus = JSON.parse(runResult.stdoutText).status;
} catch {
  runStatus = null;
}
recordCheck(
  "run --provider-credential-reference → status=done",
  runResult.exitCode === 0 && runStatus === "done",
  `退出码 ${runResult.exitCode}，status=${String(runStatus)}，stderr=${runResult.stderrText.trim().split("\n")[0] ?? ""}`,
);
recordCheck(
  "受保护引用驱动的端点收到真实请求",
  protocolRequestCount > 0,
  `协议服务器请求数 ${protocolRequestCount}`,
);

await new Promise((resolve) => protocolServer.close(() => resolve()));

printSummary();
const failedChecks = CHECKS.filter((check) => !check.isPassed);
if (failedChecks.length > 0) {
  console.error("\n失败检查项:");
  for (const failedCheck of failedChecks) {
    console.error(`  - ${failedCheck.checkName}: ${failedCheck.detail}`);
  }
  process.exit(1);
}
console.log("\n三入口运行时选择 + 受保护凭据引用安装验收通过 ✓");
