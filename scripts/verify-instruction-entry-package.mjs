/**
 * SMART-01-04 **包级验收**：指令窗口入口在 **tarball 隔离安装** 后必须真实可用。
 *
 * AGENTS.md：「打包验收必须以 tarball 隔离安装为准。」卡内 SMART-01-04 验收含
 * "SDK/CLI/TUI/GUI 入口和包验收"，本脚本补的是**包级**那一项（四入口接线已另有测试证据）。
 *
 * 流程：
 *  1. `npm pack --ignore-scripts` 生成 tarball（`--run-prepack` 可显式开启 prepack）；
 *  2. 在 `.tmp/instruction-package-acceptance/<runId>/install` **隔离安装**；
 *  3. 用**已安装包的** CLI 实跑 `instruction accept ×4 / list / deadline / deadline(未知键)`；
 *  4. 判定交给纯函数模块 `scripts/lib/smart01-instruction-package-checks.mjs`
 *     （可单测的不变量；**缺省即失败**，不会"零判据通过"）；
 *  5. 写出 acceptance-verdict.json（含 tarball sha256、字节数、来源提交，可审计）。
 *
 * 纪律：本脚本**不申请任何权限、不联网、不使用 Provider 凭据**；只用本地 mock/fixture 路径。
 *
 * 用法：
 *   node scripts/verify-instruction-entry-package.mjs
 *   node scripts/verify-instruction-entry-package.mjs --run-prepack
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  installTarballIsolated,
  packTarball,
  readSourceCommit,
  runInstalledCli,
} from "./lib/package-acceptance-runtime.mjs";
import { buildInstructionPackageChecks } from "./lib/smart01-instruction-package-checks.mjs";

const repositoryRoot = process.cwd();
const verificationRunIdentifier = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceRoot = path.join(
  repositoryRoot,
  ".tmp",
  "instruction-package-acceptance",
  verificationRunIdentifier,
);
const installRoot = path.join(acceptanceRoot, "install");
const packageArchiveRoot = path.join(acceptanceRoot, "packages");
const shouldRunPrepack = process.argv.includes("--run-prepack");

/** 固定的确定性接收时间，使"期限内/超期"两个观测可复现。 */
const ACCEPTED_AT_ISO = "2026-10-10T00:00:00.000Z";
const WITHIN_DEADLINE_ISO = "2026-10-10T00:02:59.000Z";
const OVERDUE_ISO = "2026-10-10T00:03:01.000Z";

console.log("=== SMART-01-04 包级验收：指令窗口入口（tarball 隔离安装）===");

const tarball = packTarball({
  archiveDirectory: packageArchiveRoot,
  shouldRunPrepack,
});
const sourceCommit = readSourceCommit();
console.log(
  `tarball: ${tarball.tarballFileName}（${tarball.tarballByteCount} 字节，sha256=${tarball.tarballSha256.slice(0, 16)}…）`,
);
console.log(`来源提交: ${sourceCommit}`);

const cliEntryPath = installTarballIsolated({
  installDirectory: installRoot,
  packageName: "astarray-instruction-acceptance",
  tarballPath: tarball.tarballPath,
});
const isInstalled = existsSync(cliEntryPath);
console.log(`${isInstalled ? "✓" : "✗"} 隔离安装 — dist/cli.js ${isInstalled ? "存在" : "缺失"}`);

function runInstalled(argumentsList) {
  return runInstalledCli({
    cliEntryPath,
    workingDirectory: installRoot,
    argumentsList,
  });
}

// ① 单条准入
const admitResult = runInstalled([
  "instruction",
  "accept",
  "包级验收指令 1",
  "--idempotency-key",
  "pkg-1",
  "--now",
  ACCEPTED_AT_ISO,
  "--json",
]);

// ② 补满窗口（2、3）
for (const index of [2, 3]) {
  runInstalled([
    "instruction",
    "accept",
    "包级验收指令 " + String(index),
    "--idempotency-key",
    "pkg-" + String(index),
    "--now",
    ACCEPTED_AT_ISO,
    "--json",
  ]);
}

// ③ 第 4 条必须排队
const fourthAdmit = runInstalled([
  "instruction",
  "accept",
  "包级验收指令 4",
  "--idempotency-key",
  "pkg-4",
  "--now",
  ACCEPTED_AT_ISO,
  "--json",
]);

// ④ 列表
const listResult = runInstalled(["instruction", "list", "--json"]);

// ⑤ 期限内 / 超期
const withinDeadline = runInstalled([
  "instruction",
  "deadline",
  "--idempotency-key",
  "pkg-4",
  "--now",
  WITHIN_DEADLINE_ISO,
  "--json",
]);
const overdueDeadline = runInstalled([
  "instruction",
  "deadline",
  "--idempotency-key",
  "pkg-4",
  "--now",
  OVERDUE_ISO,
  "--json",
]);

// ⑥ 未知幂等键必须响亮失败
const unknownKey = runInstalled([
  "instruction",
  "deadline",
  "--idempotency-key",
  "pkg-unknown",
  "--json",
]);

const checks = buildInstructionPackageChecks({
  admitResult,
  fourthAdmit,
  listResult,
  withinDeadline,
  overdueDeadline,
  unknownKey,
});
for (const check of checks) {
  console.log(`${check.passed ? "✓" : "✗"} ${check.name} — ${check.detail}`);
}

const failedCheckNames = checks.filter((check) => !check.passed).map((check) => check.name);
const verdict = {
  schemaVersion: 1,
  generatedAtIso: new Date().toISOString(),
  sourceCommit,
  tarballFileName: tarball.tarballFileName,
  tarballSha256: tarball.tarballSha256,
  tarballByteCount: tarball.tarballByteCount,
  isPrepackEnabled: shouldRunPrepack,
  isIsolatedInstallSucceeded: isInstalled,
  checks,
  failedCheckNames,
  isPassed: isInstalled && failedCheckNames.length === 0,
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
