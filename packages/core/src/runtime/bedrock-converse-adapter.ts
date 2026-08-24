/**
 * Amazon Bedrock Converse 适配边界（T07D-05 / T07D 任务卡 §6.3）。
 *
 * - ConverseStream 事件解析：streamStart / contentBlockStart(toolUse) /
 *   contentBlockDelta(textDelta | toolUseDelta inputJsonDelta 累积) /
 *   contentBlockStop / messageStop(stopReason) / 错误；
 * - SigV4 使用本地签名端口（AWS 凭据不进入 Agent 上下文）；
 * - 适配器不执行工具/不自接受完成/不改权限与身份。
 */
import { createHash, createHmac } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { SseEventStreamParser } from "./sse-event-stream-parser.js";
import type {
  NormalizedProviderEvent,
  ProviderProtocolAdapter,
} from "./provider-protocol-port.js";

/** Bedrock Converse 协议标识/API 版本。 */
export const BEDROCK_CONVERSE_PROTOCOL_NAME = "bedrock-converse";
export const BEDROCK_CONVERSE_API_VERSION = "2023-07-31";

/** SigV4 本地签名端口（AWS 凭据只在此端口内流转；不进入 Agent 上下文）。 */
export interface AwsSigV4CredentialInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
}

export interface AwsSigV4SignedRequest {
  /** 完整 Authorization header（含签名；不含明文 secretKey）。 */
  authorizationHeader: string;
  /** 规范请求哈希（审计用；不含凭据）。 */
  canonicalRequestHash: string;
}

/** 本地 AWS SigV4 签名器（sha256/hmac；服务区可配置）。 */
export class AwsSigV4Signer {
  constructor(
    private readonly options: {
      regionLabel: string;
      serviceName: string;
      nowUnixMilliseconds?: () => number;
    },
  ) {}

