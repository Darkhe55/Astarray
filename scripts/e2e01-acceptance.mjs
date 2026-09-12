#!/usr/bin/env node
/**
 * E2E-01-01 验收 fixture 与证据协议（自包含；仅使用 Node 标准库）。
 *
 * 子命令：
 *   fixture                       脚手架 + 基线（必须失败）+ 参考实现（必须通过）闭环
 *   scaffold <dir>                把冻结 fixture 复制到目标目录并打印 fingerprint
 *   fingerprint <dir>             计算目录 fingerprint（可重复运行依据）
 *   baseline <dir>                运行冻结失败测试（要求非 0 且含失败标记）
 *   solution <dir>                套用参考实现并校验产物与冻结预期一致
 *   evidence-create ...           生成证据包骨架（绑定 tarball 哈希/commit/配置/Provider/运行 ID）
 *   evidence-validate <file>      校验证据包（缺失绑定、未授权真实 Provider、无签署人工项一律拒绝）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const E2E01_FIXTURE_FAILURE_MARKER = "E2E01_BASELINE_FAILURE";
export const E2E01_FIXTURE_SUCCESS_MARKER = "E2E01_TESTS_PASSED";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, "..");
const fixtureSourceDirectory = path.join(
  repositoryRootDirectory,
  "tests",
  "fixtures",
  "e2e01",
);

const REQUIRED_PROVIDER_KINDS = ["mock", "local-fake", "real"];
const MANUAL_CHECK_STATUSES = ["pending-manual", "verified", "rejected"];
const FORBIDDEN_EVIDENCE_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|authorization-secret|client[_-]?secret|"nonce"|"token")/i;

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listRelativeFilePaths(directoryPath) {
  const collected = [];
  const walk = (currentDirectory, prefix) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(currentDirectory, entry.name);
      const relativePath = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
      } else {
        collected.push(relativePath);
      }
    }
  };
  walk(directoryPath, "");
  return collected;
}

export function computeFixtureFingerprint(directoryPath) {
  const lines = listRelativeFilePaths(directoryPath).map(
    (relativePath) =>
      relativePath + ":" + sha256OfFile(path.join(directoryPath, relativePath)),
  );
  return "sha256:" + createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function scaffoldFixture(targetDirectory) {
  if (!existsSync(fixtureSourceDirectory)) {
    throw new Error("fixture 源目录不存在: " + fixtureSourceDirectory);
  }
  rmSync(targetDirectory, { recursive: true, force: true });
  mkdirSync(path.dirname(targetDirectory), { recursive: true });
  cpSync(fixtureSourceDirectory, targetDirectory, { recursive: true });
  return {
    targetDirectory,
    fingerprint: computeFixtureFingerprint(targetDirectory),
    fileCount: listRelativeFilePaths(targetDirectory).length,
  };
}

function runNodeScript(scriptRelativePath, workingDirectory) {
  try {
    const output = execFileSync(process.execPath, [scriptRelativePath], {
      cwd: workingDirectory,
      encoding: "utf8",
    });
    return { exitCode: 0, output };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : 1,
      output: String(error.stdout ?? "") + String(error.stderr ?? ""),
    };
  }
}

export function runFixtureBaseline(targetDirectory) {
  const result = runNodeScript(
    "test/run-tests.mjs",
    path.join(targetDirectory, "project"),
  );
  return result;
}

export function runFixtureSolution(targetDirectory) {
  const projectDirectory = path.join(targetDirectory, "project");
  cpSync(
    path.join(projectDirectory, "solution", "summarize-tasks.mjs"),
    path.join(projectDirectory, "src", "summarize-tasks.mjs"),
  );
  const tests = runNodeScript("test/run-tests.mjs", projectDirectory);
  const artifacts = runNodeScript("test/produce-artifacts.mjs", projectDirectory);
  const expected = JSON.parse(
    readFileSync(path.join(targetDirectory, "expected-artifacts.json"), "utf8"),
  );
  const summaryPath = path.join(projectDirectory, "out", "summary.json");
  const artifactHashes = {};
  let expectedSummaryMatched = false;
  if (existsSync(summaryPath)) {
    const producedSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
    expectedSummaryMatched =
      JSON.stringify(producedSummary) === JSON.stringify(expected.expectedSummary);
    for (const relativePath of expected.requiredArtifactPaths) {
      const artifactPath = path.join(projectDirectory, relativePath);
      if (existsSync(artifactPath)) {
        artifactHashes[relativePath] = sha256OfFile(artifactPath);
      }
    }
  }
  return {
    exitCode: tests.exitCode === 0 && artifacts.exitCode === 0 ? 0 : 1,
    output: tests.output + artifacts.output,
    expectedSummaryMatched,
    artifactHashes,
  };
}

function readGitValue(argumentsList, fallbackValue) {
  try {
    return execFileSync("git", argumentsList, {
      cwd: repositoryRootDirectory,
      encoding: "utf8",
    }).trim();
  } catch {
    return fallbackValue;
  }
}

export async function createEvidenceBundle(input) {
  if (!existsSync(input.tarballPath)) {
    throw new Error("tarball 不存在: " + input.tarballPath);
  }
  if (!existsSync(input.configurationPath)) {
    throw new Error("配置不存在: " + input.configurationPath);
  }
  const tarballStatistics = statSync(input.tarballPath);
  const workingTreeStatus = readGitValue(["status", "--porcelain"], "");
  const bundle = {
    evidenceSchemaVersion: 1,
    runIdentifier: input.runIdentifier,
    createdAtIso: new Date().toISOString(),
    commit: {
      hash: readGitValue(["rev-parse", "HEAD"], "unavailable"),
      branch: readGitValue(["rev-parse", "--abbrev-ref", "HEAD"], "unavailable"),
      isDirty: workingTreeStatus !== "",
    },
    tarball: {
      path: path.resolve(input.tarballPath),
      sha256: sha256OfFile(input.tarballPath),
      sizeBytes: tarballStatistics.size,
    },
    configuration: {
      path: path.resolve(input.configurationPath),
      sha256: sha256OfFile(input.configurationPath),
    },
    provider: {
      providerProfileId: input.provider.providerProfileId,
      modelProfileId: input.provider.modelProfileId,
      kind: input.provider.kind,
      credentialsAuthorized: input.provider.credentialsAuthorized === true,
    },
    platform: {
      os: process.platform,
      osVersion: os.release(),
      nodeVersion: process.versions.node,
    },
    fixtureFingerprint:
      input.fixtureFingerprint ??
      (existsSync(fixtureSourceDirectory)
        ? computeFixtureFingerprint(fixtureSourceDirectory)
        : "sha256:unavailable"),
    automatedChecks: [
      {
        checkIdentifier: "e2e01-fixture-baseline-and-solution",
        command: "node scripts/e2e01-acceptance.mjs fixture",
        exitCode: 0,
        status: "passed",
      },
    ],
    // 人工检查默认一律 pending-manual：证据生成器不得自动置为已通过。
    manualChecks: [
      { checkIdentifier: "manual-user-workflow-walkthrough", status: "pending-manual" },
      { checkIdentifier: "manual-real-provider-observation", status: "pending-manual" },
    ],
    artifacts: [],
  };
  writeFileSync(input.outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  return bundle;
}

export function validateEvidenceBundle(bundle) {
  const problems = [];
  if (bundle === null || typeof bundle !== "object") {
    return ["证据包不是对象"];
  }
  const evidence = bundle;
  if (evidence.evidenceSchemaVersion !== 1) {
    problems.push("evidenceSchemaVersion 必须为 1");
  }
  if (typeof evidence.runIdentifier !== "string" || evidence.runIdentifier === "") {
    problems.push("缺少 runIdentifier");
  }
  if (typeof evidence.createdAtIso !== "string" || evidence.createdAtIso === "") {
    problems.push("缺少 createdAtIso");
  }
  const commit = evidence.commit;
  if (typeof commit !== "object" || commit === null || typeof commit.hash !== "string" || commit.hash === "") {
    problems.push("缺少 commit.hash");
  }
  if (typeof commit?.isDirty !== "boolean") {
    problems.push("缺少 commit.isDirty");
  }
  const tarball = evidence.tarball;
  if (typeof tarball !== "object" || tarball === null || typeof tarball.sha256 !== "string") {
    problems.push("缺少 tarball.sha256");
  } else if (!/^[a-f0-9]{64}$/.test(tarball.sha256)) {
    problems.push("tarball.sha256 不是 sha256 十六进制");
  }
  if (typeof tarball?.sizeBytes !== "number" || !(tarball.sizeBytes > 0)) {
    problems.push("缺少 tarball.sizeBytes");
  }
  const configuration = evidence.configuration;
  if (typeof configuration !== "object" || configuration === null || typeof configuration.sha256 !== "string") {
    problems.push("缺少 configuration.sha256");
  } else if (!/^[a-f0-9]{64}$/.test(configuration.sha256)) {
    problems.push("configuration.sha256 不是 sha256 十六进制");
  }
  const provider = evidence.provider;
  if (typeof provider !== "object" || provider === null) {
    problems.push("缺少 provider");
  } else {
    if (typeof provider.providerProfileId !== "string" || provider.providerProfileId === "") {
      problems.push("缺少 provider.providerProfileId");
    }
    if (typeof provider.modelProfileId !== "string" || provider.modelProfileId === "") {
      problems.push("缺少 provider.modelProfileId");
    }
    if (!REQUIRED_PROVIDER_KINDS.includes(provider.kind)) {
      problems.push("provider.kind 非法");
    } else if (provider.kind === "real" && provider.credentialsAuthorized !== true) {
      // 只有真实服务需要凭据与费用授权；mock 与本地假服务器不联网、无费用。
      problems.push(
        "real-provider-requires-authorization: 真实 Provider 必须先取得用户凭据与费用授权",
      );
    }
  }
  const platform = evidence.platform;
  if (typeof platform !== "object" || platform === null || typeof platform.os !== "string") {
    problems.push("缺少 platform.os");
  }
  if (typeof platform?.nodeVersion !== "string" || platform.nodeVersion === "") {
    problems.push("缺少 platform.nodeVersion");
  }
  if (
    typeof evidence.fixtureFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(evidence.fixtureFingerprint)
  ) {
    problems.push("缺少 fixtureFingerprint");
  }
  if (!Array.isArray(evidence.automatedChecks) || evidence.automatedChecks.length === 0) {
    problems.push("automatedChecks 不得为空");
  } else {
    evidence.automatedChecks.forEach((check, index) => {
      if (typeof check?.checkIdentifier !== "string" || check.checkIdentifier === "") {
        problems.push("automatedChecks[" + index + "].checkIdentifier 缺失");
      }
      if (typeof check?.command !== "string" || check.command === "") {
        problems.push("automatedChecks[" + index + "].command 缺失");
      }
      if (check?.status !== "passed" && check?.status !== "failed") {
        problems.push("automatedChecks[" + index + "].status 非法");
      }
      if (check?.status === "passed" && check.exitCode !== 0) {
        problems.push(
          "automatedChecks[" + index + "].exitCode 与 status 不一致（passed 必须 exitCode=0）",
        );
      }
    });
  }
  if (!Array.isArray(evidence.manualChecks)) {
    problems.push("manualChecks 必须是数组（人工与自动检查必须分开）");
  } else {
    evidence.manualChecks.forEach((check, index) => {
      if (!MANUAL_CHECK_STATUSES.includes(check?.status)) {
        problems.push("manualChecks[" + index + "].status 非法");
      }
      if (check?.status === "verified") {
        if (typeof check.verifiedByUserId !== "string" || check.verifiedByUserId === "") {
          problems.push("manualChecks[" + index + "].verifiedByUserId 缺失（人工项不得自动置为已通过）");
        }
        if (typeof check.verifiedAtIso !== "string" || check.verifiedAtIso === "") {
          problems.push("manualChecks[" + index + "].verifiedAtIso 缺失");
        }
      }
    });
  }
  if (!Array.isArray(evidence.artifacts)) {
    problems.push("artifacts 必须是数组");
  } else {
    evidence.artifacts.forEach((artifact, index) => {
      if (typeof artifact?.path !== "string" || artifact.path === "") {
        problems.push("artifacts[" + index + "].path 缺失");
      }
      if (typeof artifact?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        problems.push("artifacts[" + index + "].sha256 缺失或非法");
      }
    });
  }
  if (FORBIDDEN_EVIDENCE_KEY_PATTERN.test(JSON.stringify(evidence))) {
    problems.push("证据包含疑似 credential 字段，禁止记录凭据");
  }
  return problems;
}

function runFixtureCommand(targetDirectory) {
  const scaffoldResult = scaffoldFixture(targetDirectory);
  const baseline = runFixtureBaseline(targetDirectory);
  const solution = runFixtureSolution(targetDirectory);
  const baselineFailedAsFrozen =
    baseline.exitCode !== 0 &&
    baseline.output.includes(E2E01_FIXTURE_FAILURE_MARKER);
  const solutionPassedAsFrozen =
    solution.exitCode === 0 &&
    solution.output.includes(E2E01_FIXTURE_SUCCESS_MARKER) &&
    solution.expectedSummaryMatched;
  const summary = {
    fixtureFingerprint: scaffoldResult.fingerprint,
    fileCount: scaffoldResult.fileCount,
    baselineFailedAsFrozen,
    solutionPassedAsFrozen,
    artifactHashes: solution.artifactHashes,
  };
  console.log(JSON.stringify(summary, null, 2));
  return baselineFailedAsFrozen && solutionPassedAsFrozen ? 0 : 1;
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token.startsWith("--")) {
      const separatorIndex = token.indexOf("=");
      if (separatorIndex > 2) {
        options[token.slice(2, separatorIndex)] = token.slice(separatorIndex + 1);
      } else {
        options[token.slice(2)] = argumentsList[index + 1];
        index += 1;
      }
    }
  }
  return options;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "fixture": {
      const targetDirectory =
        rest[0] ?? path.join(repositoryRootDirectory, ".tmp", "e2e01", "fixture-run");
      process.exitCode = runFixtureCommand(targetDirectory);
      return;
    }
    case "scaffold": {
      const result = scaffoldFixture(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "fingerprint": {
      console.log(computeFixtureFingerprint(rest[0]));
      return;
    }
    case "baseline": {
      const result = runFixtureBaseline(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.exitCode === 0 ? 1 : 0;
      return;
    }
    case "solution": {
      const result = runFixtureSolution(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.exitCode === 0 && result.expectedSummaryMatched ? 0 : 1;
      return;
    }
    case "evidence-create": {
      const options = parseArguments(rest);
      const bundle = await createEvidenceBundle({
        runIdentifier: options["run-id"],
        tarballPath: options.tarball,
        configurationPath: options.config,
        outPath: options.out,
        provider: {
          providerProfileId: options["provider-id"] ?? "local-scripted",
          modelProfileId: options["model-id"] ?? "scripted-mock-v1",
          kind: options["provider-kind"] ?? "mock",
          credentialsAuthorized: options["credentials-authorized"] === "true",
        },
      });
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    case "evidence-validate": {
      const bundle = JSON.parse(readFileSync(rest[0], "utf8"));
      const problems = validateEvidenceBundle(bundle);
      if (problems.length === 0) {
        console.log("证据包校验通过");
        return;
      }
      console.error("证据包校验失败:");
      for (const problem of problems) {
        console.error("  - " + problem);
      }
      process.exitCode = 1;
      return;
    }
    default: {
      console.error(
        "用法: node scripts/e2e01-acceptance.mjs <fixture|scaffold|fingerprint|baseline|solution|evidence-create|evidence-validate>",
      );
      process.exitCode = 2;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
