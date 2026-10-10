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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

import {
  installTarballIsolated,
  packTarball,
  readSourceCommit,
  runInstalledCli,
} from "./lib/package-acceptance-runtime.mjs";
import {
  buildCrossProjectPackageChecks,
  buildInstructionPackageChecks,
} from "./lib/smart01-instruction-package-checks.mjs";

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

// ─── PROJECT-01-04：跨项目只读 / 副本导入（同一 tarball 内）───
// 授权用**已安装包**的公开 SDK 写入；随后的只读/导入走**已安装包**的 CLI。
const crossProjectRoot = path.join(installRoot, "cross-project");
const sourceAbsolutePath = path.join(crossProjectRoot, "project-a", "docs", "spec.md");
const targetAbsolutePath = path.join(crossProjectRoot, "project-b", "docs", "spec-copy.md");
const occupiedTargetPath = path.join(crossProjectRoot, "project-b", "docs", "occupied.md");
const sourceContent = "# 包级验收来源内容\n";
const occupiedContent = "# 人工已有内容（不得被覆盖）\n";
mkdirSync(path.dirname(sourceAbsolutePath), { recursive: true });
mkdirSync(path.dirname(targetAbsolutePath), { recursive: true });
writeFileSync(sourceAbsolutePath, sourceContent, "utf8");
writeFileSync(occupiedTargetPath, occupiedContent, "utf8");

const installedSdkUrl = pathToFileURL(
  path.join(installRoot, "node_modules", "astarray", "dist", "public-sdk.js"),
).href;
try {
  const installedSdk = await import(installedSdkUrl);
  const store = new installedSdk.CrossProjectAuthorizationStore({
    baseDirectory: path.join(installRoot, ".astarray"),
  });
  const grantBase = {
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 3,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "package-acceptance-user",
    taskIdentifier: "T-PKG-001",
  };
  await store.grantAuthorization({
    ...grantBase,
    authorizationIdentifier: "pkg-auth-read",
    operationKind: "read",
    argumentsHash: "pkg-hash-read",
  });
  await store.grantAuthorization({
    ...grantBase,
    authorizationIdentifier: "pkg-auth-import",
    operationKind: "import-copy",
    argumentsHash: "pkg-hash-import",
  });
} catch (error) {
  console.log("✗ 跨项目授权准备失败 — " + String(error?.message ?? error));
}

const readAllowed = runInstalled([
  "cross-project",
  "read",
  "--authorization",
  "pkg-auth-read",
  "--source-project",
  "project-a",
  "--target-project",
  "project-b",
  "--resource",
  "docs/spec.md",
  "--absolute-resource",
  sourceAbsolutePath,
  "--arguments-hash",
  "pkg-hash-read",
  "--json",
]);
const readUnauthorized = runInstalled([
  "cross-project",
  "read",
  "--authorization",
  "pkg-auth-missing",
  "--source-project",
  "project-a",
  "--target-project",
  "project-b",
  "--resource",
  "docs/spec.md",
  "--absolute-resource",
  sourceAbsolutePath,
  "--arguments-hash",
  "pkg-hash-read",
  "--json",
]);
const importAllowed = runInstalled([
  "cross-project",
  "import-copy",
  "--authorization",
  "pkg-auth-import",
  "--source-project",
  "project-a",
  "--target-project",
  "project-b",
  "--source-resource",
  "docs/spec.md",
  "--target-resource",
  "docs/spec-copy.md",
  "--absolute-source",
  sourceAbsolutePath,
  "--absolute-target",
  targetAbsolutePath,
  "--source-revision",
  "3",
  "--arguments-hash",
  "pkg-hash-import",
  "--json",
]);
const importStaleRejected = runInstalled([
  "cross-project",
  "import-copy",
  "--authorization",
  "pkg-auth-import",
  "--source-project",
  "project-a",
  "--target-project",
  "project-b",
  "--source-resource",
  "docs/spec.md",
  "--target-resource",
  "docs/occupied.md",
  "--absolute-source",
  sourceAbsolutePath,
  "--absolute-target",
  occupiedTargetPath,
  "--source-revision",
  "3",
  "--arguments-hash",
  "pkg-hash-import",
  "--json",
]);

const crossProjectChecks = buildCrossProjectPackageChecks({
  readAllowed,
  readUnauthorized,
  importAllowed,
  importStaleRejected,
});
for (const check of crossProjectChecks) {
  console.log(`${check.passed ? "✓" : "✗"} ${check.name} — ${check.detail}`);
}

