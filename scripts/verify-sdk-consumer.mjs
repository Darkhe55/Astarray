#!/usr/bin/env node
/**
 * T07D-R1-04：npm tarball 隔离消费者行为验证（提交/查询/取消/关闭 + 真实文件变化）。
 * 用法：node scripts/verify-sdk-consumer.mjs <tarball-path>
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scenarioPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sdk-consumer-scenario.mjs",
);
const tarballPath = process.argv[2];
if (tarballPath === undefined || !existsSync(tarballPath)) {
  console.error("用法: node scripts/verify-sdk-consumer.mjs <tarball-path>");
  process.exit(1);
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "astarray-sdk-consumer-"));
try {
  const install = spawnSync(
    "npm",
    [
      "install",
      path.resolve(tarballPath),
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--prefer-offline",
    ],
    { cwd: workspace, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (install.status !== 0) {
    console.error("消费者安装失败");
    process.exit(1);
  }
  copyFileSync(scenarioPath, path.join(workspace, "scenario.mjs"));
  const run = spawnSync(process.execPath, ["scenario.mjs"], {
    cwd: workspace,
    encoding: "utf8",
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.status !== 0) {
    console.error("消费者场景执行失败");
    process.exit(1);
  }
  const lines = (run.stdout ?? "").trim().split("\n");
  const report = JSON.parse(lines[lines.length - 1]);
  const failures = [];
  if (report.acceptedStatus !== "accepted") failures.push("accepted 状态异常");
  if (report.idempotentMissionMatched !== true) failures.push("幂等键未命中同一 mission");
  if (report.finalStatus !== "done") failures.push("任务未达 done");
  if (report.taskChainContainsDone !== true || report.taskChainContainsTask !== true) {
    failures.push("缺少真实任务链产物");
  }
  if (!["cancelled", "done"].includes(report.cancelObservedStatus)) {
    failures.push("取消未产生稳定终态");
  }
  if (report.internalSubpathBlocked !== true) failures.push("内部路径未被 exports 阻止");
  if (report.closedAfterShutdown !== true) failures.push("关闭未生效");
  if (failures.length > 0) {
    console.error("SDK 消费者行为验证失败: " + failures.join("; "));
    process.exit(1);
  }
  console.log("SDK 消费者行为验证通过: " + JSON.stringify(report));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
