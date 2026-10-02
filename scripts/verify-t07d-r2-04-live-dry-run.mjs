/**
 * 真实验收脚本的**零额度端到端干跑**（T07D-R2-04，2026-10-02）。
 *
 * 目的：验证 `scripts/verify-t07d-r2-04-live-write.mjs` 自身的判定链路
 * （多行 JSON 解析、见到结果即收口、五项判据）**在不消耗任何真实额度**的前提下工作正常。
 *
 * 做法：起一个本地假 Provider，按脚本的提示词返回一次 createProjectFile 工具调用，
 * 并在工具成功后给出完成控制事件；把该端点通过 `--provider-endpoint` 注入脚本。
 * 真实凭证与真实端点都不会被使用。
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, "scripts", "verify-t07d-r2-04-live-write.mjs");

/**
 * 脚本把产物写在**仓库根**的 .tmp/t07d-r2-04-live/ 下（脚本内以 repositoryRoot 计算），
 * 因此干跑会真实产出该文件；干跑前先清理，结束后按需保留用于人工核对。
 */
const dryRunRelativePath = ".tmp/t07d-r2-04-live-dry/LIVE-PROOF.md";
const outputFilePath = path.join(repositoryRoot, ".tmp", "t07d-r2-04-live-dry", "LIVE-PROOF.md");
await fs.rm(path.dirname(outputFilePath), { recursive: true, force: true });

const expectedContent = [
  "# 真实 Provider 受控改动（T07D-R2-04）",
  "- 端点：api.stepfun.com",
  "- 模型：step-3.7-flash",
  "",
].join("\n");

let requestIndex = 0;
const server = http.createServer((request, response) => {
  let rawBody = "";
  request.on("data", (chunk) => (rawBody += String(chunk)));
  request.on("end", () => {
    requestIndex += 1;
    const hasToolSucceeded = rawBody.includes("已新建项目文件") || existsSync(outputFilePath);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    if (hasToolSucceeded) {
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  role: "assistant",
                  content:
                    "已完成。\nASTARRAY_TASK_COMPLETION_V1 " +
                    JSON.stringify({
                      taskExecutionId: "task-exec:t07d-r2-04",
                      completionAttemptId: "attempt-t07d-r2-04-live-1",
                      completedTaskIdentifiers: ["T-001"],
                      claimedStatus: "complete",
                      taskSequenceRevision: 1,
                    }),
                },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    } else {
      const argumentsJson = JSON.stringify({
        filePath: dryRunRelativePath,
        content: expectedContent,
      });
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "c" + String(requestIndex),
                      type: "function",
                      function: { name: "createProjectFile", arguments: argumentsJson },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
    response.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";

const child = spawn(
  process.execPath,
  [
    scriptPath,
    "--reference",
    "prov-live-1",
    "--model",
    "step-3.7-flash",
    "--provider-endpoint",
    endpoint,
    "--output-relative-path",
    dryRunRelativePath,
    "--allow-live-request",
  ],
  {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ASTARRAY_ACCEPTANCE_DRY_RUN: "1" },
  },
);
let stdoutText = "";
let stderrText = "";
child.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
child.stderr.on("data", (chunk) => (stderrText += String(chunk)));
// 干跑：脚本会把裁决输入继承给子进程；管道喂一次 allow-once 即可（真实验收要求 TTY）。
child.stdin.end("allow-once\n");

const exitCode = await new Promise((resolve) => {
  let isSettled = false;
  const settle = (code) => {
    if (isSettled) return;
    isSettled = true;
    resolve(code);
  };
  child.on("close", (code) => settle(code ?? 1));
  setTimeout(() => {
    if (!isSettled) {
      child.kill();
      settle(124);
    }
  }, 120_000);
});
server.close();

console.log("=== 干跑：验收脚本 stdout ===");
console.log(stdoutText.trim());
console.log("=== 干跑：验收脚本 stderr（尾部）===");
console.log(stderrText.trim().split("\n").slice(-6).join("\n"));
console.log("=== 干跑结论 ===");
console.log("退出码 =", exitCode, "| 请求次数 =", requestIndex);
console.log("产物存在 =", existsSync(outputFilePath));
if (existsSync(outputFilePath)) {
  const actual = readFileSync(outputFilePath, "utf8");
  console.log(
    "内容逐行一致 =",
    JSON.stringify(actual.split("\n").map((line) => line.replace(/\r$/, "")).filter((line, index, all) => !(line === "" && index >= all.length - 1))) ===
      JSON.stringify(expectedContent.split("\n")),
  );
}
// 干跑结束自清理：绝不在真实验收路径上留下任何东西。
await fs.rm(path.dirname(outputFilePath), { recursive: true, force: true });
console.log("干跑产物已自清理（真实验收路径不受影响）");
process.exitCode = exitCode === 0 ? 0 : 1;
