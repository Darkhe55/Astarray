/**
 * TOOLKIT-01-06 真实运行实测：重复只读任务的**真实 Provider token 消耗**、延迟与成本边界。
 *
 * 卡内验收："报告工具调用数、模型请求/token、延迟…及构建成本；无真实 usage 标为未测，不杜撰节省"。
 *
 * 设计要点（沿用 SMART-01-04 实测脚本 `verify-u2-flash-continuous-reception.mjs` 的装配方式）：
 *  - 每轮提交**一个只读任务**（readFile 读取 package.json 并作答），记录该轮墙钟耗时；
 *  - 真实用量只从**账目文件**读取：`<state-dir>/usage/entries.json`
 *    （`UsageLedgerStore` 使用的文件名；源码里是模块私有常量，此处按字面量对齐）；
 *  - 账目纪律与 `usage-ledger-store.aggregateUsageEntries` 一致：`null` = **未测**
 *    （厂商未返回 usage），**绝不当 0**；估算条目（isEstimated=true）不进账单口径；
 *    子量（attribution.kind="subtotal"）不重复计入总量；
 *  - 工具调用数：公开门面（`PublicTaskResult` / `MissionStatus`）**不暴露**该计数，
 *    且 `perfSampleSink` 只被 `runtime/tool-loop.ts` 声明、**未接线到应用装配**
 *    ⇒ 无持久化取证，按"未测"如实汇报，不猜测；
 *  - 凭据只按既有引用 id 从受保护凭据文件读取，**不打印、不落盘**；
 *    运行前后断言该文件 sha256 一致（字节未变）；
 *  - 退出码用 `process.exitCode`（**不用 `process.exit()`**：在途 socket 上调用
 *    `process.exit()` 会在 Windows / Node 24 触发 libuv 断言崩溃，姊妹脚本已实测踩到）。
 *
 * 用法：
 *   node scripts/verify-u2-flash-token-usage.mjs
 *   node scripts/verify-u2-flash-token-usage.mjs --rounds 1
 *   node scripts/verify-u2-flash-token-usage.mjs --rounds 2 --state-dir .tmp/live-u2-flash-usage-state
 *   node scripts/verify-u2-flash-token-usage.mjs --credential-file .astarray/providers/provider-credentials.json
 *
 * 注意：每轮都是**真实计费调用**，`--rounds` 硬上限 5（护栏，避免烧配额）。
 */
import console from "node:console";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.cwd();
const credentialReferenceId = "prov-unisound-1";
const vendorIdentifier = "unisound";
const modelIdentifier = "u2-flash";
const protocolLabel = "anthropic-messages";
const endpointLabel = "https://maas-api.unisound.com/anthropic/v1/messages";
const defaultCredentialFilePath = path.join(
  ".astarray",
  "providers",
  "provider-credentials.json",
);
const defaultStateDirectory = path.join(".tmp", "live-u2-flash-usage-state");
/** 账目文件名（`packages/core/src/orchestration/usage-ledger-store.ts` 内私有常量 USAGE_LEDGER_FILE_NAME）。 */
const usageLedgerFileName = "entries.json";
/** 配额护栏：--rounds 硬上限（每次真实调用都计费）。 */
const maximumRoundCount = 5;
const roundDeadlineMilliseconds = 300_000;
const ledgerSettleDeadlineMilliseconds = 20_000;
const statusPollIntervalMilliseconds = 500;
const ledgerPollIntervalMilliseconds = 500;
/** 视作"可以停止等待"的状态集合（blocked 非公开门面的终态，但不会再自行推进）。 */
const settledStatuses = new Set(["done", "failed", "cancelled", "blocked"]);
/** 费用口径：价格表未配置时不得以本地估算冒充账单（与 usage-ledger-store 一致）。 */
const costNotMeasuredReason =
  "价格表未配置：无法给出费用/节省估算（不得以本地估算冒充官方账单）";
const toolCallCountNotMeasuredReason =
  "公开门面（PublicTaskResult / MissionStatus）不暴露工具调用计数；perfSampleSink 仅在 runtime/tool-loop.ts 声明、未接线到应用装配 ⇒ 无持久化取证，标为未测，不猜测";

