/**
 * anthropic-messages Provider 运行时注册（2026-10-02，多协议装配）。
 *
 * 与 `createOpenAiCompatibleProviderRegistration` 平行：不同协议各自注册，
 * 由调用方（CLI/装配层）按现行受控选择决定用哪一条；**不改变**默认协议。
 */
import {
  ANTHROPIC_MESSAGES_PROTOCOL,
  ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION,
  AnthropicMessagesRuntime,
} from "./anthropic-messages-runtime.js";
import type { ProviderRuntimeRegistration } from "./provider-runtime-registry.js";

export const ANTHROPIC_MESSAGES_PROVIDER_ID = "anthropic-messages";

export function createAnthropicMessagesProviderRegistration(): ProviderRuntimeRegistration {
  return {
    providerId: ANTHROPIC_MESSAGES_PROVIDER_ID,
    protocol: ANTHROPIC_MESSAGES_PROTOCOL,
    protocolVersion: ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION,
    supportedCapabilities: ["streaming", "tool-calling", "cancellation"],
    createRuntime: (config) =>
      new AnthropicMessagesRuntime({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelIdentifier,
        requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
        providerIdentifier: config.providerId,
        ...(config.providerRequestUsageObserver === undefined
          ? {}
          : { providerRequestUsageObserver: config.providerRequestUsageObserver }),
      }),
  };
}
