/**
 * openai-compatible Provider 运行时注册（T07D-R2-02）。
 * 首个产品目标：OpenAI Chat Completions 流式协议（stream + tools + SSE）。
 * 适配器只产生协议事件；工具执行与完成判定属于本地工具循环/完成协议。
 */
import { OpenAiCompatibleRuntime } from "./openai-compatible-runtime.js";
import type { ProviderRuntimeRegistration } from "./provider-runtime-registry.js";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PROTOCOL = "openai-compatible";
export const OPENAI_COMPATIBLE_PROTOCOL_VERSION =
  "chat-completions/stream-tools-2026-09-10";

export function createOpenAiCompatibleProviderRegistration(): ProviderRuntimeRegistration {
  return {
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    protocol: OPENAI_COMPATIBLE_PROTOCOL,
    protocolVersion: OPENAI_COMPATIBLE_PROTOCOL_VERSION,
    supportedCapabilities: ["streaming", "tool-calling", "cancellation"],
    createRuntime: (config) =>
      new OpenAiCompatibleRuntime({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelIdentifier,
        requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
      }),
  };
}
