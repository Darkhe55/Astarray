/**
 * E2E-01 fixture 产物生成：写出 out/summary.json 与 out/test-evidence.json。
 * 仅在参考实现下成功（由验收脚本调用）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeTaskChain } from "../src/summarize-tasks.mjs";

const fixtureProjectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const taskChain = JSON.parse(
  readFileSync(path.join(fixtureProjectDirectory, "task-chain.json"), "utf8"),
);
const summary = summarizeTaskChain(taskChain.tasks);
const outputDirectory = path.join(fixtureProjectDirectory, "out");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  "utf8",
);
const testOutput = execFileSync(process.execPath, ["test/run-tests.mjs"], {
  cwd: fixtureProjectDirectory,
  encoding: "utf8",
});
writeFileSync(
  path.join(outputDirectory, "test-evidence.json"),
  JSON.stringify(
    {
      testCommand: "node test/run-tests.mjs",
      exitCode: 0,
      passed: testOutput.includes("E2E01_TESTS_PASSED"),
      outputSha256: createHash("sha256").update(testOutput).digest("hex"),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log("E2E01_ARTIFACTS_WRITTEN");
