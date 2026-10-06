/**
 * 单次 Provider 请求的**真实用量**观测端口（2026-10-06）。
 *
 * 背景（已查证的既有缺陷，不是推测）：
 *  - `usage-updated` 规范事件在仓库内**只有声明**（runtime/provider-protocol-port.ts:46-51），
 *    **没有生产者、也没有消费者**；6 个协议适配器都不在产品路径上。
 *  - 两个**产品运行时**（`AnthropicMessagesRuntime` / `OpenAiCompatibleRuntime`）各自解析 SSE，
 *    把厂商返回的 usage 字段**丢弃**（Anthropic 的 `message_start.message.usage`、
 *    OpenAI 的 `usage`——后者甚至从未被请求）。
 *  - 结果：`UsageLedgerStore` 在生产路径上**从未被写入**，`usage/entries.json` 永远为空，
 *    卡内"记录 usage"只能给范围而给不出逐请求精确值。
 *
 * 本模块只定义**窄端口 + 纯函数**，不依赖编排层；写入实现放在编排层
 * （`orchestration/provider-usage-ledger-observer.ts`），保持依赖方向为
 * `orchestration → measurement`，运行时不反向依赖编排。
 */
import { createHash } from "node:crypto";

/** 一次真实 Provider 请求结束后可确证的事实。 */
export interface ProviderRequestUsageObservation {
  missionIdentifier: string | null;
  taskIdentifier: string | null;
  sourceAgentInstanceId: string;
  /**
   * Provider 运行时/协议标识（当前产品路径中由注册项给出，
   * 例如 `anthropic-messages` / `openai-compatible`）。
   */
  providerIdentifier: string;
  modelIdentifier: string;
  /** 每次**实际 HTTP 请求**唯一（重试计为不同请求，符合计费口径）。 */
  requestIdentifier: string;
  /** 未知必须为 null，**不得补 0**（与 UsageLedgerEntry 同一纪律）。 */
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  cachedInputTokenCount: number | null;
  /** 规范化请求内容的哈希：同键异参据此拒绝覆盖。 */
  requestInputHash: string;
  observedAtIso: string;
  /** 未拿到 usage 时的原因（厂商未返回 / 取消 / 超时）；拿到时缺省。 */
  missingUsageReason?: string;
}

export interface ProviderRequestUsageObserverPort {
  recordProviderRequestUsage(
    observation: ProviderRequestUsageObservation,
  ): Promise<void> | void;
}

/** 规范化请求哈希：同一请求内容必须得到同一哈希。 */
export function computeProviderRequestInputHash(requestBodyJson: string): string {
  return createHash("sha256").update(requestBodyJson).digest("hex");
}

/**
 * 缺省观测者：**显式**表示"本装配不采集用量"。
 * 用于尚未接线观测者的装配路径（例如脚本运行时），避免调用方为 null 判断分叉。
 */
export const NOOP_PROVIDER_REQUEST_USAGE_OBSERVER: ProviderRequestUsageObserverPort = {
  recordProviderRequestUsage: () => undefined,
};
