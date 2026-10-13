#!/usr/bin/env node
/**
 * 变异验证（mutation verification）：确认**关键安全断言真的在拦事**（2026-10-13）。
 *
 * 由来（真实教训）：本轮为跨项目授权补了 3 条"受保护存储不得访问"的反例，
 * 其中一条（删除审计文件）在**临时禁用产品判定器**后**仍然通过** ——
 * 因为它先命中了 `resource-not-found`，**根本没走到受保护存储判定**。
 * ⇒ "测试通过"不等于"测试有效"；空洞反例会让防线看起来存在而实际不存在。
 *
 * 本脚本把那次手工实验固化为**可复用检查**：对每条关键安全断言，
 * 用精确字符串替换在产品代码里**注入一处反事实**，跑指定用例，
 * 要求**点名的那几条用例必须变红**；最后**必定还原**（sha256 校验）。
 *
 * 判定：任一变异"存活"（期望红却没红）⇒ 该变异**没被测住** ⇒ 退出码 1。
 *
 * 用法：
 *   node scripts/verify-mutation-kills.mjs            # 全部变异
 *   node scripts/verify-mutation-kills.mjs --json     # 机器可读
 *   node scripts/verify-mutation-kills.mjs --only <mutationIdentifier>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 每个变异：
 *  - targetFile：被注入反事实的产品源文件（仓库相对路径）
 *  - find / replace：**精确**字符串替换（必须唯一命中，否则脚本报错而不是猜）
 *  - testFiles：要跑的用例文件
 *  - expectedFailingTestNames：**必须**出现在失败列表里的用例名片段
 *  - rationale：这条断言在拦什么（失败信息里会打印，便于人读懂）
 */
export const MUTATIONS = [
  {
    mutationIdentifier: "cross-project-forbidden-access-target-disabled",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (
      isForbiddenAccessTarget !== undefined &&
      (await isForbiddenAccessTarget(binding.resolvedAbsolutePath))
    ) {`,
    replace: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (false && isForbiddenAccessTarget !== undefined) {`,
    testFiles: [
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
    ],
    expectedFailingTestNames: [
      "受保护存储（backup-vault / 删除审计）不得经跨项目通道访问",
      "副本导入：**来源**是受保护存储时不得被拷出去",
      "受保护存储之删除审计文件同样不得经跨项目通道读取",
      "SDK 入口：受保护存储（backup-vault）不得经跨项目通道读取",
    ],
    rationale: "受保护存储判定被禁用时，保管库/审计文件必须仍被拒绝（fail-closed 防线）",
  },
  {
    mutationIdentifier: "cross-project-target-filename-binding-relaxed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `      if (canonicalizedActualPath !== expectedCanonicalTargetPath) {`,
    replace: `      if (path.dirname(canonicalizedActualPath) !== path.dirname(expectedCanonicalTargetPath)) {`,
    testFiles: ["tests/core/integration/cross-project-resource-io.test.ts"],
    expectedFailingTestNames: [
      "副本导入：目标绝对路径与「目标项目根 + 声明路径」不一致时必须拒绝",
    ],
    rationale:
      "把'完整规范路径比对'放宽成'只比父目录'后，'同目录换个文件名'必须仍被拒绝（否则目标可被调包）",
  },
];

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseJsonReport(reportPath) {
  const rawText = readFileSync(reportPath, "utf8");
  const trimmed = rawText.trim();
  // vitest --reporter=json 可能带前导日志行，取第一个 '{' 起解析。
  const startIndex = trimmed.indexOf("{");
  if (startIndex === -1) {
    throw new Error("未找到 JSON 报告内容");
  }
  return JSON.parse(trimmed.slice(startIndex));
}

function collectFailedTestNames(report) {
  const failedNames = new Set();
  for (const testResult of report.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failedNames.add(String(assertion.fullName ?? assertion.title ?? ""));
      }
    }
  }
  return failedNames;
}

