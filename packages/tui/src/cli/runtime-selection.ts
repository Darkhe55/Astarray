/**
 * CLI 共用运行时选择（T07D-R2 产品接线）：
 * mock 为离线默认；openai-compatible 必须给出端点与模型，缺参数即 fail-closed，
 * 绝不静默回退 mock。API key 只从环境变量读取，不落盘、不回显。
 */
import {
  ANTHROPIC_MESSAGES_PROVIDER_ID,
  createAnthropicMessagesProviderRegistration,
} from "../../../core/src/runtime/anthropic-messages-provider-registration.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../core/src/runtime/provider-runtime-registry.js";
import type { PublicProviderConfiguration } from "../../../core/src/public-sdk.js";
import { FileProviderCredentialStore } from "./provider-cli.js";

/**
 * 受控协议选择（2026-10-02 多协议装配）。
 *
 * **默认保持 `openai-compatible`**（不改变现有行为）；显式给出未支持的协议时 fail-closed，
 * 不静默回退——回退会让调用方以为在用 Anthropic 协议，实际发出的是 OpenAI 形态请求。
 */
export type SelectedProviderProtocol = "openai-compatible" | "anthropic-messages";

export function resolveProviderProtocol(
  requestedProtocol: string | undefined,
): SelectedProviderProtocol {
  if (requestedProtocol === undefined || requestedProtocol === "" || requestedProtocol === "openai-compatible") {
    return "openai-compatible";
  }
  if (requestedProtocol === "anthropic-messages") {
    return "anthropic-messages";
  }
  throw new RuntimeSelectionError(
    "provider-protocol-unsupported",
    `不支持的协议: ${requestedProtocol}（可用: openai-compatible | anthropic-messages）`,
  );
}

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
   * 协议选择（2026-10-02 多协议装配）：缺省 `openai-compatible`（**不改变现有行为**）；
   * `anthropic-messages` 使用 Anthropic Messages runtime（x-api-key + 顶层 system + tool_result）。
   */
  providerProtocol?: string;
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
    const selectedProtocolFromReference = resolveProviderProtocol(options.providerProtocol);
    if (selectedProtocolFromReference === "anthropic-messages") {
      registryFromReference.register(createAnthropicMessagesProviderRegistration());
    } else {
      registryFromReference.register(createOpenAiCompatibleProviderRegistration());
    }
    /**
     * **2026-10-10 修复（真实 Provider 实测发现）：显式端点不得被静默忽略。**
     *
     * 此前该分支**一律**取 `credentialEntry.baseUrl`，把调用方显式给出的
     * `--provider-endpoint` **直接丢弃**。后果不是报错而是**毫无线索的 404**：
     * 用户会去怀疑端点、协议、模型或凭据，而真正原因是**参数根本没被读**。
     *
     * 具体触发（本仓真实数据）：凭据 `prov-unisound-1` 的 `baseUrl` 是
     * `https://maas-api.unisound.com/v1`（**OpenAI 形态、不含路径**），
     * 而两个 runtime 都把 `baseUrl` 当**完整端点**逐字 POST
     * （`openai-compatible-runtime.ts:149` / `anthropic-messages-runtime.ts:166`）
     * ⇒ `--provider-protocol anthropic-messages` 必然 404。
     *
     * 语义：**显式给出的端点优先**（显式输入胜过存储默认值）；
     * 未给出（或为空串）时才回退凭据里的 `baseUrl` —— 这保住了
     * "引用存在 ⇒ 无需 --provider-endpoint" 的原有契约
     * （见 `tests/tui/unit/runtime-credential-selection.test.ts` 第一条）。
     * 同时用 `isEndpointFromCredential` 标明来源，使诊断可回答
     * "我用的到底是谁的端点"。
     */
    const explicitEndpoint = options.providerEndpoint;
    const isExplicitEndpointGiven =
      explicitEndpoint !== undefined && explicitEndpoint !== "";
    return {
      runtime: "provider",
      providerRuntimeRegistry: registryFromReference,
      provider: {
        providerId:
          selectedProtocolFromReference === "anthropic-messages"
            ? ANTHROPIC_MESSAGES_PROVIDER_ID
            : OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier,
        allowedModelIdentifiers: [modelIdentifier],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: isExplicitEndpointGiven ? explicitEndpoint : credentialEntry.baseUrl,
        isEndpointFromCredential: !isExplicitEndpointGiven,
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
  const selectedProtocol = resolveProviderProtocol(options.providerProtocol);
  if (selectedProtocol === "anthropic-messages") {
    registry.register(createAnthropicMessagesProviderRegistration());
  } else {
    registry.register(createOpenAiCompatibleProviderRegistration());
  }
  return {
    runtime: "provider",
    providerRuntimeRegistry: registry,
    provider: {
      providerId:
        selectedProtocol === "anthropic-messages"
          ? ANTHROPIC_MESSAGES_PROVIDER_ID
          : OPENAI_COMPATIBLE_PROVIDER_ID,
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
