/**
 * Provider 运行时注册与配置协商（T07D-R2-01）。
 *
 * - 运行时选择显式：未注册 provider、缺配置、模型不在允许列表、能力不足一律稳定失败，
 *   绝不静默回退 mock。
 * - 只处理“受保护凭据引用”；API key/endpoint secret 不进入描述符、错误、日志或导出。
 * - 首个产品目标（2026-09-10 记录）：openai-compatible Chat Completions 流式协议。
 */
import type { AgentRuntime } from "../core/types.js";
import type { ProtectedCredentialStorePort } from "../orchestration/model-provider-catalog.js";

/** Provider 运行时公开能力（用于能力协商）。 */
export const PROVIDER_RUNTIME_CAPABILITIES = [
  "streaming",
  "tool-calling",
  "cancellation",
] as const;
export type ProviderRuntimeCapability =
  (typeof PROVIDER_RUNTIME_CAPABILITIES)[number];

export type ProviderConfigurationErrorCode =
  | "runtime-unsupported"
  | "provider-already-registered"
  | "provider-config-missing"
  | "model-not-allowed"
  | "capability-unavailable"
  | "credential-reference-missing";

/** 稳定配置错误：只含 provider/model/引用标识，不含秘密。 */
export class ProviderConfigurationError extends Error {
  constructor(
    readonly errorCode: ProviderConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export interface ProviderRuntimeConfig {
  providerId: string;
  modelIdentifier: string;
  baseUrl: string;
  /** 受保护凭据引用（不含秘密内容）。 */
  protectedCredentialReferenceId: string;
  /** 仅内存流转的凭据内容；不得进入描述符、错误、日志或导出。 */
  apiKey: string;
  requestTimeoutMilliseconds: number;
}

export interface ProviderRuntimeRegistration {
  /** 运行时实现 ID（协议族）。 */
  providerId: string;
  /** 官方协议标识（首个目标：openai-compatible）。 */
  protocol: string;
  /** 已核对官方文档的协议版本标识。 */
  protocolVersion: string;
  supportedCapabilities: readonly ProviderRuntimeCapability[];
  createRuntime(config: ProviderRuntimeConfig): AgentRuntime;
}

/** 公开描述符：不含凭据、endpoint secret 或内部字段。 */
export interface ProviderRuntimeDescriptor {
  providerId: string;
  protocol: string;
  protocolVersion: string;
  supportedCapabilities: readonly ProviderRuntimeCapability[];
}

export interface ResolveProviderRuntimeRequest {
  providerId: string;
  modelIdentifier: string;
  allowedModelIdentifiers: readonly string[];
  requiredCapabilities?: readonly ProviderRuntimeCapability[];
  baseUrl?: string | null;
  protectedCredentialReferenceId?: string | null;
  requestTimeoutMilliseconds?: number;
}

export interface ResolvedProviderRuntime {
  descriptor: ProviderRuntimeDescriptor;
  /** 每次调用创建独立运行时实例（避免跨 Agent 共享运行状态）。 */
  createRuntime: () => AgentRuntime;
}

export class ProviderRuntimeRegistry {
  private readonly registrations = new Map<string, ProviderRuntimeRegistration>();
  private readonly protectedCredentialStore: ProtectedCredentialStorePort | null;

  constructor(
    options: { protectedCredentialStore?: ProtectedCredentialStorePort | null } = {},
  ) {
    this.protectedCredentialStore = options.protectedCredentialStore ?? null;
  }

  register(registration: ProviderRuntimeRegistration): void {
    if (this.registrations.has(registration.providerId)) {
      throw new ProviderConfigurationError(
        "provider-already-registered",
        "Provider 运行时已注册: " + registration.providerId,
      );
    }
    this.registrations.set(registration.providerId, registration);
  }

  listProviderIds(): string[] {
    return [...this.registrations.keys()];
  }

  describeRegistrations(): ProviderRuntimeDescriptor[] {
    return [...this.registrations.values()].map((registration) => ({
      providerId: registration.providerId,
      protocol: registration.protocol,
      protocolVersion: registration.protocolVersion,
      supportedCapabilities: [...registration.supportedCapabilities],
    }));
  }

  async resolveRuntime(
    request: ResolveProviderRuntimeRequest,
  ): Promise<ResolvedProviderRuntime> {
    const registration = this.registrations.get(request.providerId);
    if (registration === undefined) {
      throw new ProviderConfigurationError(
        "runtime-unsupported",
        "未注册的 Provider 运行时: " + request.providerId + "（不静默回退 mock）",
      );
    }
    const modelIdentifier = request.modelIdentifier;
    const credentialReferenceId = request.protectedCredentialReferenceId ?? null;
    let apiKey = "";
    let credentialBaseUrl: string | null = null;
    if (this.protectedCredentialStore !== null && credentialReferenceId !== null) {
      const referenceExists =
        await this.protectedCredentialStore.doesReferenceExist(credentialReferenceId);
      if (!referenceExists) {
        throw new ProviderConfigurationError(
          "credential-reference-missing",
          "受保护凭据引用不存在: " + credentialReferenceId,
        );
      }
      const credential =
        await this.protectedCredentialStore.readCredential(credentialReferenceId);
      if (credential === null) {
        throw new ProviderConfigurationError(
          "credential-reference-missing",
          "受保护凭据引用不存在: " + credentialReferenceId,
        );
      }
      apiKey = credential.apiKey;
      credentialBaseUrl = credential.baseUrl;
    }
    const baseUrl = request.baseUrl ?? credentialBaseUrl ?? null;
    if (
      baseUrl === null ||
      baseUrl.trim().length === 0 ||
      modelIdentifier.trim().length === 0
    ) {
      throw new ProviderConfigurationError(
        "provider-config-missing",
        "Provider 配置缺失（baseUrl/modelIdentifier）: " + request.providerId,
      );
    }
    if (!request.allowedModelIdentifiers.includes(modelIdentifier)) {
      throw new ProviderConfigurationError(
        "model-not-allowed",
        "模型不在允许列表: " + modelIdentifier,
      );
    }
    const requiredCapabilities = request.requiredCapabilities ?? [];
    const missingCapability = requiredCapabilities.find(
      (capability) => !registration.supportedCapabilities.includes(capability),
    );
    if (missingCapability !== undefined) {
      throw new ProviderConfigurationError(
        "capability-unavailable",
        "Provider 运行时能力不足: " +
          registration.providerId +
          " 缺少 " +
          missingCapability,
      );
    }
    const runtimeConfig: ProviderRuntimeConfig = {
      providerId: registration.providerId,
      modelIdentifier,
      baseUrl,
      protectedCredentialReferenceId: credentialReferenceId ?? "",
      apiKey,
      requestTimeoutMilliseconds: request.requestTimeoutMilliseconds ?? 30_000,
    };
    return {
      descriptor: {
        providerId: registration.providerId,
        protocol: registration.protocol,
        protocolVersion: registration.protocolVersion,
        supportedCapabilities: [...registration.supportedCapabilities],
      },
      createRuntime: () => registration.createRuntime(runtimeConfig),
    };
  }
}