function runMutation(mutation, options) {
  const targetPath = path.join(repositoryRootDirectory, mutation.targetFile);
  const originalContent = readFileSync(targetPath, "utf8");
  const originalDigest = sha256OfFile(targetPath);

  const occurrenceCount = originalContent.split(mutation.find).length - 1;
  if (occurrenceCount !== 1) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        `锚点在 ${mutation.targetFile} 中命中 ${occurrenceCount} 次（要求恰好 1 次）——` +
        "说明源码已改动，请同步更新脚本里的 find 片段（不要让它静默跳过）",
      failedTestNames: [],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const mutatedContent = originalContent.replace(mutation.find, mutation.replace);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-mutation-"));
  const reportPath = path.join(temporaryDirectory, "vitest-report.json");

  let failedTestNames = new Set();
  let runError = null;
  try {
    writeFileSync(targetPath, mutatedContent, "utf8");
    try {
      execFileSync(
        process.execPath,
        [
          path.join(repositoryRootDirectory, "node_modules", "vitest", "vitest.mjs"),
          "run",
          ...mutation.testFiles,
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        { cwd: repositoryRootDirectory, stdio: "inherit" },
      );
      // 注入了反事实 ⇒ 期望 vitest 失败；若这里正常返回说明"用例没红"。
      runError = "vitest 在注入反事实后仍然通过（该变异存活）";
    } catch {
      // 期望路径：存在失败用例。
    }
    try {
      failedTestNames = collectFailedTestNames(parseJsonReport(reportPath));
    } catch (error) {
      if (runError === null) {
        runError = `无法解析 vitest JSON 报告：${String(error)}`;
      }
    }
  } finally {
    writeFileSync(targetPath, originalContent, "utf8");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const restoredDigest = sha256OfFile(targetPath);
  if (restoredDigest !== originalDigest) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage: `还原失败：${mutation.targetFile} 的 sha256 与注入前不一致`,
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const missingExpectations = mutation.expectedFailingTestNames.filter(
    (expectedNameFragment) =>
      ![...failedTestNames].some((failedName) => failedName.includes(expectedNameFragment)),
  );

  return {
    mutationIdentifier: mutation.mutationIdentifier,
    isKilled: missingExpectations.length === 0,
    isScriptError: false,
    errorMessage: runError,
    failedTestNames: [...failedTestNames],
    expectedFailingTestNames: mutation.expectedFailingTestNames,
    missingExpectations,
    rationale: mutation.rationale,
  };
}

function main() {
  const argumentsList = process.argv.slice(2);
  const isJsonOutput = argumentsList.includes("--json");
  const onlyIndex = argumentsList.indexOf("--only");
  const onlyIdentifier = onlyIndex === -1 ? null : argumentsList[onlyIndex + 1];

  const selectedMutations =
    onlyIdentifier === null
      ? MUTATIONS
      : MUTATIONS.filter((mutation) => mutation.mutationIdentifier === onlyIdentifier);

  if (selectedMutations.length === 0) {
    process.stderr.write(`未找到匹配的变异：${String(onlyIdentifier)}\n`);
    process.exitCode = 1;
    return;
  }

  const outcomes = [];
  for (const mutation of selectedMutations) {
    if (!isJsonOutput) {
      process.stdout.write(`\n── 变异 ${mutation.mutationIdentifier} ──\n`);
      process.stdout.write(`   ${mutation.rationale}\n`);
    }
    const outcome = runMutation(mutation, { isJsonOutput });
    outcomes.push(outcome);
    if (!isJsonOutput) {
      if (outcome.isScriptError) {
        process.stdout.write(`   ❌ 脚本错误：${String(outcome.errorMessage)}\n`);
      } else if (outcome.isKilled) {
        process.stdout.write(
          `   ✅ 被拦下（${outcome.expectedFailingTestNames.length} 条点名的用例均变红）\n`,
        );
      } else {
        process.stdout.write(`   ❌ **变异存活**：以下期望变红的用例没有红\n`);
        for (const missing of outcome.missingExpectations ?? []) {
          process.stdout.write(`        - ${missing}\n`);
        }
        if (outcome.errorMessage !== null) {
          process.stdout.write(`        备注：${String(outcome.errorMessage)}\n`);
        }
      }
    }
  }

  const killedCount = outcomes.filter((outcome) => outcome.isKilled).length;
  const allKilled = killedCount === outcomes.length;

  if (isJsonOutput) {
    process.stdout.write(
      JSON.stringify({ killedCount, totalCount: outcomes.length, outcomes }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(
      `\n变异验证：${killedCount}/${outcomes.length} 被拦下` +
        (allKilled ? "（全部通过）\n" : "（存在存活变异 ⇒ 有断言是空的）\n"),
    );
  }

  process.exitCode = allKilled ? 0 : 1;
}

main();