  /**
   * 为 HTTPS 请求生成 SigV4 Authorization header。
   * 返回头不含 accessKeyId 明文之外的内容；secretKey 仅用于 hmac 计算。
   */
  signRequest(input: {
    method: string;
    requestPath: string;
    queryString: string;
    requestHeaders: Record<string, string>;
    requestBodyJson: string;
    credentials: AwsSigV4CredentialInput;
  }): AwsSigV4SignedRequest {
    const nowUnixMilliseconds = this.options.nowUnixMilliseconds ?? Date.now;
    const nowDate = new Date(nowUnixMilliseconds());
    const amzDate = nowDate.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = createHash("sha256")
      .update(input.requestBodyJson, "utf8")
      .digest("hex");

    const canonicalHeaders =
      `content-type:${input.requestHeaders["content-type"] ?? "application/json"}\n` +
      `host:${input.requestHeaders["host"] ?? "bedrock-runtime.amazonaws.com"}\n` +
      `x-amz-date:${amzDate}\n` +
      (input.credentials.sessionToken !== null
        ? `x-amz-security-token:${input.credentials.sessionToken}\n`
        : "");
    const signedHeaders = input.credentials.sessionToken !== null
      ? "content-type;host;x-amz-date;x-amz-security-token"
      : "content-type;host;x-amz-date";

    const canonicalRequest = [
      input.method,
      input.requestPath,
      input.queryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const canonicalRequestHash = createHash("sha256")
      .update(canonicalRequest, "utf8")
      .digest("hex");

    const scope = `${dateStamp}/${this.options.regionLabel}/${this.options.serviceName}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      canonicalRequestHash,
    ].join("\n");

    const kDate = createHmac("sha256", `AWS4${input.credentials.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(this.options.regionLabel).digest();
    const kService = createHmac("sha256", kRegion).update(this.options.serviceName).digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign, "utf8")
      .digest("hex");

    return {
      authorizationHeader:
        `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      canonicalRequestHash,
    };
  }
}

/**
 * Bedrock ConverseStream 适配器。
 * 事件（data JSON，eventType 字段）：streamStart / contentBlockStart /
 * contentBlockDelta（textDelta | toolUseDelta inputJsonDelta 累积）/
 * contentBlockStop / messageStop / 错误。
 */
export class BedrockConverseAdapter implements ProviderProtocolAdapter {
  readonly protocolName = BEDROCK_CONVERSE_PROTOCOL_NAME;
  readonly supportedApiVersion = BEDROCK_CONVERSE_API_VERSION;

  /** contentBlockIndex → 累积的工具参数 JSON。 */
  private accumulatedToolArgumentsByBlock = new Map<number, string>();

  async *parseEventStream(
    transportChunks: AsyncIterable<string>,
  ): AsyncIterable<NormalizedProviderEvent> {
    const sseParser = new SseEventStreamParser({
      cancellationSignal: new AbortController().signal,
    });
    for await (const sseEvent of sseParser.parseEventStream(transportChunks)) {
      const events = this.parseSseEvent(sseEvent);
      for (const event of events) {
        yield event;
      }
    }
  }

  private parseSseEvent(sseEvent: { eventName: string; data: string }): NormalizedProviderEvent[] {
    let payload: unknown;
    try {
      payload = JSON.parse(sseEvent.data) as unknown;
    } catch {
      throw new DomainError(
        "provider-protocol-error",
        `Bedrock SSE 数据不是合法 JSON: ${sseEvent.data.slice(0, 80)}`,
      );
    }
    const data = payload as {
      eventType?: string;
      contentBlockIndex?: number;
      start?: { type?: string; toolUseId?: string; name?: string };
      delta?: { type?: string; text?: string; inputJsonDelta?: string };
      stopReason?: string;
    };
    switch (data.eventType) {
      case "streamStart":
        return [
          {
            schemaVersion: 1,
            eventType: "response-started",
            providerRequestIdentifier: "bedrock-converse-stream",
          },
        ];
      case "contentBlockStart": {
        const blockIndex = data.contentBlockIndex ?? 0;
        if (data.start?.type === "toolUse" && data.start.name !== undefined) {
          this.accumulatedToolArgumentsByBlock.set(blockIndex, "");
          return [
            {
              schemaVersion: 1,
              eventType: "tool-call-started",
              toolCallIdentifier: String(data.start.toolUseId ?? `bedrock-block-${blockIndex}`),
              toolName: data.start.name,
            },
          ];
        }
        return [];
      }
      case "contentBlockDelta": {
        const blockIndex = data.contentBlockIndex ?? 0;
        if (data.delta?.type === "textDelta" && data.delta.text !== undefined) {
          return [
            {
              schemaVersion: 1,
              eventType: "text-delta",
              textDelta: data.delta.text,
            },
          ];
        }
        if (data.delta?.type === "toolUseDelta" && data.delta.inputJsonDelta !== undefined) {
          const accumulated =
            this.accumulatedToolArgumentsByBlock.get(blockIndex) ?? "";
          this.accumulatedToolArgumentsByBlock.set(
            blockIndex,
            accumulated + data.delta.inputJsonDelta,
          );
          return [
            {
              schemaVersion: 1,
              eventType: "tool-arguments-delta",
              toolCallIdentifier: `bedrock-block-${blockIndex}`,
              argumentsDelta: data.delta.inputJsonDelta,
            },
          ];
        }
        return [];
      }
      case "contentBlockStop": {
        const blockIndex = data.contentBlockIndex ?? 0;
        const accumulated =
          this.accumulatedToolArgumentsByBlock.get(blockIndex);
        if (accumulated !== undefined) {
          this.accumulatedToolArgumentsByBlock.delete(blockIndex);
          return [
            {
              schemaVersion: 1,
              eventType: "tool-call-completed",
              toolCallIdentifier: `bedrock-block-${blockIndex}`,
              finalArgumentsJson: accumulated || "{}",
            },
          ];
        }
        return [];
      }
      case "messageStop":
        return [
          {
            schemaVersion: 1,
            eventType: "provider-completed",
            providerStopReason: data.stopReason ?? "end_turn",
          },
        ];
      default:
        return []; // 未知事件：跳过
    }
  }
}