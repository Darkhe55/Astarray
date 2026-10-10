/**
 * 包级验收的共享运行时（2026-10-10）。
 *
 * 背景：本仓多张卡（OBS/SMART/PROJECT）都要求"打包验收以 **tarball 隔离安装** 为准"（AGENTS.md），
 * 而各验收脚本此前各自内联 npm 调用与 CLI 实跑，重复且易漂移。此模块把**与判定无关的机械步骤**
 * 收敛为可复用实现：解析 npm-cli.js、打包、隔离安装、实跑已安装包的 CLI、记录 tarball 指纹。
 *
 * 判定逻辑**不在**本模块（见 `smart01-instruction-package-checks.mjs` 等纯函数模块），
 * 以保证"判定可单测、机械步骤不掺判据"。
 *
 * Windows 注意：直接 spawn `npm` 会 ENOENT、`npm.cmd` 会 EINVAL（CVE-2024-27980），
 * 故解析 `npm-cli.js` 并用当前 node 执行（沿用既有两个验收脚本的实测结论）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 解析 npm-cli.js 的绝对路径；解析不到即抛错（不静默降级）。 */
export function resolveNpmCliPath() {
  const npmExecutableName = process.platform === "win32" ? "npm.cmd" : "npm";
  const whereOutput = execFileSync(
    process.platform === "win32" ? "where" : "which",
    [npmExecutableName],
    { encoding: "utf8" },
  );
  for (const candidateLine of whereOutput.split(/\r?\n/)) {
    const candidatePath = candidateLine.trim();
    if (candidatePath === "") {
      continue;
    }
    const siblingCliPath = path.join(
      path.dirname(candidatePath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (existsSync(siblingCliPath)) {
      return siblingCliPath;
    }
  }
  throw new Error("无法解析 npm-cli.js 路径");
}

/** 用当前 node 执行 npm（避免 shell 与 .cmd 差异）。 */
export function runNpmSync(argumentsList, options = {}) {
  const npmCliPath = resolveNpmCliPath();
  return execFileSync(process.execPath, [npmCliPath, ...argumentsList], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

export function hashFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function readSourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * 打包到指定目录（默认 `--ignore-scripts`：prepack 会跑整门禁，导致哈希不可复现）。
 * `shouldRunPrepack` 为真时开启 prepack（用于"连门禁一起验"的场景）。
 */
export function packTarball(input) {
  mkdirSync(input.archiveDirectory, { recursive: true });
  const packArguments = [
    "pack",
    "--json",
    "--pack-destination",
    input.archiveDirectory,
  ];
  if (input.shouldRunPrepack !== true) {
    packArguments.push("--ignore-scripts");
  }
  const packOutput = runNpmSync(packArguments);
  // prepack 输出可能混入 stdout：从后往前逐候选起点尝试解析（沿用 smoke-install 的实测修复）。
  const candidateStartIndexes = [];
  for (let index = 0; index < packOutput.length; index += 1) {
    if (packOutput[index] === "[") {
      candidateStartIndexes.push(index);
    }
  }
  let packResult = null;
  for (let index = candidateStartIndexes.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(packOutput.slice(candidateStartIndexes[index]));
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.filename === "string") {
        packResult = parsed[0];
        break;
      }
    } catch {
      // 继续尝试更靠前的候选起点
    }
  }
  if (packResult === null) {
    throw new Error("无法解析 npm pack --json 输出");
  }
  const tarballPath = path.join(input.archiveDirectory, packResult.filename);
  return {
    tarballPath,
    tarballFileName: packResult.filename,
    tarballSha256: hashFileSha256(tarballPath),
    tarballByteCount: readFileSync(tarballPath).byteLength,
  };
}

/** 在隔离目录安装 tarball（写入独立 package.json，避免污染仓库依赖树）。 */
export function installTarballIsolated(input) {
  mkdirSync(input.installDirectory, { recursive: true });
  writeFileSync(
    path.join(input.installDirectory, "package.json"),
    JSON.stringify(
      { name: input.packageName, private: true, version: "0.0.0" },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  runNpmSync(["install", input.tarballPath, "--no-audit", "--no-fund"], {
    cwd: input.installDirectory,
  });
  return path.join(input.installDirectory, "node_modules", "astarray", "dist", "cli.js");
}

/**
 * 实跑**已安装包**的 CLI，返回退出码与 stdout（stderr 单独返回，便于如实报告失败原因）。
 * `cwd` 默认隔离安装目录：CLI 的 `defaultStateDirectory()` 即 `cwd/.astarray`。
 */
export function runInstalledCli(input) {
  try {
    const stdout = execFileSync(process.execPath, [input.cliEntryPath, ...input.argumentsList], {
      cwd: input.workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdoutText: stdout, stderrText: "" };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : 1,
      stdoutText: typeof error.stdout === "string" ? error.stdout : "",
      stderrText: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}
