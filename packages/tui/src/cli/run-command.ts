/**
 * run 命令（T11 / T07D-R1-04）。
 * 通过公共应用服务（AstarrayApplicationFacade）提交与查询任务，
 * 与 SDK 消费者使用同一入口、同一状态源（不再直接调用内部控制器）。
 */
import path from "node:path";

import { AstarrayApplicationFacade } from "../../../core/src/public-sdk.js";
import { runConfigSchema } from "../../../core/src/core/schemas.js";
import { EXIT_CODES, failWith, logToStderr, printJson } from "./json-output.js";
import {
  InteractivePermissionAskDecisionPort,
  buildPermissionAskFromEscalation,
  runPermissionAskAdjudication,
  type PermissionAskDecisionPort,
  type PreviousApprovalRecord,
} from "./permission-ask-adjudication.js";
import {
  RuntimeSelectionError,
  buildRuntimeSelection,
  type RuntimeSelection,
} from "./runtime-selection.js";

/** 单次 run 内允许的裁决轮数上限（防止无限权限循环；达到即收敛为 blocked）。 */
const MAXIMUM_ADJUDICATION_ROUNDS = 3;

/**
 * 等待本轮的 permission-ask 升级文本到达（unblock 后重新执行的询问是**新的**一条，
 * 不能拿上一轮的旧文本重复裁决）。
 */
const PERMISSION_ASK_WAIT_MILLISECONDS = 30_000;
/**
 * `allow-once` 之后等待"重跑是否产生新询问/终态"的窗口（毫秒，2026-10-02 修复）：
 * 授权后 worker 会重新执行，期间任务短暂处于 running；必须给它这个窗口，
 * 否则 CLI 会在工具真正执行之前收口（正向闭环失败）。
 */
