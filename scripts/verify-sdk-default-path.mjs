/**
 * SDK 公开入口验收（T04 + 授权端口/身份，交付级）：
 * 1. 使用本次 tarball 隔离安装（不再回退仓库源码）
 * 2. 消费者脚本**只用公开 exports**（import from "astarray"）构造 Provider 运行时
 * 3. 走正式任务运行路径默认值：不显式传 useFeedbackProcess，断言反馈进程是独立进程
 * 4. 真实驱动一次任务到 done，并干净关闭
 *
 * 用法：node scripts/verify-sdk-default-path.mjs [--tarball <路径>] [--skip-pack]
 */
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runIdentifier = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID();
const consumerRoot = path.join(repositoryRoot, ".tmp", "sdk-default-path", runIdentifier);
const packageArchiveRoot = path.join(repositoryRoot, ".tmp", "packages", runIdentifier);

const argumentsList = process.argv.slice(2);
const skipPack = argumentsList.includes("--skip-pack");
// 门禁（npm run check）单独执行；打包验收不该被套件偶发竞态卡住。
const skipPrepack = argumentsList.includes("--skip-prepack");
const tarballArgumentIndex = argumentsList.indexOf("--tarball");
const explicitTarballPath =
  tarballArgumentIndex >= 0 ? argumentsList[tarballArgumentIndex + 1] : undefined;

function fail(message) {
  console.error("SDK 默认路径验收失败: " + message);
  process.exit(1);
}

function resolveTarballPath() {
  if (explicitTarballPath !== undefined) {
    const resolved = path.resolve(explicitTarballPath);
    if (!existsSync(resolved)) fail("指定的 tarball 不存在: " + resolved);
    return resolved;
  }
  const candidates = readdirSync(repositoryRoot)
    .filter((entry) => /^astarray-.*\.tgz$/.test(entry))
    .map((entry) => path.join(repositoryRoot, entry))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (candidates.length === 0) fail("仓库根下找不到 astarray-*.tgz");
  return candidates[0];
}

mkdirSync(consumerRoot, { recursive: true });
mkdirSync(packageArchiveRoot, { recursive: true });

let tarballPath;
if (skipPack) {
  tarballPath = resolveTarballPath();
} else {
  const prepackFlag = skipPrepack ? " --ignore-scripts" : "";
  const packOutput = execSync(`npm pack --json --pack-destination "${packageArchiveRoot}"${prepackFlag}`, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  })
    .replace(/\u001B\[[0-9;]*m/g, "")
    .trim();
  const packResult = JSON.parse(packOutput.slice(packOutput.indexOf("[")))[0];
  tarballPath = path.join(packageArchiveRoot, packResult.filename);
}
console.log("使用 tarball: " + tarballPath);
console.log(
  "sha256: " +
    execFileSync("node", [
      "-e",
      `const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))`,
      tarballPath,
    ])
      .toString()
      .trim(),
);

writeFileSync(
  path.join(consumerRoot, "package.json"),
  JSON.stringify({ name: "astarray-sdk-consumer", private: true, type: "module" }, null, 2),
);
execSync(`npm install "${tarballPath}" --no-audit --no-fund`, {
  cwd: consumerRoot,
  encoding: "utf8",
  stdio: "pipe",
});

const consumerScript = `
import http from "node:http";
import {
  AstarrayApplicationFacade,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ProviderRuntimeRegistry,
  createOpenAiCompatibleProviderRegistration,
} from "astarray";

const completionMarker =
  "ASTARRAY_TASK_COMPLETION_V1 " +
  JSON.stringify({
    taskExecutionId: "task-exec:provider",
    completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
    completedTaskIdentifiers: ["T-001"],
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  });

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  request.on("end", () => {
    void body;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "已完成。\\n" + completionMarker }, finish_reason: "stop" }] }) +
        "\\n\\n",
    );
    response.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const endpoint = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";

const registry = new ProviderRuntimeRegistry({
  protectedCredentialStore: {
    doesReferenceExist: async () => true,
    readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
  },
});
registry.register(createOpenAiCompatibleProviderRegistration());

const stateDirectory = process.argv[2];
const application = await AstarrayApplicationFacade.create({
  stateDirectory,
  mode: "assist",
  runtime: "provider",
  providerRuntimeRegistry: registry,
  provider: {
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    modelIdentifier: "fake-model",
    allowedModelIdentifiers: ["fake-model"],
    requiredCapabilities: ["streaming", "tool-calling"],
    baseUrl: endpoint,
    protectedCredentialReferenceId: "cred-1",
    requestTimeoutMilliseconds: 5000,
  },
  statusPollIntervalMilliseconds: 10,
});

const diagnostics = application.getRuntimeDiagnostics();
application.createSession({ sessionId: "session-1", mode: "assist" });
await application.submitTask({ sessionId: "session-1", taskIdentifier: "task-1", prompt: "tarball 默认路径任务" });
let status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
const deadline = Date.now() + 60_000;
while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })).status;
}
await application.shutdown();
await new Promise((resolve) => server.close(() => resolve()));
process.stdout.write(JSON.stringify({ diagnostics, status }, null, 2) + "\\n");
`;
writeFileSync(path.join(consumerRoot, "consumer.mjs"), consumerScript);

const stateDirectory = path.join(consumerRoot, "state");
mkdirSync(stateDirectory, { recursive: true });
const consumerOutput = execSync("node consumer.mjs " + JSON.stringify(stateDirectory), {
  cwd: consumerRoot,
  encoding: "utf8",
  stdio: "pipe",
});
console.log(consumerOutput.trim());
const parsed = JSON.parse(consumerOutput);
if (parsed.diagnostics?.isFeedbackProcessIndependent !== true) {
  fail("默认路径未启用独立反馈进程: " + JSON.stringify(parsed.diagnostics));
}
if (parsed.status !== "done") {
  fail("任务未到达 done: " + parsed.status);
}
console.log("SDK 公开入口验收通过: 默认路径独立反馈进程 + 任务完成 ✓");
