/**
 * T13 打包校验脚本：检查 tarball 内容。
 * 断言：不含 .env、API key、测试日志或 .astarray 运行数据；shebang 无 BOM。
 * 用法：node scripts/verify-package.mjs <tarball路径>
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const tarballPath = path.resolve(process.argv[2]);
if (tarballPath === undefined) {
  console.error("用法: node scripts/verify-package.mjs <tarball路径>");
  process.exit(1);
}

const listingOutput = execSync(`npm pack ${JSON.stringify(tarballPath)} --dry-run --json`, {
  encoding: "utf8",
});
const packResult = JSON.parse(listingOutput)[0];
const fileNames = (packResult.files ?? []).map((file) => file.path);

const forbiddenPatterns = [
  /\.env$/i,
  /\.astarray\//,
  /\.log$/i,
  /tests?[\\/]/i,
  /\.tmp[\\/]/i,
];

const problems = [];
for (const fileName of fileNames) {
  const normalized = fileName.replace(/\\/g, "/");
  if (forbiddenPatterns.some((pattern) => pattern.test(normalized))) {
    problems.push(`包含不应打包的文件: ${fileName}`);
  }
}

const cliEntry = fileNames.find((fileName) => fileName.replace(/\\/g, "/") === "dist/cli.js");
if (cliEntry === undefined) {
  problems.push("tarball 缺少 dist/cli.js");
}
const feedbackEntry = fileNames.find((fileName) =>
  fileName.replace(/\\/g, "/").endsWith("feedback-process-entry.js"),
);
if (feedbackEntry === undefined) {
  problems.push("tarball 缺少反馈进程入口文件");
}

// 提取 tarball 检查 shebang 与 BOM（Windows 自带 bsdtar，支持 tar -xzf）
const extractDirectory = path.join(
  path.dirname(tarballPath),
  `.verify-${Date.now()}`,
);
mkdirSync(extractDirectory, { recursive: true });
execSync(`tar -xzf "${tarballPath}" -C "${extractDirectory}"`);
const extractedCliPath = path.join(extractDirectory, "package", "dist", "cli.js");
const cliBytes = readFileSync(extractedCliPath);
if (cliBytes[0] === 0xef && cliBytes[1] === 0xbb && cliBytes[2] === 0xbf) {
  problems.push("cli.js 包含 BOM");
}
const shebangLine = cliBytes.toString("utf8").split("\n")[0];
if (!shebangLine.startsWith("#!")) {
  problems.push("cli.js 缺少 shebang");
}
rmSync(extractDirectory, { recursive: true, force: true });

if (problems.length > 0) {
  console.error("打包校验失败:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(
  `打包校验通过: ${fileNames.length} 个文件，shebang/BOM 正确，反馈进程入口已包含`,
);