/**
 * 只读任务提示词：与 SMART-01-04 实测脚本同构（读 package.json + 末行完成控制事件）。
 * 每轮使用同一提示词，使轮间 token 消耗可比。
 */
const readOnlyTaskPrompt = [
  "只读任务，禁止修改任何文件：用 readFile 读取文件 package.json，然后一句话回答 name 字段的值。",
  "完成时必须在最后一行单独输出（不得放进代码块，其后不得再有内容）：",
  'ASTARRAY_TASK_COMPLETION_V1 {"taskExecutionId":"local-execution-T-001","completionAttemptId":"attempt-1","completedTaskIdentifiers":["T-001"],"claimedStatus":"complete","taskSequenceRevision":0,"declaredArtifacts":[]}',
].join("\n");

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

/** 只做存在性与内容哈希断言：不解析、不打印文件内容。 */
async function hashFileIfExists(filePath) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/** 按既有引用 id 解析凭据（不打印、不落盘）。 */
async function resolveProtectedCredential(credentialsFilePath) {
  const rawContent = await fs.readFile(credentialsFilePath, "utf8");
  const parsed = JSON.parse(rawContent);
  const entry = parsed[credentialReferenceId];
  if (entry === undefined || typeof entry.apiKey !== "string") {
    throw new Error("受保护凭据文件中缺少条目: " + credentialReferenceId);
  }
  // 注意：anthropic-messages 使用装配层显式给出的**完整端点**，
  // 凭据里存的 baseUrl（OpenAI 兼容端点）只作为缺省回退，不作诊断输出。
  return {
    apiKey: entry.apiKey,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : null,
  };
}

function readTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 账目条目归一（只保留判定所需字段）。不可用条目返回 null，由调用方剔除。 */
function normalizeLedgerEntry(rawEntry) {
  if (rawEntry === null || typeof rawEntry !== "object") {
    return null;
  }
  if (typeof rawEntry.requestIdentifier !== "string") {
    return null;
  }
  const attribution = rawEntry.attribution;
  return {
    requestIdentifier: rawEntry.requestIdentifier,
    missionIdentifier:
      typeof rawEntry.missionIdentifier === "string" ? rawEntry.missionIdentifier : null,
    inputTokenCount: readTokenCount(rawEntry.inputTokenCount),
    outputTokenCount: readTokenCount(rawEntry.outputTokenCount),
    cachedTokenCount: readTokenCount(rawEntry.cachedTokenCount),
    isEstimated: rawEntry.isEstimated === true,
    // 子量不得重复计入总量：只认显式 total 归属。
    isTotalAttribution:
      attribution !== null &&
      typeof attribution === "object" &&
      attribution.kind === "total",
    missingUsageReason:
      typeof rawEntry.missingUsageReason === "string" &&
      rawEntry.missingUsageReason.length > 0
        ? rawEntry.missingUsageReason
        : null,
  };
}

/**
 * 读取账目文件。
 *
 * 缺失 / 损坏**如实上报**（status 三态），不把"读不到"伪装成"零消耗"。
 */
async function readUsageLedger(ledgerFilePath) {
  let rawContent;
  try {
    rawContent = await fs.readFile(ledgerFilePath, "utf8");
  } catch (error) {
    return {
      status: error.code === "ENOENT" ? "missing" : "unreadable",
      errorMessage: error.message,
      entries: [],
    };
  }
  try {
    const parsed = JSON.parse(rawContent);
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries = rawEntries.map(normalizeLedgerEntry).filter(Boolean);
    return { status: "read", errorMessage: null, entries };
  } catch (error) {
    return { status: "corrupt", errorMessage: error.message, entries: [] };
  }
}

/**
 * 某一维度的 token 合计。
 *
 * 纪律（与 `aggregateUsageEntries` 一致）：**未知不得当 0** ——
 * 没有条目、或任一条目为 null，都返回 null，调用方必须显示"未测"。
 */
function sumTokenCountOrNotMeasured(tokenCounts) {
  if (tokenCounts.length === 0) {
    return null;
  }
  if (tokenCounts.some((tokenCount) => tokenCount === null)) {
    return null;
  }
  return tokenCounts.reduce((total, tokenCount) => total + tokenCount, 0);
}

