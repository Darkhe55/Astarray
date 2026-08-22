/**
 * Provider 协议端口与规范事件流（T07D-01 / T07D 任务卡 §3/§6.2）。
 *
 * 分层边界（Astarray 本地领域不反向依赖界面或厂商 SDK）：
 * - ProviderAuthenticationStrategy：认证策略（Bearer / 命名 API-key header /
 *   异步 token provider / 请求签名）；模型不能自由选择认证策略或 header；
 * - ProviderTransport：网络传输（增量读取、取消、超时、背压）；
 * - ProviderCapabilityResolver：能力协商（能力不匹配 fail-closed）；
 * - ProviderProtocolAdapter：厂商协议 → 规范事件流。
 */
import { z } from "zod";

/** 规范事件 schema 版本（T07D-01 冻结）。 */
export const NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION = 1;

/** 规范 Provider 事件（厂商原名字段可保留，事件名规范化）。 */
export const normalizedProviderEventSchema = z.discriminatedUnion("eventType", [
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("response-started"),
    providerRequestIdentifier: z.string().min(1),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("text-delta"),
    textDelta: z.string(),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("tool-call-started"),
    toolCallIdentifier: z.string().min(1),
    toolName: z.string().min(1),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("tool-arguments-delta"),
    toolCallIdentifier: z.string().min(1),
    argumentsDelta: z.string(),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("tool-call-completed"),
    toolCallIdentifier: z.string().min(1),
    finalArgumentsJson: z.string().min(1),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("usage-updated"),
    inputTokenCount: z.number().int().min(0).nullable(),
    outputTokenCount: z.number().int().min(0).nullable(),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("provider-completed"),
    providerStopReason: z.string().min(1),
  }),
  z.object({
    schemaVersion: z.literal(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION),
    eventType: z.literal("provider-error"),
    stableErrorCode: z.string().min(1),
    isRetryable: z.boolean(),
  }),
]);
export type NormalizedProviderEvent = z.infer<
  typeof normalizedProviderEventSchema
>;

/** 认证方式（与 T07D-00 的 ProviderAuthMethod 一致；T07D-01 落地为策略）。 */
export const PROVIDER_AUTH_STRATEGY_KINDS = [
  "bearer",
  "named-api-key-header",
  "async-token-provider",
  "request-signing",
] as const;
export type ProviderAuthStrategyKind =
  (typeof PROVIDER_AUTH_STRATEGY_KINDS)[number];

/** 认证策略（本地选择；模型不能自由选择 header/策略）。 */
export interface ProviderAuthenticationStrategy {
  readonly kind: ProviderAuthStrategyKind;
  /** 为请求附加认证（不读取/记录凭据原值到日志）。 */
  applyAuthentication(input: {
    requestHeaders: Record<string, string>;
    nowUnixMilliseconds: number;
  }): Promise<Record<string, string>>;
}

/** 网络传输（增量读取；取消经 AbortSignal；超时与背压由装配方约束）。 */
export interface ProviderTransport {
  /** 发送请求并异步迭代增量文本块（不做整流缓冲）。 */
  sendRequest(input: {
    requestHeaders: Record<string, string>;
    requestBodyJson: string;
    cancellationSignal: AbortSignal;
  }): AsyncIterable<string>;
}

/** 能力协商结果。 */
export interface ProviderCapabilityNegotiation {
  isSatisfied: boolean;
  /** 不满足原因（能力不匹配 fail-closed）。 */
  unsatisfiedCapabilities: string[];
  /** 协商用的协议/API 版本。 */
  negotiatedProtocolVersion: string;
}

/** 能力协商端口（按请求所需能力过滤 Provider）。 */
export interface ProviderCapabilityResolver {
  negotiateCapabilities(input: {
    requiredCapabilities: string[];
    providerCapabilities: string[];
    protocolVersion: string;
  }): ProviderCapabilityNegotiation;
}

/** 协议适配器：把传输增量转换为规范事件流。 */
export interface ProviderProtocolAdapter {
  readonly protocolName: string;
  readonly supportedApiVersion: string;
  /** 从传输增量流解析并产出规范事件（含 tool-call 参数增量）。 */
  parseEventStream(
    transportChunks: AsyncIterable<string>,
  ): AsyncIterable<NormalizedProviderEvent>;
}

/** 未知事件防护：解析器遇到未知事件必须跳过且可继续（有界）。 */
export const MAX_UNKNOWN_PROVIDER_EVENTS_PER_REQUEST = 64;