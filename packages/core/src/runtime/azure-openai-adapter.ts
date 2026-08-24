/**
 * Azure OpenAI 适配边界（T07D-05 / T07D 任务卡 §6.3）。
 *
 * - Endpoint、deployment/model、API 版本、API key 与异步 Entra token
 *   provider 不得硬编码为普通 Bearer 单一路径：认证策略二选一
 *   （named-api-key-header | async-token-provider），API 版本显式记录；
 * - 协议解析复用 Chat Completions 解析（Azure 协议对齐 Chat Completions）；
 * - 适配器不执行工具/不自接受完成；凭据不进入 Agent 上下文。
 */
import { OpenAiChatCompletionsAdapter } from "./openai-adapters.js";

/** Azure OpenAI 协议标识/默认 API 版本。 */
export const AZURE_OPENAI_PROTOCOL_NAME = "azure-openai";
export const AZURE_OPENAI_DEFAULT_API_VERSION = "2024-06-01";

/** Azure OpenAI 认证策略（API key 或异步 Entra token provider）。 */
export type AzureAuthMode =
  | { kind: "api-key"; apiKeyReference: string }
  | { kind: "entra-token-provider"; tokenProviderReference: string };

export interface AzureOpenAiEndpointConfig {
  /** 形如 https://<resource>.openai.azure.com/。 */
  endpointBaseUrl: string;
  /** 部署名（模型经 deployment 映射）。 */
  deploymentName: string;
  apiVersion: string;
  authMode: AzureAuthMode;
}

/**
 * Azure OpenAI 适配器：构造 deployment + api-version 路径，认证策略
 * 独立选择；事件解析委托 Chat Completions（协议对齐，非冒充 Responses）。
 */
export class AzureOpenAiAdapter extends OpenAiChatCompletionsAdapter {
  override readonly protocolName = AZURE_OPENAI_PROTOCOL_NAME;
  override readonly supportedApiVersion: string;

  private readonly endpointBaseUrl: string;
  private readonly deploymentName: string;
  private readonly authMode: AzureAuthMode;

  constructor(private readonly endpointConfig: AzureOpenAiEndpointConfig) {
    super();
    this.supportedApiVersion = endpointConfig.apiVersion;
    this.endpointBaseUrl = endpointConfig.endpointBaseUrl;
    this.deploymentName = endpointConfig.deploymentName;
    this.authMode = endpointConfig.authMode;
  }

  /** 构造请求路径（deployment + api-version；不携带凭据）。 */
  buildRequestPath(): string {
    return (
      this.endpointBaseUrl.replace(/\/$/, "") +
      `/openai/deployments/${encodeURIComponent(this.deploymentName)}/chat/completions` +
      `?api-version=${encodeURIComponent(this.supportedApiVersion)}`
    );
  }

  /** 认证策略：API key 或 Entra token 二选一（不硬编码 Bearer 单一路径）。 */
  getAuthMode(): AzureAuthMode {
    return this.authMode;
  }
}