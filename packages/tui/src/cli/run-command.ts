/**
 * run 命令（T11 / T07D-R1-04）。
 * 通过公共应用服务（AstarrayApplicationFacade）提交与查询任务，
 * 与 SDK 消费者使用同一入口、同一状态源（不再直接调用内部控制器）。
 */
import path from "node:path";

import { AstarrayApplicationFacade } from "../../../core/src/public-sdk.js";
import type { PublicProviderConfiguration } from "../../../core/src/public-sdk.js";
import { runConfigSchema } from "../../../core/src/core/schemas.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../core/src/runtime/provider-runtime-registry.js";
import { EXIT_CODES, failWith, logToStderr, printJson } from "./json-output.js";

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

  let runtimeSelection: {
    runtime: "mock" | "provider";
    providerRuntimeRegistry?: ProviderRuntimeRegistry;
    provider?: PublicProviderConfiguration;
  } = { runtime: "mock" };
  if (runConfig.runtime === "openai-compatible") {
    const endpoint = options.providerEndpoint;
    const modelIdentifier = options.providerModelIdentifier;
    if (endpoint === undefined || endpoint === "") {
      failWith(
        new Error(
          "--runtime openai-compatible 需要 --provider-endpoint（本地协议服务器地址）",
        ),
        EXIT_CODES.USAGE_ERROR,
      );
    }
    if (modelIdentifier === undefined || modelIdentifier === "") {
      failWith(
        new Error("--runtime openai-compatible 需要 --provider-model"),
        EXIT_CODES.USAGE_ERROR,
      );
    }
    const apiKeyEnvironmentVariable =
      options.providerApiKeyEnvironmentVariable ?? "ASTARRAY_PROVIDER_API_KEY";
    const apiKey =
      process.env[apiKeyEnvironmentVariable] ?? "local-no-auth-required";
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        // 端点由本次调用的受控参数给出；API key 只从环境变量读取，不落盘、不回显。
        readCredential: async () => ({ baseUrl: endpoint, apiKey }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());
    runtimeSelection = {
      runtime: "provider",
      providerRuntimeRegistry: registry,
      provider: {
        // 仅本地/受控端点：真实服务必须由用户授权并写入受保护凭据存储。
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier,
        allowedModelIdentifiers: [modelIdentifier],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: endpoint,
        protectedCredentialReferenceId: "credential-reference:cli-provider",
      },
    };
  }

  const application = await AstarrayApplicationFacade.create({
    stateDirectory: options.stateDirectory,
    mode: runConfig.mode,
    ...runtimeSelection,
    concurrency: runConfig.concurrency,
    failureThreshold: runConfig.toolFailureThreshold,
    maximumLoopIterations: 8,
    statusPollIntervalMilliseconds: 25,
    streamOutput: (_missionIdentifier, text) => {
      logToStderr(text);
    },
  });
  try {
    application.createSession({ sessionId: "cli-run", mode: runConfig.mode });
    const accepted = await application.submitTask({
      sessionId: "cli-run",
      taskIdentifier: "cli-task",
      prompt: options.prompt,
    });
    const finalStatus = await waitForTaskTerminal(application, "cli-run", "cli-task", {
      timeoutMilliseconds:
        options.timeoutSeconds === undefined
          ? null
          : options.timeoutSeconds * 1_000,
    });
    printJson({
      missionId: accepted.missionIdentifier,
      mode: runConfig.mode,
      status: finalStatus,
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
