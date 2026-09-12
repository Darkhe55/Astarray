/**
 * E2E-01 fixture 冻结测试。
 * 失败：退出码 1 + 输出包含 E2E01_BASELINE_FAILURE；
 * 成功：退出码 0 + 输出包含 E2E01_TESTS_PASSED。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeTaskChain } from "../src/summarize-tasks.mjs";

const fixtureProjectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedArtifacts = JSON.parse(
  readFileSync(
    path.join(fixtureProjectDirectory, "..", "expected-artifacts.json"),
    "utf8",
  ),
);
const taskChain = JSON.parse(
  readFileSync(path.join(fixtureProjectDirectory, "task-chain.json"), "utf8"),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

try {
  const summary = summarizeTaskChain(taskChain.tasks);
  assert(
    deepEqual(summary, expectedArtifacts.expectedSummary),
    "摘要与冻结预期不一致: " + JSON.stringify(summary),
  );
  let duplicateRejected = false;
  try {
    summarizeTaskChain([
      { id: "T-001", dependsOn: [], status: "pending" },
      { id: "T-001", dependsOn: [], status: "done" },
    ]);
  } catch (error) {
    duplicateRejected = String(error.message).includes("duplicate-task-id");
  }
  assert(duplicateRejected, "重复任务 id 必须被拒绝");
  let dependencyRejected = false;
  try {
    summarizeTaskChain([
      { id: "T-001", dependsOn: ["T-404"], status: "pending" },
    ]);
  } catch (error) {
    dependencyRejected = String(error.message).includes("dependency-not-found");
  }
  assert(dependencyRejected, "缺失依赖必须被拒绝");
  console.log("E2E01_TESTS_PASSED");
} catch (error) {
  console.log("E2E01_BASELINE_FAILURE " + String(error && error.message ? error.message : error));
  process.exit(1);
}
