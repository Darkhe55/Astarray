/**
 * SMART-01-04 真实运行实测：慢模型（u2-flash）在途时主 Agent 仍能接收新指令。
 *
 * 卡内验收："模拟慢模型/长下级任务仍能接收新指令；180 秒内派发或如实超时/待澄清；
 * 关闭回收，UI 状态不冒充成果完成"。
 *
 * 设计要点：
 *  - u2-flash 单次调用实测约 10 秒（真实慢模型，无需人工注入延迟）；
 *  - 先提交只读长任务 A（多次模型调用），再用 `queryTask` 判定其是否**在途**，
 *    然后在 A 在途期间提交任务 B —— "仍能接收新指令"的直接判据；
 *  - 判定"在途"只依据本地权威状态与时间差，不做字符串推断；
 *  - 凭据只经 `--credential-source state|env` 读取：state = 既有受保护凭据文件
 *    （`.astarray/providers/provider-credentials.json`），env = ASTARRAY_PROVIDER_API_KEY。
 *    本脚本**不打印、不落盘**密钥；并在运行前后断言该文件字节一致（未写入凭据）。
 *
 * 用法：
 *   node scripts/verify-u2-flash-continuous-reception.mjs
 *   node scripts/verify-u2-flash-continuous-reception.mjs --credential-source env
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.cwd();
const stateDirectory = path.join(repositoryRoot, ".astarray");
const credentialsPath = path.join(stateDirectory, "providers", "provider-credentials.json");
const credentialReferenceId = "prov-unisound-1";
const modelIdentifier = "u2-flash";
const endpointLabel = "https://maas-api.unisound.com/anthropic/v1/messages";
const dispatchDeadlineMilliseconds = 180_000;

const credentialSource = process.argv.includes("--credential-source")
  ? process.argv[process.argv.indexOf("--credential-source") + 1]
  : "state";

async function hashFileIfExists(filePath) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/** 解析凭据（不打印、不落盘）。 */
async function resolveApiKey() {
  if (credentialSource === "env") {
    const fromEnvironment = process.env.ASTARRAY_PROVIDER_API_KEY;
    if (fromEnvironment === undefined || fromEnvironment === "") {
      throw new Error("--credential-source env 要求 ASTARRAY_PROVIDER_API_KEY 已设置");
    }
    return { apiKey: fromEnvironment, baseUrl: null };
  }
  const rawContent = await fs.readFile(credentialsPath, "utf8");
  const parsed = JSON.parse(rawContent);
  const entry = parsed[credentialReferenceId];
  if (entry === undefined || typeof entry.apiKey !== "string") {
    throw new Error("受保护凭据文件中缺少条目: " + credentialReferenceId);
  }
  return { apiKey: entry.apiKey, baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : null };
}

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✓" : "✗"} ${name} — ${detail}`);
}

const credentialsHashBefore = await hashFileIfExists(credentialsPath);
const resolvedCredential = await resolveApiKey();

// Windows 绝对路径必须转为 file:// URL，ESM 加载器不接受裸盘符路径。
const publicSdkModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "public-sdk.js"),
).href;
const {
  AstarrayApplicationFacade,
  ProviderRuntimeRegistry,
  createAnthropicMessagesProviderRegistration,
  ANTHROPIC_MESSAGES_PROVIDER_ID,
} = await import(publicSdkModuleUrl);

const providerRuntimeRegistry = new ProviderRuntimeRegistry({
  protectedCredentialStore: {
    doesReferenceExist: async (referenceId) => referenceId === credentialReferenceId,
    readCredential: async (referenceId) => {
      if (referenceId !== credentialReferenceId) {
        throw new Error("未知凭据引用: " + referenceId);
      }
      return { baseUrl: resolvedCredential.baseUrl, apiKey: resolvedCredential.apiKey };
    },
  },
});
providerRuntimeRegistry.register(createAnthropicMessagesProviderRegistration());