const AUTHORIZATION_RETRY_WINDOW_MILLISECONDS = 15_000;
async function waitForPermissionAsk(
  escalationMessages: string[],
  timeoutMilliseconds: number,
  queryTask: () => Promise<{ status: string }>,
  startIndex = 0,
  isTerminalFailure: () => boolean = () => false,
  /**
   * 任务已重新推进（running）时的等待窗口（毫秒，2026-10-02 修复）：
   * `allow-once` 后的重跑会先进入 running；此期间**不得**立即收口，
   * 否则授权后的重跑从未被等待（正向闭环失败）。窗口内出现新询问或终态即返回；
   * 窗口耗尽仍未出现则如实返回 null（由调用方按 blocked 收口）。
   */
  advancementWindowMilliseconds = 0,
): Promise<ReturnType<typeof buildPermissionAskFromEscalation>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let advancementWindowDeadline: number | null =
    advancementWindowMilliseconds > 0 ? Date.now() + advancementWindowMilliseconds : null;
  while (Date.now() < deadline) {
    // 任务已**终态失败**（例如门禁判失败）：不会再有裁决需求，立即返回。
    if (isTerminalFailure()) {
      return null;
    }
    // 只看**尚未裁决**的升级文本（已消费的不得重复触发询问）。
    const pendingEscalations = escalationMessages.slice(startIndex);
    const permissionAsk = pendingEscalations
      .map((escalationText) => buildPermissionAskFromEscalation(escalationText))
      .find((ask) => ask !== null);
    if (permissionAsk !== undefined) {
      return permissionAsk;
    }
    // 任务已不是 blocked（完成/失败/取消）时无需再等待裁决。
    const currentStatus = (await queryTask()).status;
    if (currentStatus !== "blocked") {
      // 处于推进窗口内：继续等新询问（不立即收口）。
      if (
        advancementWindowDeadline !== null &&
        Date.now() < advancementWindowDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      return null;
    }
    // 一旦回到 blocked，推进窗口结束。
    advancementWindowDeadline = null;
    // blocked 且**已收到非询问类升级**（例如门禁判失败）→ 不会再有裁决需求，立即返回。
    if (
      pendingEscalations.length > 0 &&
      pendingEscalations.every(
        (escalationText) => buildPermissionAskFromEscalation(escalationText) === null,
      )
    ) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

export interface RunCommandOptions {
  prompt: string;
  mode: string | undefined;
  runtime: string | undefined;
  isJsonOutput: boolean;
  stateDirectory: string;
  /** T07D-R2-03：等待上限秒数；缺省不设固定上限（等待任务终态）。 */
  timeoutSeconds?: number;
  /** openai-compatible 运行时的本地/远端协议端点（必填；不静默回退 mock）。 */
  providerEndpoint?: string;
  /** Provider 模型标识（必填）。 */
  providerModelIdentifier?: string;
  /** 存放 API key 的环境变量名；缺省读取 ASTARRAY_PROVIDER_API_KEY（不落盘/不回显）。 */
  providerApiKeyEnvironmentVariable?: string;
  /** 受保护凭据引用（优先于环境变量；不存在即 fail-closed）。 */
  providerCredentialReference?: string;
  /** Provider 单次请求超时（毫秒）；缺省由注册表默认（30_000）决定。 */
  providerRequestTimeoutMilliseconds?: number;
  /** permission-ask 交互裁决端口（默认：TTY 逐次询问；非 TTY fail-closed）。 */
  permissionDecisionPort?: PermissionAskDecisionPort;
}

export async function executeRunCommand(options: RunCommandOptions): Promise<number> {
  const parsedConfig = runConfigSchema.safeParse({
    mode: options.mode,
    runtime: options.runtime,
  });
  if (!parsedConfig.success) {
    failWith(
      new Error("配置非法: " + parsedConfig.error.message),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const runConfig = parsedConfig.data;
  if (!options.isJsonOutput) {
    failWith(
      new Error("headless run 必须使用 --json（或 TTY 下使用 TUI）"),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  let runtimeSelection: RuntimeSelection;
  try {
    runtimeSelection = await buildRuntimeSelection({
      runtime: runConfig.runtime,
      providerEndpoint: options.providerEndpoint,
      providerModelIdentifier: options.providerModelIdentifier,
      providerApiKeyEnvironmentVariable: options.providerApiKeyEnvironmentVariable,
      providerCredentialReference: options.providerCredentialReference,
      providerRequestTimeoutMilliseconds: options.providerRequestTimeoutMilliseconds,
      stateDirectory: options.stateDirectory,
    });
  } catch (error) {
    if (error instanceof RuntimeSelectionError) {
      failWith(new Error(error.message), EXIT_CODES.USAGE_ERROR);
    }
    throw error;
  }
  // Ponder 模式下 handleUserMessage 返回的是内部哨兵值（不含正文），正文经 streamOutput 送达；
  // 这里同时留档，供 JSON 输出返回真实回答。
  const streamedAnswerChunks: string[] = [];
  // permission-ask 的结构化询问随升级文本到达（ADR-0011），单独留档供裁决解析。
  const escalationMessages: string[] = [];
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: options.stateDirectory,
    mode: runConfig.mode,
    ...runtimeSelection,
    concurrency: runConfig.concurrency,
    failureThreshold: runConfig.toolFailureThreshold,
    maximumLoopIterations: 8,
    statusPollIntervalMilliseconds: 25,
    // T04：产品入口使用独立反馈进程（AGENTS.md：反馈工具不得退化为进程内定时器/协程）。
    // mock 离线路径保持进程内，避免测试期无谓 fork 抖动。
    useFeedbackProcess: runConfig.runtime !== "mock",
    streamOutput: (_missionIdentifier, text) => {
      streamedAnswerChunks.push(text);
      // ADR-0011：权限询问随升级文本到达，需结构化留档供用户裁决。
      if (buildPermissionAskFromEscalation(text) !== null) {
        escalationMessages.push(text);
      }
      logToStderr(text);
    },
  });
  try {
    application.createSession({ sessionId: "cli-run", mode: runConfig.mode });
    if (runConfig.mode === "ponder") {
      // Ponder 为本地只读问答（ADR-0014）：不产生 mission，直接返回回答；
      // 不虚报"已受理"，也不再进入任务轮询（此前会抛未处理的 mission-not-found）。
      await application.handleUserMessage(options.prompt);
      printJson({
        mode: "ponder",
        status: "done",
        answer: streamedAnswerChunks.join(""),
        prompt: options.prompt,
      });
      return EXIT_CODES.SUCCESS;
    }
    const accepted = await application.submitTask({
      sessionId: "cli-run",
      taskIdentifier: "cli-task",
      prompt: options.prompt,
    });
    const timeoutMilliseconds =
      options.timeoutSeconds === undefined ? null : options.timeoutSeconds * 1_000;
    const decisionPort =
      options.permissionDecisionPort ?? new InteractivePermissionAskDecisionPort();
    let hasObservedTerminalTaskFailure = false;
    const refreshTerminalTaskFailure = async (): Promise<void> => {
      const currentTask = await application.queryTask({
        sessionId: "cli-run",
        taskIdentifier: "cli-task",
      });
      if (currentTask.status === "failed") {
        hasObservedTerminalTaskFailure = true;
      }
    };
    let finalStatus = await waitForTaskTerminal(application, "cli-run", "cli-task", {
      timeoutMilliseconds,
      hasPendingPermissionAsk: () =>
        escalationMessages.some(
          (message) => buildPermissionAskFromEscalation(message) !== null,
        ),
    });
    await refreshTerminalTaskFailure();
    let permissionAskOutcome: string | null = null;
    /**
     * 方案 B（2026-10-02）：记录本授权周期内上一次已批准的操作，
     * 使模型重发时只发生格式抖动（结尾换行/键序）的情形**不再重复询问用户**。
     * `hasSucceededWithSameTarget` 目前保守取 false：成功后任务通常已终态、不会再产生询问；
     * 若成功后仍被问，门禁的跨周期重放保护仍会拒绝（fail-closed）。
     */
    let previousApproval: PreviousApprovalRecord | null = null;
    // ADR-0011：permission-ask → 认证用户 allow-once → 授权 + unblock → 任务继续。
    // 非交互环境 fail-closed（不授权），由用户显式重提；轮数有界，绝不自动放行。
    for (
      let adjudicationRound = 0;
      finalStatus === "blocked" && adjudicationRound < MAXIMUM_ADJUDICATION_ROUNDS;
      adjudicationRound += 1
    ) {
      const permissionAsk = await waitForPermissionAsk(
        escalationMessages,
        PERMISSION_ASK_WAIT_MILLISECONDS,
        () => application.queryTask({ sessionId: "cli-run", taskIdentifier: "cli-task" }),
        0,
        () => hasObservedTerminalTaskFailure,
        // 第 2 轮起（已授权、任务正在重跑）：给推进窗口，等新询问或终态，
        // 不得一见 running 就收口（否则授权后的重跑从未被等待）。
        adjudicationRound === 0 ? 0 : AUTHORIZATION_RETRY_WINDOW_MILLISECONDS,
      );
      // 任务已明确失败且没有待裁决询问：不得再等待（否则会无谓挂起直到超时）。
      if (permissionAsk === null) {
        const currentTask = await application.queryTask({
          sessionId: "cli-run",
          taskIdentifier: "cli-task",
        });
        if (currentTask.status === "failed") {
          finalStatus = "blocked";
          break;
        }
      }
      const decision = await runPermissionAskAdjudication({
        ask: permissionAsk,
        missionIdentifier: accepted.missionIdentifier,
        isInteractive: decisionPort.isInteractive(),
        readDecision: (ask) => decisionPort.readDecision(ask),
        application,
        previousApproval,
      });
      permissionAskOutcome = decision;
      if (decision !== "allowed-once") {
        break;
      }
      if (permissionAsk !== null) {
        previousApproval = {
          toolName: permissionAsk.toolName,
          argumentsJson: permissionAsk.argumentsJson,
          hasSucceededWithSameTarget: false,
        };
      }
      escalationMessages.length = 0;
      finalStatus = await waitForTaskTerminal(application, "cli-run", "cli-task", {
        timeoutMilliseconds,
        hasPendingPermissionAsk: () =>
          escalationMessages.some(
            (message) => buildPermissionAskFromEscalation(message) !== null,
          ),
      });
      await refreshTerminalTaskFailure();
    }
    printJson({
      missionId: accepted.missionIdentifier,
      mode: runConfig.mode,
      status: finalStatus,
      ...(permissionAskOutcome === null ? {} : { permissionAsk: permissionAskOutcome }),
      prompt: options.prompt,
    });
    return finalStatus === "done" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  } finally {
    // 收口必须有界（2026-10-02）：结果已打印，不能让残留句柄（如反馈子进程）
    // 把进程无限期拖住。超时即放弃等待，调用方随后显式退出。
    await Promise.race([
      application.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

export interface WaitForTaskTerminalOptions {
  /** 总体等待上限（毫秒）；null/undefined = 不设固定上限，直到任务终态。 */
  timeoutMilliseconds?: number | null;
  pollIntervalMilliseconds?: number;
  /**
   * 是否存在**待裁决的权限询问**（2026-10-02）：
   * 任务被判 failed 时 `queryTask` 也返回 blocked，若此时并无待裁决询问，
   * 则不得继续等待（此前会导致 CLI 无谓挂起直到整体超时）。
   */
  hasPendingPermissionAsk?: () => boolean;
}

/**
 * 等待任务终态（T07D-R2-03）：不再使用固定一分钟上限误收口长任务；
 * 仅在调用方显式给出 timeoutMilliseconds 时才提前返回 running。
 */
export async function waitForTaskTerminal(
  application: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
  options: WaitForTaskTerminalOptions = {},
): Promise<string> {
  const deadlineMilliseconds =
    options.timeoutMilliseconds === undefined || options.timeoutMilliseconds === null
      ? null
      : Date.now() + options.timeoutMilliseconds;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 50;
  // 进入等待前先看一次：任务可能已 blocked（例如已因门禁判失败）或已有待裁决询问。
  if (options.hasPendingPermissionAsk?.() === true) {
    return "blocked";
  }
  while (deadlineMilliseconds === null || Date.now() < deadlineMilliseconds) {
    // 任务状态优先：一旦进入终态或 blocked，立即返回，不再空等整体上限。
    const result = await application.queryTask({ sessionId, taskIdentifier });
    if (result.status === "done" || result.status === "cancelled") {
      return result.status;
    }
    if (result.status === "blocked" || result.status === "failed") {
      return "blocked";
    }
    // 出现**待裁决询问**时立即返回，让调用方进入裁决（不必等任务变 blocked）。
    if (options.hasPendingPermissionAsk?.() === true) {
      return "blocked";
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
  }
  return "running";
}

export function defaultStateDirectory(): string {
  return path.join(process.cwd(), ".astarray");
}
