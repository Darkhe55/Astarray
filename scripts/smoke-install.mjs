/**
 * T13 隔离安装冒烟脚本：
 * 1. npm pack 生成 tarball
 * 2. 在 .tmp/package-smoke 中隔离安装
 * 3. 运行 --version / --help / doctor --json / run --runtime mock --json
 * 4. 用仓库内隔离 prefix 模拟全局安装，验证 Windows .cmd shim / Unix executable
 * 用法：node scripts/smoke-install.mjs
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const verificationRunIdentifier = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
const smokeRoot = path.join(
  repositoryRoot,
  ".tmp",
  "package-smoke",
  verificationRunIdentifier,
);
const prefixRoot = path.join(
  repositoryRoot,
  ".tmp",
  "global-prefix",
  verificationRunIdentifier,
);
const packageArchiveRoot = path.join(
  repositoryRoot,
  ".tmp",
  "packages",
  verificationRunIdentifier,
);

function run(command, options = {}) {
  console.log(`> ${command}`);
  return execSync(command, { encoding: "utf8", stdio: "pipe", ...options });
}

function fail(message) {
  console.error(`冒烟测试失败: ${message}`);
  process.exit(1);
}

// 1. 打包（每次使用唯一目录，不删除或覆盖以前的验证记录）
mkdirSync(smokeRoot, { recursive: true });
mkdirSync(packageArchiveRoot, { recursive: true });
const packOutput = run(
  `npm pack --json --pack-destination "${packageArchiveRoot}"`,
  { cwd: repositoryRoot },
);
const packOutputWithoutAnsi = packOutput
  .replace(/\u001B\[[0-9;]*m/g, "")
  .trim();
const packJsonStart = packOutputWithoutAnsi.indexOf("[");
const packResult = JSON.parse(packOutputWithoutAnsi.slice(packJsonStart))[0];
const tarballFileName = packResult.filename;
const tarballPath = path.join(packageArchiveRoot, tarballFileName);
console.log(
  `生成的 tarball: .tmp/packages/${verificationRunIdentifier}/${tarballFileName}`,
);

// 2. 隔离安装（写入独立 package.json，避免 npm 向上寻找到仓库 package.json）
mkdirSync(smokeRoot, { recursive: true });
writeFileSync(
  path.join(smokeRoot, "package.json"),
  JSON.stringify({ name: "astarray-smoke", private: true }, null, 2),
);
run(`npm install "${tarballPath}" --no-audit --no-fund`, { cwd: smokeRoot });
const installedNodeModules = path.join(smokeRoot, "node_modules");
if (!existsSync(installedNodeModules)) {
  fail("node_modules 未生成");
}

// 3. 运行验证（npm 依赖包中的 bin shim）
function runInstalled(args) {
  const command =
    process.platform === "win32"
      ? `npx.cmd astarray ${args}`
      : `npx astarray ${args}`;
  return run(command, { cwd: smokeRoot });
}

const versionOutput = runInstalled("--version").trim();
if (versionOutput !== "0.1.0") {
  fail(`--version 输出异常: ${versionOutput}`);
}
console.log(`--version: ${versionOutput}`);

const helpOutput = runInstalled("--help");
if (!helpOutput.includes("run") || !helpOutput.includes("doctor")) {
  fail("--help 缺少命令说明");
}

const doctorOutput = runInstalled("doctor --json");
const doctorParsed = JSON.parse(doctorOutput);
if (doctorParsed.health !== "ok") {
  fail(`doctor 不健康: ${doctorOutput}`);
}

const runOutput = runInstalled('run "smoke" --runtime mock --json');
const runParsed = JSON.parse(runOutput);
if (runParsed.status !== "done" || !runParsed.missionId.startsWith("mission-")) {
  fail(`run 输出异常: ${runOutput}`);
}
console.log(`run 冒烟: ${runParsed.missionId} → ${runParsed.status}`);

// 4. 模拟全局安装（隔离 prefix；Windows 下 shim 位于 prefix 根目录）
const globalInstallPrefix = prefixRoot;
run(
  `npm install -g "${tarballPath}" --prefix "${globalInstallPrefix}" --no-audit --no-fund`,
  { cwd: repositoryRoot },
);
if (process.platform === "win32") {
  const cmdShimPath = path.join(globalInstallPrefix, "astarray.cmd");
  if (!existsSync(cmdShimPath)) {
    fail(`Windows 缺少 .cmd shim: ${cmdShimPath}`);
  }
  const globalRun = run(`"${cmdShimPath}" --version`);
  if (!globalRun.includes("0.1.0")) {
    fail(`全局安装后 --version 异常: ${globalRun}`);
  }
} else {
  const binPath = path.join(globalInstallPrefix, "astarray");
  if (!existsSync(binPath)) {
    fail(`Unix 缺少可执行文件: ${binPath}`);
  }
  const globalRun = run(`"${binPath}" --version`);
  if (!globalRun.includes("0.1.0")) {
    fail(`全局安装后 --version 异常: ${globalRun}`);
  }
}
console.log(`全局安装 shim 验证通过: ${process.platform === "win32" ? "astarray.cmd" : "astarray"}`);

// 5. 安装后的包内反馈进程入口可加载（ESM）
const installedFeedbackEntry = path.join(
  smokeRoot,
  "node_modules",
  "astarray",
  "dist",
  "feedback-process-entry.js",
);
if (!existsSync(installedFeedbackEntry)) {
  fail("安装后的包缺少反馈进程入口文件");
}
const { pathToFileURL } = await import("node:url");
const feedbackEntryFileUrl = pathToFileURL(installedFeedbackEntry).href;
const feedbackLoadSmoke = run(
  `node --input-type=module -e "await import('${feedbackEntryFileUrl}').then(() => console.log('feedback-entry-loaded'))"`,
  { cwd: smokeRoot },
);
if (!feedbackLoadSmoke.includes("feedback-entry-loaded")) {
  fail(`安装后的反馈进程入口无法加载: ${feedbackLoadSmoke}`);
}

console.log("冒烟测试全部通过 ✓");
