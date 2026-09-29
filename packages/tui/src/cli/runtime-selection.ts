/**
 * CLI 共用运行时选择（T07D-R2 产品接线）：
 * mock 为离线默认；openai-compatible 必须给出端点与模型，缺参数即 fail-closed，
 * 绝不静默回退 mock。API key 只从环境变量读取，不落盘、不回显。
 */
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../core/src/runtime/provider-runtime-registry.js";
import type { PublicProviderConfiguration } from "../../../core/src/public-sdk.js";

export interface RuntimeSelectionOptions {
  runtime: string | undefined;
  providerEndpoint?: string;
  providerModelIdentifier?: string;
  providerApiKeyEnvironmentVariable?: string;
}

export interface RuntimeSelection {
  runtime: "mock" | "provider";
  providerRuntimeRegistry?: ProviderRuntimeRegistry;
  provider?: PublicProviderConfiguration;
}

/** 稳定错误码：调用方据此给出退出码 2（用法错误）而不是回退 mock。 */
export class RuntimeSelectionError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSelectionError";
  }
}

export function buildRuntimeSelection(
  options: RuntimeSelectionOptions,
): RuntimeSelection {
  if (options.runtime === undefined || options.runtime === "mock") {
    return { runtime: "mock" };
  }
  if (options.runtime !== "openai-compatible") {
    throw new RuntimeSelectionError(
      "runtime-unsupported",
      "不支持的运行时: " + String(options.runtime),
    );
  }
  const endpoint = options.providerEndpoint;
  if (endpoint === undefined || endpoint === "") {
    throw new RuntimeSelectionError(
      "provider-endpoint-missing",
      "--runtime openai-compatible 需要 --provider-endpoint（本地协议服务器地址）",
    );
  }
  const modelIdentifier = options.providerModelIdentifier;
  if (modelIdentifier === undefined || modelIdentifier === "") {
    throw new RuntimeSelectionError(
      "provider-model-missing",
      "--runtime openai-compatible 需要 --provider-model",
    );
  }
  const apiKeyEnvironmentVariable =
    options.providerApiKeyEnvironmentVariable ?? "ASTARRAY_PROVIDER_API_KEY";
  const apiKey = process.env[apiKeyEnvironmentVariable] ?? "local-no-auth-required";
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      // 端点由本次调用的受控参数给出；API key 只从环境变量读取，不落盘、不回显。
      readCredential: async () => ({ baseUrl: endpoint, apiKey }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  return {
    runtime: "provider",
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier,
      allowedModelIdentifiers: [modelIdentifier],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "credential-reference:cli-provider",
    },
  };
}