function collectMissingUsageReasons(entries) {
  const reasons = new Set();
  for (const entry of entries) {
    if (entry.missingUsageReason !== null) {
      reasons.add(entry.missingUsageReason);
    }
  }
  return [...reasons].sort();
}

function hasRealUsage(entry) {
  return (
    !entry.isEstimated &&
    entry.inputTokenCount !== null &&
    entry.outputTokenCount !== null
  );
}

/**
 * 账目聚合（只统计 total 归属条目）。
 *
 *  - `inputTokenCount` 等：全量口径；任一条目为 null ⇒ null（**未测**）；
 *  - `measured*`：仅**非估算**条目的账单口径；无可用条目 ⇒ null（未测）。
 */
function aggregateUsageEntries(entries) {
  const totalEntries = entries.filter((entry) => entry.isTotalAttribution);
  const measuredEntries = totalEntries.filter((entry) => !entry.isEstimated);
  const sum = (list, fieldName) =>
    sumTokenCountOrNotMeasured(list.map((entry) => entry[fieldName]));
  return {
    entryCount: totalEntries.length,
    estimatedEntryCount: totalEntries.filter((entry) => entry.isEstimated).length,
    realUsageEntryCount: totalEntries.filter(hasRealUsage).length,
    missingUsageEntryCount: totalEntries.filter(
      (entry) => entry.inputTokenCount === null || entry.outputTokenCount === null,
    ).length,
    missingUsageReasons: collectMissingUsageReasons(totalEntries),
    inputTokenCount: sum(totalEntries, "inputTokenCount"),
    outputTokenCount: sum(totalEntries, "outputTokenCount"),
    cachedTokenCount: sum(totalEntries, "cachedTokenCount"),
    measuredInputTokenCount: sum(measuredEntries, "inputTokenCount"),
    measuredOutputTokenCount: sum(measuredEntries, "outputTokenCount"),
    measuredCachedTokenCount: sum(measuredEntries, "cachedTokenCount"),
  };
}

function summarizeLatencyMilliseconds(values) {
  if (values.length === 0) {
    return {
      roundCount: 0,
      meanMilliseconds: null,
      minimumMilliseconds: null,
      maximumMilliseconds: null,
    };
  }
  const totalMilliseconds = values.reduce((total, value) => total + value, 0);
  return {
    roundCount: values.length,
    meanMilliseconds: Math.round(totalMilliseconds / values.length),
    minimumMilliseconds: Math.min(...values),
    maximumMilliseconds: Math.max(...values),
  };
}

/** 把 null 渲染成"未测"（绝不渲染成 0）。 */
function formatTokenCount(tokenCount) {
  return tokenCount === null ? "未测" : String(tokenCount);
}

function formatLatency(milliseconds) {
  return milliseconds === null ? "未测" : String(milliseconds) + "ms";
}

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✓" : "✗"} ${name} — ${detail}`);
}

/** 某维度为 null 时给出"未测"的**具体原因**（不猜、不补 0）。 */
function describeNotMeasuredUsage(usage, isMeasuredSubset) {
  if (usage.entryCount === 0) {
    return "账目中没有归属本轮的条目 ⇒ 该维度未测得（不得记为 0）";
  }
  if (isMeasuredSubset && usage.estimatedEntryCount === usage.entryCount) {
    return (
      "全部 " +
      String(usage.entryCount) +
      " 条账目均为估算（isEstimated=true），账单口径无可用条目 ⇒ 未测"
    );
  }
  if (usage.missingUsageEntryCount > 0) {
    return (
      "有 " +
      String(usage.missingUsageEntryCount) +
      " 条账目缺 usage（原因: " +
      usage.missingUsageReasons.join("、") +
      "）；未知不得补 0 ⇒ 未测"
    );
  }
  return "该字段在所有归属条目上均为 null（厂商未返回该维度）⇒ 未测，不得补 0";
}