const application = await AstarrayApplicationFacade.create({
  stateDirectory,
  mode: "assist",
  runtime: "provider",
  providerRuntimeRegistry,
  provider: {
    providerId: ANTHROPIC_MESSAGES_PROVIDER_ID,
    modelIdentifier,
    allowedModelIdentifiers: [modelIdentifier],
    // anthropic-messages 注册声明支持 streaming / tool-calling / cancellation（无 text）。
    // 只读侦察同样需要 tool-calling（读文件即工具调用）。
    requiredCapabilities: ["tool-calling"],
    // 运行时把 baseUrl 当作**完整端点**（与 CLI 的 --provider-endpoint 同约定）。
    // 凭据里存的 baseUrl 是 OpenAI 兼容的完整端点（…/v1），对 Anthropic 协议不适用，
    // 故此处显式给出 Anthropic Messages 的完整端点。
    baseUrl: endpointLabel,
    protectedCredentialReferenceId: credentialReferenceId,
    requestTimeoutMilliseconds: 120_000,
  },
  useFeedbackProcess: false,
  statusPollIntervalMilliseconds: 500,
  maximumLoopIterations: 4,
});

const sessionIdentifier = "live-u2-flash-smart04-" + String(Date.now());
application.createSession({ sessionId: sessionIdentifier, mode: "assist" });

console.log("=== 真实运行实测：u2-flash 在途接收 ===");
console.log("model=" + modelIdentifier + " endpoint=" + endpointLabel);

const taskAPrompt = [
  "只读任务，禁止修改任何文件：用 readFile 读取文件 package.json，然后一句话回答 name 字段的值。",
  "完成时必须在最后一行单独输出（不得放进代码块，其后不得再有内容）：",
  'ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"local-execution-T-001","completionAttemptId":"attempt-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":0,"declaredArtifacts":[]}',
].join("\n");

const submitStartedMilliseconds = Date.now();
let firstSubmission;
try {
  firstSubmission = await application.submitTask({
    sessionId: sessionIdentifier,
    taskIdentifier: "live-task-A",
    prompt: taskAPrompt,
    idempotencyKey: "live-u2-flash-A",
  });
} catch (error) {
  console.error("任务 A 提交失败: " + error.message);
  await application.shutdown().catch(() => {});
  process.exit(1);
}
const firstDispatchElapsedMilliseconds = Date.now() - submitStartedMilliseconds;
console.log(
  "任务 A 已受理: mission=" +
    firstSubmission.missionIdentifier +
    " status=" +
    firstSubmission.status +
    " 派发耗时=" +
    String(firstDispatchElapsedMilliseconds) +
    "ms",
);
record(
  "① 长只读任务在 180 秒内被受理并派发",
  firstDispatchElapsedMilliseconds < dispatchDeadlineMilliseconds,
  "派发耗时 " + String(firstDispatchElapsedMilliseconds) + "ms",
);

// 在途判定：本地权威状态 + 未超过期限
const immediateStatus = await application.queryTask({
  sessionId: sessionIdentifier,
  taskIdentifier: "live-task-A",
});
// 真实 PublicTaskStatus: accepted|running|blocked|done|failed|cancelled
const isFirstInFlight = ["accepted", "running", "blocked"].includes(immediateStatus.status);
console.log("任务 A 即时状态: " + immediateStatus.status);
record("② 任务 A 提交后处于在途（尚未完成）", isFirstInFlight, "状态=" + immediateStatus.status);

// 在途期间提交第二条指令 —— 核心判据
const secondSubmitStartedMilliseconds = Date.now();
let secondSubmission = null;
let secondSubmitErrorMessage = null;
try {
  secondSubmission = await application.submitTask({
    sessionId: sessionIdentifier,
    taskIdentifier: "live-task-B",
    prompt: [
      "只读回答，禁止修改任何文件：用 readFile 读取 package.json，一句话回答 name 字段的值。",
      "完成时必须在最后一行单独输出（不得放进代码块，其后不得再有内容）：",
      'ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"local-execution-T-001","completionAttemptId":"attempt-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":0,"declaredArtifacts":[]}',
    ].join("\n"),
    idempotencyKey: "live-u2-flash-B",
  });
} catch (error) {
  secondSubmitErrorMessage = error.message;
}
const secondSubmitElapsedMilliseconds = Date.now() - secondSubmitStartedMilliseconds;
console.log(
  "任务 B 提交结果: " +
    (secondSubmission === null
      ? "失败 " + String(secondSubmitErrorMessage)
      : "mission=" + secondSubmission.missionIdentifier + " status=" + secondSubmission.status) +
    " 耗时=" +
    String(secondSubmitElapsedMilliseconds) +
    "ms",
);
record(
  "③ 在途期间仍能接收新指令",
  isFirstInFlight && secondSubmission !== null && secondSubmitElapsedMilliseconds < dispatchDeadlineMilliseconds,
  "接收耗时 " + String(secondSubmitElapsedMilliseconds) + "ms（未超 180 秒）",
);