// ─── PROJECT-01-04：多项目隔离（A/B → C）与可追溯 ───
// A、B 两个来源项目各自有授权；用 A 的授权去读 B 的绝对路径必须被拒（不串数据）。
const projectBSourcePath = path.join(crossProjectRoot, "project-b", "docs", "spec.md");
const projectBContent = "# 项目 B 内容\n";
mkdirSync(path.dirname(projectBSourcePath), { recursive: true });
writeFileSync(projectBSourcePath, projectBContent, "utf8");
try {
  const installedSdk = await import(installedSdkUrl);
  const store = new installedSdk.CrossProjectAuthorizationStore({
    baseDirectory: path.join(installRoot, ".astarray"),
  });
  await store.grantAuthorization({
    authorizationIdentifier: "pkg-auth-b-import",
    sourceProjectIdentifier: "project-b",
    sourceProjectRevision: 3,
    targetProjectIdentifier: "project-b-target",
    targetProjectRevision: 1,
    operationKind: "import-copy",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: "pkg-hash-b-import",
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    grantedByUserId: "package-acceptance-user",
    taskIdentifier: "T-PKG-B",
  });
} catch (error) {
  console.log("✗ 多项目授权准备失败 — " + String(error?.message ?? error));
}

const crossProjectIsolation = runInstalled([
  "cross-project",
  "read",
  "--authorization",
  "pkg-auth-read",
  "--source-project",
  "project-b",
  "--target-project",
  "project-b-target",
  "--resource",
  "docs/spec.md",
  "--absolute-resource",
  projectBSourcePath,
  "--arguments-hash",
  "pkg-hash-read",
  "--json",
]);

// 授权列表必须能区分两个来源项目（可追溯、不串数据）
const crossProjectList = runInstalled(["cross-project", "list", "--json"]);
const listPayload = (() => {
  const text = crossProjectList.stdoutText ?? "";
  const startIndex = text.indexOf("{");
  if (startIndex < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(startIndex));
  } catch {
    return null;
  }
})();
const authorizationSourceProjects = Array.isArray(listPayload?.authorizations)
  ? listPayload.authorizations.map((record) => String(record?.sourceProjectIdentifier))
  : null;

const multiProjectChecks = [
  {
    name: "多项目隔离：用 A 的授权去读 B 的来源必须被拒（非 0，不串数据）",
    passed: crossProjectIsolation.exitCode !== 0,
    detail: `exit=${String(crossProjectIsolation.exitCode)}`,
  },
  {
    name: "可追溯：授权列表必须同时可见 project-a 与 project-b 两个来源",
    passed:
      authorizationSourceProjects !== null &&
      authorizationSourceProjects.includes("project-a") &&
      authorizationSourceProjects.includes("project-b"),
    detail:
      authorizationSourceProjects === null
        ? "授权列表不可解析"
        : "sources=" + authorizationSourceProjects.join(","),
  },
];
for (const check of multiProjectChecks) {
  console.log(`${check.passed ? "✓" : "✗"} ${check.name} — ${check.detail}`);
}

// 真实文件断言：导入的副本必须真的存在且内容等于来源；被占目标必须原样保留。
const importedCopyText = existsSync(targetAbsolutePath)
  ? readFileSync(targetAbsolutePath, "utf8")
  : null;
const occupiedText = readFileSync(occupiedTargetPath, "utf8");
const fileChecks = [
  {
    name: "跨项目导入：目标副本文件真实存在且内容等于来源",
    passed: importedCopyText === sourceContent,
    detail: importedCopyText === null ? "目标文件不存在" : "内容一致",
  },
  {
    name: "跨项目导入：被人工占用的目标字节保持不变（拒绝陈旧覆盖）",
    passed: occupiedText === occupiedContent,
    detail: occupiedText === occupiedContent ? "人工字节保留" : "人工字节被改写",
  },
  {
    name: "跨项目只读：来源文件字节未被修改",
    passed:
      readFileSync(sourceAbsolutePath, "utf8") === sourceContent,
    detail: "来源内容前后一致",
  },
];
for (const check of fileChecks) {
  console.log(`${check.passed ? "✓" : "✗"} ${check.name} — ${check.detail}`);
}

checks.push(...crossProjectChecks, ...multiProjectChecks, ...fileChecks);

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