async function main() {
  const requestedRoundCount = Number.parseInt(readArgument("--rounds", "2"), 10);
  if (!Number.isInteger(requestedRoundCount) || requestedRoundCount < 1) {
    console.error(
      "--rounds 必须是 ≥ 1 的整数（默认 2，硬上限 " +
        String(maximumRoundCount) +
        "）；本次不做任何真实调用",
    );
    return 2;
  }
  const roundCount = Math.min(requestedRoundCount, maximumRoundCount);
  if (roundCount !== requestedRoundCount) {
    console.error(
      "--rounds " +
        String(requestedRoundCount) +
        " 超过硬上限，已截断为 " +
        String(roundCount) +
        " 轮（每次真实调用都计费）",
    );
  }
  const stateDirectory = path.resolve(
    repositoryRoot,
    readArgument("--state-dir", defaultStateDirectory),
  );
  const credentialsFilePath = path.resolve(
    repositoryRoot,
    readArgument("--credential-file", defaultCredentialFilePath),
  );
  const ledgerFilePath = path.join(stateDirectory, "usage", usageLedgerFileName);
  const verdictFilePath = path.join(stateDirectory, "acceptance-verdict.json");

  console.log("=== 真实运行实测：u2-flash 重复只读任务的 token 消耗 ===");
  console.log(
    "model=" +
      modelIdentifier +
      " protocol=" +
      protocolLabel +
      " endpoint=" +
      endpointLabel,
  );
  console.log("rounds=" + String(roundCount) + " state-dir=" + stateDirectory);
  console.log(
    "凭据引用=" +
      credentialReferenceId +
      " 凭据文件（不打印内容）=" +
      path.relative(repositoryRoot, credentialsFilePath),
  );

  const credentialsHashBefore = await hashFileIfExists(credentialsFilePath);
  if (credentialsHashBefore === null) {
    console.error("受保护凭据文件不存在或不可读（终止，且不打印内容）");
    return 2;
  }
  let resolvedCredential;
  try {
    resolvedCredential = await resolveProtectedCredential(credentialsFilePath);
  } catch (error) {
    /**
     * 有意**不**回显底层消息：JSON 语法错误的消息会带上文件片段，
     * 可能把 apiKey 打进终端/日志。只给出分类信息。
     */
    console.error(
      "读取受保护凭据失败（引用 " +
        credentialReferenceId +
        "）：" +
        (error instanceof SyntaxError
          ? "凭据文件不是合法 JSON（内容不打印）"
          : String(error.message)),
    );
    return 2;
  }
  await fs.mkdir(stateDirectory, { recursive: true });

  // 运行前基线：用于区分"本轮新增账目"与目录里既有的历史账目。
  const ledgerBeforeRun = await readUsageLedger(ledgerFilePath);
  const existingRequestIdentifiers = new Set(
    ledgerBeforeRun.entries.map((entry) => entry.requestIdentifier),
  );
  console.log(
    "运行前账目: " +
      (ledgerBeforeRun.status === "read"
        ? String(ledgerBeforeRun.entries.length) + " 条"
        : ledgerBeforeRun.status + "（" + String(ledgerBeforeRun.errorMessage) + "）"),
  );

  /**
   * Windows 绝对路径必须转为 file:// URL，ESM 加载器不接受裸盘符路径。
   * 只消费**已构建**的公共 SDK（dist/public-sdk.js）。
   */
  const publicSdkModuleUrl = pathToFileURL(
    path.join(repositoryRoot, "dist", "public-sdk.js"),
  ).href;

  const roundRecords = [];
  let application = null;
  let measurementErrorMessage = null;
  try {
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
          return {
            baseUrl: resolvedCredential.baseUrl,
            apiKey: resolvedCredential.apiKey,
          };
        },
      },
    });
    providerRuntimeRegistry.register(createAnthropicMessagesProviderRegistration());

    application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "provider",
      providerRuntimeRegistry,
      provider: {
        providerId: ANTHROPIC_MESSAGES_PROVIDER_ID,
        modelIdentifier,
        allowedModelIdentifiers: [modelIdentifier],
        // anthropic-messages 注册声明支持 streaming / tool-calling / cancellation；
        // 只读侦察同样需要 tool-calling（读文件即工具调用）。
        requiredCapabilities: ["tool-calling"],
        // 运行时把 baseUrl 当作**完整端点**（与 CLI 的 --provider-endpoint 同约定）。
        // 凭据里存的 baseUrl 是 OpenAI 兼容端点，对 anthropic-messages 不适用（会 404），
        // 故此处显式给出 Anthropic Messages 的完整端点。
        baseUrl: endpointLabel,
        protectedCredentialReferenceId: credentialReferenceId,
        requestTimeoutMilliseconds: 120_000,
      },
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds,
      maximumLoopIterations: 4,
    });

    const sessionIdentifier = "live-u2-flash-usage-" + String(Date.now());
    application.createSession({ sessionId: sessionIdentifier, mode: "assist" });
    console.log("session=" + sessionIdentifier);

    for (let roundIndex = 1; roundIndex <= roundCount; roundIndex += 1) {
      const taskIdentifier = "live-usage-task-" + String(roundIndex);
      const roundStartedAtMilliseconds = Date.now();
      let submission = null;
      let submitErrorMessage = null;
      try {
        submission = await application.submitTask({
          sessionId: sessionIdentifier,
          taskIdentifier,
          prompt: readOnlyTaskPrompt,
          idempotencyKey: "live-u2-flash-usage-" + String(roundIndex),
        });
      } catch (error) {
        submitErrorMessage = error.message;
      }
      if (submission === null) {
        console.error(
          "第 " + String(roundIndex) + " 轮提交失败: " + String(submitErrorMessage),
        );
        roundRecords.push({
          roundIndex,
          taskIdentifier,
          missionIdentifier: null,
          status: "submit-failed",
          isRoundTimedOut: false,
          roundLatencyMilliseconds: null,
          submitErrorMessage,
          queryErrorMessage: null,
        });
        // 装配/凭据层面的失败：继续跑只会重复烧配额，立即止损。
        break;
      }

      let taskStatus = submission.status;
      let queryErrorMessage = null;
      const roundDeadlineAtMilliseconds = Date.now() + roundDeadlineMilliseconds;
      while (!settledStatuses.has(taskStatus) && Date.now() < roundDeadlineAtMilliseconds) {
        await sleep(statusPollIntervalMilliseconds);
        try {
          const queriedTask = await application.queryTask({
            sessionId: sessionIdentifier,
            taskIdentifier,
          });
          taskStatus = queriedTask.status;
        } catch (error) {
          queryErrorMessage = error.message;
          break;
        }
      }
      const roundLatencyMilliseconds = Date.now() - roundStartedAtMilliseconds;
      const isRoundTimedOut =
        !settledStatuses.has(taskStatus) && Date.now() >= roundDeadlineAtMilliseconds;
      console.log(
        "第 " +
          String(roundIndex) +
          " 轮: mission=" +
          submission.missionIdentifier +
          " 终态=" +
          taskStatus +
          " 耗时=" +
          String(roundLatencyMilliseconds) +
          "ms" +
          (queryErrorMessage === null ? "" : "（查询异常: " + queryErrorMessage + "）"),
      );
      roundRecords.push({
        roundIndex,
        taskIdentifier,
        missionIdentifier: submission.missionIdentifier,
        status: taskStatus,
        isRoundTimedOut,
        roundLatencyMilliseconds,
        submitErrorMessage: null,
        queryErrorMessage,
      });
    }
  } catch (error) {
    measurementErrorMessage = error.message;
    console.error("实测过程异常终止: " + error.message);
  }
  if (application !== null) {
    // 关闭回收：让在途 socket 收敛后再读盘（不用 process.exit 硬断）。
    await application.shutdown().catch(() => undefined);
  }

  const completedRoundCount = roundRecords.filter(
    (roundRecord) => roundRecord.status === "done",
  ).length;

  /** 账目由运行时观测端口异步落盘：有界等待"已完成轮次至少各有一条账目"。 */
  let ledger = await readUsageLedger(ledgerFilePath);
  const ledgerSettleDeadlineAtMilliseconds =
    Date.now() + ledgerSettleDeadlineMilliseconds;
  for (;;) {
    ledger = await readUsageLedger(ledgerFilePath);
    const completedMissionIdentifiers = roundRecords
      .filter((roundRecord) => roundRecord.status === "done")
      .map((roundRecord) => roundRecord.missionIdentifier);
    const hasEveryCompletedRoundEntry = completedMissionIdentifiers.every(
      (missionIdentifier) =>
        missionIdentifier !== null &&
        ledger.entries.some(
          (entry) => entry.missionIdentifier === missionIdentifier && entry.isTotalAttribution,
        ),
    );
    if (hasEveryCompletedRoundEntry || Date.now() >= ledgerSettleDeadlineAtMilliseconds) {
      break;
    }
    await sleep(ledgerPollIntervalMilliseconds);
  }

  const missionIdentifiersThisRun = new Set(
    roundRecords
      .map((roundRecord) => roundRecord.missionIdentifier)
      .filter((missionIdentifier) => missionIdentifier !== null),
  );
  const attributedEntries = ledger.entries.filter(
    (entry) =>
      entry.missionIdentifier !== null &&
      missionIdentifiersThisRun.has(entry.missionIdentifier),
  );
  const newEntries = ledger.entries.filter(
    (entry) => !existingRequestIdentifiers.has(entry.requestIdentifier),
  );
  const unattributedNewEntryCount = newEntries.filter(
    (entry) =>
      entry.missionIdentifier === null ||
      !missionIdentifiersThisRun.has(entry.missionIdentifier),
  ).length;

  const perRound = roundRecords.map((roundRecord) => {
    const roundEntries =
      roundRecord.missionIdentifier === null
        ? []
        : attributedEntries.filter(
            (entry) => entry.missionIdentifier === roundRecord.missionIdentifier,
          );
    const usage = aggregateUsageEntries(roundEntries);
    return {
      roundIndex: roundRecord.roundIndex,
      taskIdentifier: roundRecord.taskIdentifier,
      missionIdentifier: roundRecord.missionIdentifier,
      status: roundRecord.status,
      isRoundTimedOut: roundRecord.isRoundTimedOut,
      roundLatencyMilliseconds: roundRecord.roundLatencyMilliseconds,
      submitErrorMessage: roundRecord.submitErrorMessage,
      queryErrorMessage: roundRecord.queryErrorMessage,
      ...usage,
      modelRequestCount: usage.entryCount,
      toolCallCount: null,
      toolCallCountNotMeasuredReason,
    };
  });

  const runUsage = aggregateUsageEntries(attributedEntries);
  const latency = summarizeLatencyMilliseconds(
    roundRecords
      .map((roundRecord) => roundRecord.roundLatencyMilliseconds)
      .filter((milliseconds) => milliseconds !== null),
  );
  const totals = {
    plannedRoundCount: roundCount,
    completedRoundCount,
    modelRequestCount: runUsage.entryCount,
    ledgerEntryCountAfterRun: ledger.entries.length,
    newLedgerEntryCount: newEntries.length,
    unattributedNewEntryCount,
    estimatedEntryCount: runUsage.estimatedEntryCount,
    realUsageEntryCount: runUsage.realUsageEntryCount,
    missingUsageEntryCount: runUsage.missingUsageEntryCount,
    missingUsageReasons: runUsage.missingUsageReasons,
    inputTokenCount: runUsage.inputTokenCount,
    outputTokenCount: runUsage.outputTokenCount,
    cachedTokenCount: runUsage.cachedTokenCount,
    measuredInputTokenCount: runUsage.measuredInputTokenCount,
    measuredOutputTokenCount: runUsage.measuredOutputTokenCount,
    measuredCachedTokenCount: runUsage.measuredCachedTokenCount,
    latencyMilliseconds: latency,
    toolCallCount: null,
    toolCallCountNotMeasuredReason,
    costEstimateAmountMinorUnits: null,
    costNotMeasuredReason,
  };

  // ── 判据 ──
  record(
    "① 每一轮只读任务均达到终态 done",
    roundRecords.length === roundCount &&
      roundRecords.every((roundRecord) => roundRecord.status === "done"),
    "轮次终态: " +
      (roundRecords.length === 0
        ? "无已提交轮次"
        : roundRecords
            .map(
              (roundRecord) =>
                "#" + String(roundRecord.roundIndex) + "=" + String(roundRecord.status),
            )
            .join(" ")) +
      "（计划 " +
      String(roundCount) +
      " 轮）",
  );

  const roundsWithLedgerEntry = perRound.filter(
    (roundRecord) => roundRecord.status === "done" && roundRecord.modelRequestCount >= 1,
  ).length;
  record(
    "② 每完成一轮至少有一条对应账目",
    completedRoundCount > 0 && roundsWithLedgerEntry === completedRoundCount,
    "完成 " +
      String(completedRoundCount) +
      " 轮，其中有账目的 " +
      String(roundsWithLedgerEntry) +
      " 轮；本轮新增账目 " +
      String(newEntries.length) +
      " 条" +
      (unattributedNewEntryCount === 0
        ? ""
        : "（其中 " +
          String(unattributedNewEntryCount) +
          " 条无法归属到本轮 mission，已如实标注）") +
      "；账目文件状态=" +
      ledger.status,
  );

  record(
    "③ 至少一条账目给出真实（非 null、非估算）token 用量",
    runUsage.realUsageEntryCount >= 1,
    "真实用量条目=" +
      String(runUsage.realUsageEntryCount) +
      "；估算条目=" +
      String(runUsage.estimatedEntryCount) +
      "；缺 usage 条目=" +
      String(runUsage.missingUsageEntryCount) +
      (runUsage.missingUsageReasons.length === 0
        ? ""
        : "（原因: " + runUsage.missingUsageReasons.join("、") + "）"),
  );

  const entriesWithMissingUsage = attributedEntries.filter(
    (entry) =>
      entry.isTotalAttribution &&
      (entry.inputTokenCount === null || entry.outputTokenCount === null),
  );
  const entriesWithMissingUsageReasonCount = entriesWithMissingUsage.filter(
    (entry) => entry.missingUsageReason !== null,
  ).length;
  record(
    "④ 缺 usage 的账目均写明原因（未静默补 0）",
    entriesWithMissingUsageReasonCount === entriesWithMissingUsage.length,
    "缺 usage 条目=" +
      String(entriesWithMissingUsage.length) +
      "，带原因=" +
      String(entriesWithMissingUsageReasonCount),
  );

  record(
    "⑤ 实测流程未异常终止",
    measurementErrorMessage === null,
    measurementErrorMessage === null
      ? "装配、轮次与关闭回收均正常返回"
      : "异常: " + measurementErrorMessage,
  );

  const credentialsHashAfter = await hashFileIfExists(credentialsFilePath);
  record(
    "⑥ 实测未写入受保护凭据（sha256 一致）",
    credentialsHashAfter === credentialsHashBefore,
    credentialsHashAfter === credentialsHashBefore
      ? "一致"
      : "已变化（凭据文件被写入，失败）",
  );

  // ── 未测清单（无真实数据一律标未测，不杜撰） ──
  const notMeasured = [];
  const addTokenNotMeasured = (metric, tokenCount, usage, isMeasuredSubset) => {
    if (tokenCount === null) {
      notMeasured.push({
        scope: "run",
        metric,
        reason: describeNotMeasuredUsage(usage, isMeasuredSubset),
      });
    }
  };
  addTokenNotMeasured("inputTokenCount", runUsage.inputTokenCount, runUsage, false);
  addTokenNotMeasured("outputTokenCount", runUsage.outputTokenCount, runUsage, false);
  addTokenNotMeasured("cachedTokenCount", runUsage.cachedTokenCount, runUsage, false);
  addTokenNotMeasured(
    "measuredInputTokenCount",
    runUsage.measuredInputTokenCount,
    runUsage,
    true,
  );
  addTokenNotMeasured(
    "measuredOutputTokenCount",
    runUsage.measuredOutputTokenCount,
    runUsage,
    true,
  );
  addTokenNotMeasured(
    "measuredCachedTokenCount",
    runUsage.measuredCachedTokenCount,
    runUsage,
    true,
  );
  if (latency.meanMilliseconds === null) {
    notMeasured.push({
      scope: "run",
      metric: "latencyMilliseconds",
      reason: "没有成功提交的轮次 ⇒ 无延迟样本（未测得，不得记为 0）",
    });
  }
  notMeasured.push({
    scope: "run",
    metric: "toolCallCount",
    reason: toolCallCountNotMeasuredReason,
  });
  notMeasured.push({
    scope: "run",
    metric: "costEstimateAmountMinorUnits",
    reason: costNotMeasuredReason,
  });
  const perRoundNotMeasuredCount = perRound.filter(
    (roundRecord) => roundRecord.missingUsageEntryCount > 0 || roundRecord.modelRequestCount === 0,
  ).length;
  if (perRoundNotMeasuredCount > 0) {
    notMeasured.push({
      scope: "per-round",
      metric: "roundTokenCounts",
      reason:
        String(perRoundNotMeasuredCount) +
        " 轮的账目缺 usage 或无账目（见 perRound 中的 missingUsageReasons / modelRequestCount=0）",
    });
  }

  // ── 报告 ──
  console.log("");
  console.log("=== 汇总（真实账目口径） ===");
  console.log("完成轮次: " + String(completedRoundCount) + "/" + String(roundCount));
  console.log("模型请求数（账目条目）: " + String(totals.modelRequestCount));
  console.log(
    "总用量口径: 全量 total 条目（含估算 " +
      String(totals.estimatedEntryCount) +
      " 条；估算不得用于账单结论）",
  );
  console.log("总 input tokens: " + formatTokenCount(totals.inputTokenCount));
  console.log("总 output tokens: " + formatTokenCount(totals.outputTokenCount));
  console.log("总 cached tokens: " + formatTokenCount(totals.cachedTokenCount));
  console.log(
    "仅非估算子集: input=" +
      formatTokenCount(totals.measuredInputTokenCount) +
      " output=" +
      formatTokenCount(totals.measuredOutputTokenCount) +
      " cached=" +
      formatTokenCount(totals.measuredCachedTokenCount),
  );
  console.log(
    "延迟: mean=" +
      formatLatency(latency.meanMilliseconds) +
      " min=" +
      formatLatency(latency.minimumMilliseconds) +
      " max=" +
      formatLatency(latency.maximumMilliseconds) +
      "（样本 " +
      String(latency.roundCount) +
      " 轮）",
  );
  console.log("工具调用数: 未测 — " + toolCallCountNotMeasuredReason);
  console.log("费用/节省估算: 未测 — " + costNotMeasuredReason);
  console.log("账目文件: " + path.relative(repositoryRoot, ledgerFilePath) + "（" + ledger.status + "）");
  for (const roundRecord of perRound) {
    console.log(
      "  轮 #" +
        String(roundRecord.roundIndex) +
        " status=" +
        String(roundRecord.status) +
        " latency=" +
        formatLatency(roundRecord.roundLatencyMilliseconds) +
        " requests=" +
        String(roundRecord.modelRequestCount) +
        " input=" +
        formatTokenCount(roundRecord.inputTokenCount) +
        " output=" +
        formatTokenCount(roundRecord.outputTokenCount) +
        " cached=" +
        formatTokenCount(roundRecord.cachedTokenCount) +
        " estimated=" +
        String(roundRecord.estimatedEntryCount) +
        " missingUsage=" +
        String(roundRecord.missingUsageEntryCount) +
        " toolCalls=未测",
    );
  }

  const failedCheckNames = checks
    .filter((check) => !check.passed)
    .map((check) => check.name);
  const verdict = {
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    vendorIdentifier,
    modelIdentifier,
    protocolLabel,
    endpointLabel,
    credentialReferenceId,
    credentialFilePathRelative: path.relative(repositoryRoot, credentialsFilePath),
    stateDirectoryRelative: path.relative(repositoryRoot, stateDirectory),
    usageLedgerFilePathRelative: path.relative(repositoryRoot, ledgerFilePath),
    roundCount,
    completedRoundCount,
    perRound,
    totals,
    notMeasured,
    checks,
    failedCheckNames,
    isPassed: failedCheckNames.length === 0,
  };
  await fs.mkdir(path.dirname(verdictFilePath), { recursive: true });
  await fs.writeFile(verdictFilePath, JSON.stringify(verdict, null, 2) + "\n", "utf8");

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
  console.log("判据落盘: " + path.relative(repositoryRoot, verdictFilePath));
  if (!verdict.isPassed) {
    console.log("未通过项: " + failedCheckNames.join("、"));
  }
  return verdict.isPassed ? 0 : 1;
}

// 用 process.exitCode 收尾（不用 process.exit：在途 socket 上硬退会触发 libuv 断言）。
process.exitCode = await main();