// 关闭回收：等待两条任务收敛
const settleDeadlineMilliseconds = Date.now() + 420_000;
let firstFinal = null;
let secondFinal = null;
while (Date.now() < settleDeadlineMilliseconds) {
  firstFinal = await application.queryTask({ sessionId: sessionIdentifier, taskIdentifier: "live-task-A" });
  secondFinal = await application.queryTask({ sessionId: sessionIdentifier, taskIdentifier: "live-task-B" });
  const firstSettled = ["done", "failed", "cancelled"].includes(firstFinal.status);
  const secondSettled = ["done", "failed", "cancelled"].includes(secondFinal.status);
  if (firstSettled && secondSettled) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
console.log("任务 A 终态: " + String(firstFinal?.status) + "；任务 B 终态: " + String(secondFinal?.status));
record(
  "④ 派发状态与成果完成可区分（派发 ≠ 完成）",
  // 必须同时满足：提交时确实只是 accepted，且终态里有**成功**的成果。
  // 早期版本只断言"终态不再是 accepted"，会把 failure/blocked 也算作通过（实测踩到，已修正）。
  firstSubmission.status === "accepted" && firstFinal !== null && firstFinal.status === "done",
  "提交时=" + firstSubmission.status + " 终态=" + String(firstFinal?.status),
);
// 终态集合（与 PublicTaskStatus 一致）
const settledStatuses = new Set(["done", "failed", "cancelled", "blocked"]);
record(
  "⑤ 两条指令均收敛到终态（关闭回收）",
  firstFinal !== null &&
    secondFinal !== null &&
    settledStatuses.has(firstFinal.status) &&
    settledStatuses.has(secondFinal.status),
  "A=" + String(firstFinal?.status) + " B=" + String(secondFinal?.status),
);
// 真实运行必须真正产出成果；若收敛到 blocked/failed，如实记为失败而不是"通过"。
const succeededCount = [firstFinal?.status, secondFinal?.status].filter(
  (status) => status === "done",
).length;
record(
  "⑥ 真实运行确实产出了成果（至少一条 done）",
  succeededCount >= 1,
  "done 条数=" + String(succeededCount) + "（A=" + String(firstFinal?.status) + " B=" + String(secondFinal?.status) + "）",
);
record(
  "⑦ 两条指令都产出成果（并行下均成功）",
  firstFinal?.status === "done" && secondFinal?.status === "done",
  "A=" + String(firstFinal?.status) + " B=" + String(secondFinal?.status),
);

await application.shutdown().catch(() => {});

const credentialsHashAfter = await hashFileIfExists(credentialsPath);
record(
  "⑧ 实测未写入受保护凭据（字节一致）",
  credentialsHashAfter === credentialsHashBefore,
  credentialsHashAfter === credentialsHashBefore ? "一致" : "已变化",
);

const failedCheckNames = checks.filter((check) => !check.passed).map((check) => check.name);
const verdict = {
  schemaVersion: 1,
  generatedAtIso: new Date().toISOString(),
  vendorIdentifier: "unisound",
  modelIdentifier,
  protocolLabel: "anthropic-messages",
  endpointLabel,
  credentialSource,
  sessionIdentifier,
  taskAFinalStatus: firstFinal?.status ?? null,
  taskBFinalStatus: secondFinal?.status ?? null,
  firstDispatchElapsedMilliseconds,
  secondSubmitElapsedMilliseconds,
  checks,
  failedCheckNames,
  isPassed: failedCheckNames.length === 0,
};
const verdictPath = path.join(repositoryRoot, ".tmp", "live-u2-flash", "acceptance-verdict.json");
await fs.mkdir(path.dirname(verdictPath), { recursive: true });
await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2) + "\n", "utf8");

console.log("");
console.log(
  "验收结论: " +
    (verdict.isPassed ? "通过" : "未通过") +
    "（" +
    String(checks.length - failedCheckNames.length) +
    "/" +
    String(checks.length) +
    " 项）",
);
console.log("判据落盘: " + path.relative(repositoryRoot, verdictPath));
if (!verdict.isPassed) {
  console.log("未通过项: " + failedCheckNames.join("、"));
}
process.exit(verdict.isPassed ? 0 : 1);
