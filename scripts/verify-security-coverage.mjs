#!/usr/bin/env node
/**
 * E2E-01-04 安全关键模块覆盖率专项校验。
 *
 * 读取 vitest v8 覆盖率摘要（coverage/coverage-summary.json），按 AR-07 §1 定义的
 * 关键安全模块清单逐模块校验分支覆盖率，并打印 covered/total 分母。
 * 用法：node scripts/verify-security-coverage.mjs [--summary <path>] [--minimum-branch 95] [--json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** AR-07 §1 关键安全模块清单（分支覆盖率必须 ≥95%）。 */
export const SECURITY_CRITICAL_MODULES = [
  "packages/core/src/core/completion-protocol.ts",
  "packages/core/src/orchestration/work-archive-store.ts",
  "packages/core/src/tools/evidence-search-agent-port.ts",
  "packages/core/src/feedback-process/mailbox-journal.ts",
  "packages/core/src/tools/protected-storage-policy.ts",
  "packages/core/src/tools/installation-gate-guard.ts",
  "packages/core/src/tools/configurable-permission-policy-engine.ts",
  "packages/core/src/tools/permission-profile-store.ts",
  "packages/core/src/tools/policy-wrapper.ts",
  "packages/core/src/tools/local-tool-policy-engine.ts",
  "packages/core/src/tools/local-progress-and-cycle-guard.ts",
  "packages/core/src/orchestration/agent-run-watchdog.ts",
  "packages/core/src/tools/session-permission-elevation.ts",
  "packages/core/src/tools/sensitive-content-access-policy.ts",
  "packages/core/src/tools/backup-vault.ts",
  "packages/core/src/feedback-process/process-supervisor.ts",
  "packages/core/src/feedback-process/entrypoint.ts",
  "packages/core/src/tools/read-suppression-ledger.ts",
  "packages/core/src/tools/local-sensitive-operation-classifier.ts",
  "packages/core/src/tools/current-permission-selection.ts",
  "packages/core/src/tools/permission-capability-catalog.ts",
  "packages/core/src/orchestration/unbounded-agent-registry.ts",
];

function parseArguments(argumentsList) {
  const options = {
    summaryPath: path.join(repositoryRootDirectory, "coverage", "coverage-summary.json"),
    minimumBranchPercentage: 95,
    isJsonOutput: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token === "--summary") {
      options.summaryPath = argumentsList[index + 1] ?? options.summaryPath;
      index += 1;
    } else if (token === "--minimum-branch") {
      options.minimumBranchPercentage = Number.parseFloat(argumentsList[index + 1] ?? "95");
      index += 1;
    } else if (token === "--json") {
      options.isJsonOutput = true;
    }
  }
  return options;
}

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

export function evaluateSecurityCoverage(summary, minimumBranchPercentage) {
  const entries = Object.entries(summary).filter(([key]) => key !== "total");
  const results = [];
  for (const modulePath of SECURITY_CRITICAL_MODULES) {
    const normalizedModulePath = normalizePath(modulePath);
    const match = entries.find(([key]) =>
      normalizePath(key).endsWith(normalizedModulePath),
    );
    if (match === undefined) {
      results.push({
        modulePath,
        isPresent: false,
        branchPercentage: 0,
        coveredBranches: 0,
        totalBranches: 0,
        isMeetingMinimum: false,
      });
      continue;
    }
    const branchMetrics = match[1].branches ?? { pct: 0, covered: 0, total: 0 };
    results.push({
      modulePath,
      isPresent: true,
      branchPercentage: branchMetrics.pct,
      coveredBranches: branchMetrics.covered,
      totalBranches: branchMetrics.total,
      isMeetingMinimum: branchMetrics.pct >= minimumBranchPercentage,
    });
  }
  return results;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  let summary;
  try {
    summary = JSON.parse(readFileSync(options.summaryPath, "utf8"));
  } catch (error) {
    console.error(
      "无法读取覆盖率摘要（先运行 npm run test:coverage）: " +
        options.summaryPath +
        " / " +
        String(error),
    );
    process.exitCode = 1;
    return;
  }
  const results = evaluateSecurityCoverage(summary, options.minimumBranchPercentage);
  const failing = results.filter((result) => !result.isMeetingMinimum);
  if (options.isJsonOutput) {
    console.log(
      JSON.stringify(
        {
          minimumBranchPercentage: options.minimumBranchPercentage,
          moduleCount: results.length,
          failingModuleCount: failing.length,
          modules: results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      "模块 | 分支 coverage | 分母 | 达标(" + options.minimumBranchPercentage + "%)",
    );
    for (const result of results) {
      console.log(
        result.modulePath +
          " | " +
          result.branchPercentage.toFixed(2) +
          "% | " +
          result.coveredBranches +
          "/" +
          result.totalBranches +
          " | " +
          (result.isMeetingMinimum ? "是" : "否"),
      );
    }
    console.log(
      "关键安全模块: " +
        (results.length - failing.length) +
        "/" +
        results.length +
        " 达标（阈值 " +
        options.minimumBranchPercentage +
        "%）",
    );
  }
  process.exitCode = failing.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
