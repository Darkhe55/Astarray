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
import { FileProviderCredentialStore } from "./provider-cli.js";

export interface RuntimeSelectionOptions {
  runtime: string | undefined;
  /** 状态目录（解析受保护凭据引用需要）。 */
  stateDirectory?: string;
  providerEndpoint?: string;
  providerModelIdentifier?: string;
  providerApiKeyEnvironmentVariable?: string;
  /**
   * 受保护凭据引用（`config provider` 写入）。给出时**优先**于环境变量路径，
   * 且引用不存在即 fail-closed（不回退环境变量、不回退 mock）。
   */
  providerCredentialReference?: string;
  /**
   * Provider 单次请求超时（毫秒）。缺省时由注册表默认（30_000）决定；
   * 真实长任务需要显式放宽（实测某些模型单次响应 > 30s）。
   */
  providerRequestTimeoutMilliseconds?: number;
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

export async function buildRuntimeSelection(
  options: RuntimeSelectionOptions,
): Promise<RuntimeSelection> {
  if (options.runtime === undefined || options.runtime === "mock") {
    return { runtime: "mock" };
  }
  if (options.runtime !== "openai-compatible") {
    throw new RuntimeSelectionError(
      "runtime-unsupported",
      "不支持的运行时: " + String(options.runtime),
    );
  }
  const credentialReference = options.providerCredentialReference;
  if (credentialReference !== undefined && credentialReference !== "") {
    const stateDirectory = options.stateDirectory;
    if (stateDirectory === undefined || stateDirectory === "") {
      throw new RuntimeSelectionError(
        "provider-state-directory-missing",
        "--provider-credential-reference 需要状态目录（stateDirectory）",
      );
    }
    const modelIdentifier = options.providerModelIdentifier;
    if (modelIdentifier === undefined || modelIdentifier === "") {
      throw new RuntimeSelectionError(
        "provider-model-missing",
        "--runtime openai-compatible 需要 --provider-model",
      );
    }
    const credentialStore = new FileProviderCredentialStore(stateDirectory);
    const credentialEntry = await credentialStore.readCredential(credentialReference);
    if (credentialEntry === null) {
      throw new RuntimeSelectionError(
        "provider-credential-not-found",
        "受保护凭据引用不存在: " + credentialReference,
      );
    }
    const registryFromReference = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: (referenceId) => credentialStore.doesReferenceExist(referenceId),
        readCredential: (referenceId) => credentialStore.readCredential(referenceId),
      },
    });
    registryFromReference.register(createOpenAiCompatibleProviderRegistration());
    return {
      runtime: "provider",
      providerRuntimeRegistry: registryFromReference,
      provider: {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier,
        allowedModelIdentifiers: [modelIdentifier],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: credentialEntry.baseUrl,
        protectedCredentialReferenceId: credentialReference,
        ...(options.providerRequestTimeoutMilliseconds === undefined
          ? {}
          : {
              requestTimeoutMilliseconds: options.providerRequestTimeoutMilliseconds,
            }),
      },
    };
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
      ...(options.providerRequestTimeoutMilliseconds === undefined
        ? {}
        : {
            requestTimeoutMilliseconds: options.providerRequestTimeoutMilliseconds,
          }),
    },
  };
}
