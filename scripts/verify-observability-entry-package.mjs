/**
 * OBS/SMART/PROJECT 三卡的**包级验收**（SMART-01-04 缺口补做）。
 *
 * AGENTS.md：「打包验收必须以 tarball 隔离安装为准。」
 *
 * 流程：
 *  1. `npm pack --ignore-scripts` 生成 tarball（`--run-prepack` 可显式开启 prepack）；
 *  2. 在 `.tmp/entry-acceptance/<runId>/install` 中**隔离安装**（写入独立 package.json）；
 *  3. 记录 tarball 的 SHA256、字节数与来源提交；
 *  4. 用**已安装包的** CLI 实跑四个入口命令，断言退出码与输出内容；
 *  5. 断言只读性：运行 `perf/usage/doctor/cross-project` 概览后，**不得创建 `.astarray` 状态目录**；
 *  6. 写出 acceptance-verdict.json（可审计）。
 *
 * 机械步骤（解析 npm-cli.js、打包、隔离安装、实跑已安装 CLI、tarball 指纹）已收敛到
 * `scripts/lib/package-acceptance-runtime.mjs`，避免多张卡的验收脚本各自漂移。
 *
 * 用法：
 *   node scripts/verify-observability-entry-package.mjs
 *   node scripts/verify-observability-entry-package.mjs --run-prepack
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  installTarballIsolated,
  packTarball,
  readSourceCommit,
  runInstalledCli,
} from "./lib/package-acceptance-runtime.mjs";

const repositoryRoot = process.cwd();
const verificationRunIdentifier = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceRoot = path.join(
  repositoryRoot,
  ".tmp",
  "entry-acceptance",
  verificationRunIdentifier,
);
const installRoot = path.join(acceptanceRoot, "install");
const packageArchiveRoot = path.join(acceptanceRoot, "packages");

const shouldRunPrepack = process.argv.includes("--run-prepack");
const checks = [];

function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✓" : "✗"} ${name} — ${detail}`);
}

function runInstalledCliInAcceptance(argumentsList) {
  const cliEntryPath = path.join(installRoot, "node_modules", "astarray", "dist", "cli.js");
  return runInstalledCli({
    cliEntryPath,
    // cwd = 隔离安装目录：CLI 的 defaultStateDirectory() 为 cwd/.astarray
    workingDirectory: installRoot,
    argumentsList,
  });
}

console.log("=== 包级验收：OBS/SMART/PROJECT 入口（tarball 隔离安装）===");

// 1. 生成 tarball（默认 --ignore-scripts：prepack 会跑整门禁，导致不可复现的哈希）
const tarball = packTarball({
  archiveDirectory: packageArchiveRoot,
  shouldRunPrepack,
});
const sourceCommit = readSourceCommit();
console.log(
  `tarball: ${tarball.tarballFileName}（${tarball.tarballByteCount} 字节，sha256=${tarball.tarballSha256.slice(0, 16)}…）`,
);
console.log(`来源提交: ${sourceCommit}`);

// 2. 隔离安装
const cliEntryPath = installTarballIsolated({
  installDirectory: installRoot,
  packageName: "astarray-entry-acceptance",
  tarballPath: tarball.tarballPath,
});
record("隔离安装成功", existsSync(cliEntryPath), "node_modules/astarray/dist/cli.js 存在");

// 3. 四入口实跑（已安装包的 CLI）
const perfOverview = runInstalledCliInAcceptance(["perf", "overview", "--json"]);
record(
  "入口：perf overview --json",
  perfOverview.exitCode === 0 && perfOverview.stdoutText.includes("totalSampleCount"),
  `exit=${perfOverview.exitCode}`,
);

const usageOverview = runInstalledCliInAcceptance(["usage", "overview", "--json"]);
record(
  "入口：usage overview --json",
  usageOverview.exitCode === 0 &&
    usageOverview.stdoutText.includes("disclaimer") &&
    usageOverview.stdoutText.includes("官方"),
  `exit=${usageOverview.exitCode}`,
);

const doctorErrors = runInstalledCliInAcceptance(["doctor", "--errors", "--json"]);
record(
  "入口：doctor --errors --json",
  doctorErrors.exitCode === 0 &&
    doctorErrors.stdoutText.includes("unreportableReason") &&
    doctorErrors.stdoutText.includes("suspectedFindings"),
  `exit=${doctorErrors.exitCode}`,
);

const doctorBundle = runInstalledCliInAcceptance(["doctor", "--bundle", "--json"]);
record(
  "入口：doctor --bundle --json（脱敏且不落盘）",
  doctorBundle.exitCode === 0 && doctorBundle.stdoutText.includes("containsFullSession"),
  `exit=${doctorBundle.exitCode}`,
);

const crossProjectList = runInstalledCliInAcceptance(["cross-project", "list", "--json"]);
record(
  "入口：cross-project list --json",
  crossProjectList.exitCode === 0 &&
    crossProjectList.stdoutText.includes("copyReceipts"),
  `exit=${crossProjectList.exitCode}`,
);

// 4. 只读性：概览查询不得创建状态目录
const stateDirectoryPath = path.join(installRoot, ".astarray");
record(
  "只读性：概览查询未创建 .astarray 状态目录",
  !existsSync(stateDirectoryPath),
  existsSync(stateDirectoryPath) ? ".astarray 被创建（违反只读）" : "未创建",
);

// 5. 非法参数仍为用法错误
const usageError = runInstalledCliInAcceptance(["perf", "overview", "--detail", "verbose"]);
record("非法参数返回用法错误（退出码 2）", usageError.exitCode === 2, `exit=${usageError.exitCode}`);

// 6. 判定与落盘
const failedCheckNames = checks.filter((check) => !check.passed).map((check) => check.name);
const verdict = {
  schemaVersion: 1,
  generatedAtIso: new Date().toISOString(),
  sourceCommit,
  tarballFileName: tarball.tarballFileName,
  tarballSha256: tarball.tarballSha256,
  tarballByteCount: tarball.tarballByteCount,
  isPrepackEnabled: shouldRunPrepack,
  checks,
  failedCheckNames,
  isPassed: failedCheckNames.length === 0,
};
writeFileSync(
  path.join(acceptanceRoot, "acceptance-verdict.json"),
  JSON.stringify(verdict, null, 2) + "\n",
  "utf8",
);

console.log("");
console.log(
  `验收结论: ${verdict.isPassed ? "通过" : "未通过"}（${checks.length - failedCheckNames.length}/${checks.length} 项）`,
);
console.log(
  `判据落盘: ${path.relative(repositoryRoot, path.join(acceptanceRoot, "acceptance-verdict.json"))}`,
);
if (!verdict.isPassed) {
  console.log(`未通过项: ${failedCheckNames.join("、")}`);
  process.exitCode = 1;
}

// 清理安装目录（保留 verdict 与 tarball 记录以便审计）
try {
  rmSync(installRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
} catch {
  // 清理失败不影响验收结论
}
