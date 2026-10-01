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
} from "./permission-ask-adjudication.js";
import {
  RuntimeSelectionError,
  buildRuntimeSelection,
  type RuntimeSelection,
} from "./runtime-selection.js";

/** 单次 run 内允许的裁决轮数上限（防止无限权限循环；达到即收敛为 blocked）。 */
const MAXIMUM_ADJUDICATION_ROUNDS = 3;

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
    let finalStatus = await waitForTaskTerminal(application, "cli-run", "cli-task", {
      timeoutMilliseconds,
    });
    let permissionAskOutcome: string | null = null;
    // ADR-0011：permission-ask → 认证用户 allow-once → 授权 + unblock → 任务继续。
    // 非交互环境 fail-closed（不授权），由用户显式重提；轮数有界，绝不自动放行。
    for (
      let adjudicationRound = 0;
      finalStatus === "blocked" && adjudicationRound < MAXIMUM_ADJUDICATION_ROUNDS;
      adjudicationRound += 1
    ) {
      const permissionAsk = escalationMessages
        .map((escalationText) => buildPermissionAskFromEscalation(escalationText))
        .find((ask) => ask !== null) ?? null;
      const decision = await runPermissionAskAdjudication({
        ask: permissionAsk,
        missionIdentifier: accepted.missionIdentifier,
        isInteractive: decisionPort.isInteractive(),
        readDecision: (ask) => decisionPort.readDecision(ask),
        application,
      });
      permissionAskOutcome = decision;
      if (decision !== "allowed-once") {
        break;
      }
      escalationMessages.length = 0;
      finalStatus = await waitForTaskTerminal(application, "cli-run", "cli-task", {
        timeoutMilliseconds,
      });
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
    await application.shutdown();
  }
}

export interface WaitForTaskTerminalOptions {
  /** 总体等待上限（毫秒）；null/undefined = 不设固定上限，直到任务终态。 */
  timeoutMilliseconds?: number | null;
  pollIntervalMilliseconds?: number;
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
  while (deadlineMilliseconds === null || Date.now() < deadlineMilliseconds) {
    const result = await application.queryTask({ sessionId, taskIdentifier });
    if (result.status === "done" || result.status === "cancelled") {
      return result.status;
    }
    if (result.status === "blocked" || result.status === "failed") {
      return "blocked";
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
  }
  return "running";
}

export function defaultStateDirectory(): string {
  return path.join(process.cwd(), ".astarray");
}
