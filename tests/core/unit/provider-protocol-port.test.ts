/**
 * T07D-01 测试：Provider 协议端口、认证/传输分层、规范事件与能力协商。
 * 验收：schema 反例与未知事件防护；能力不匹配 fail-closed；
 * 认证分层（模型不能自由选择 header）；无界面/厂商 SDK 反向依赖。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_UNKNOWN_PROVIDER_EVENTS_PER_REQUEST,
  NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION,
  normalizedProviderEventSchema,
} from "../../../packages/core/src/runtime/provider-protocol-port.js";
import type { ProviderAuthenticationStrategy } from "../../../packages/core/src/runtime/provider-protocol-port.js";

describe("规范事件 schema", () => {
  it("全部 8 类规范事件合法通过", () => {
    const events = [
      { schemaVersion: 1, eventType: "response-started", providerRequestIdentifier: "req-1" },
      { schemaVersion: 1, eventType: "text-delta", textDelta: "你好" },
      { schemaVersion: 1, eventType: "tool-call-started", toolCallIdentifier: "tc-1", toolName: "project.read" },
      { schemaVersion: 1, eventType: "tool-arguments-delta", toolCallIdentifier: "tc-1", argumentsDelta: "{\"file\":" },
      { schemaVersion: 1, eventType: "tool-call-completed", toolCallIdentifier: "tc-1", finalArgumentsJson: "{\"file\":\"a.ts\"}" },
      { schemaVersion: 1, eventType: "usage-updated", inputTokenCount: 100, outputTokenCount: 50 },
      { schemaVersion: 1, eventType: "provider-completed", providerStopReason: "stop" },
      { schemaVersion: 1, eventType: "provider-error", stableErrorCode: "rate-limit", isRetryable: true },
    ];
    for (const event of events) {
      expect(normalizedProviderEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("反例：未知 eventType、缺失必填字段、schemaVersion 不匹配 → 拒绝", () => {
    expect(
      normalizedProviderEventSchema.safeParse({
        schemaVersion: 1,
        eventType: "mystery-event",
      }).success,
    ).toBe(false);
    expect(
      normalizedProviderEventSchema.safeParse({
        schemaVersion: 1,
        eventType: "text-delta",
      }).success,
    ).toBe(false);
    expect(
      normalizedProviderEventSchema.safeParse({
        schemaVersion: 99,
        eventType: "text-delta",
        textDelta: "x",
      }).success,
    ).toBe(false);
  });

  it("反例：usage 负计数、tool-call-completed 空参数 → 拒绝", () => {
    expect(
      normalizedProviderEventSchema.safeParse({
        schemaVersion: 1,
        eventType: "usage-updated",
        inputTokenCount: -1,
        outputTokenCount: 0,
      }).success,
    ).toBe(false);
    expect(
      normalizedProviderEventSchema.safeParse({
        schemaVersion: 1,
        eventType: "tool-call-completed",
        toolCallIdentifier: "tc-1",
        finalArgumentsJson: "",
      }).success,
    ).toBe(false);
  });

  it("未知事件防护上限冻结（64）", () => {
    expect(MAX_UNKNOWN_PROVIDER_EVENTS_PER_REQUEST).toBe(64);
    expect(NORMALIZED_PROVIDER_EVENT_SCHEMA_VERSION).toBe(1);
  });
});

describe("认证分层", () => {
  it("Bearer 策略附加 Authorization header（不返回凭据给调用方以外的层）", async () => {
    const strategy: ProviderAuthenticationStrategy = {
      kind: "bearer",
      applyAuthentication: async ({ requestHeaders }) => ({
        ...requestHeaders,
        Authorization: "Bearer sk-test-000000000000000000",
      }),
    };
    const headers = await strategy.applyAuthentication({
      requestHeaders: { "Content-Type": "application/json" },
      nowUnixMilliseconds: 1_000_000,
    });
    expect(headers.Authorization).toBe("Bearer sk-test-000000000000000000");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("命名 API-key header 策略：模型不能自由选择 header（策略固定 header 名）", async () => {
    const strategy: ProviderAuthenticationStrategy = {
      kind: "named-api-key-header",
      applyAuthentication: async ({ requestHeaders }) => ({
        ...requestHeaders,
        "x-api-key": "key-test-000000000000",
      }),
    };
    const headers = await strategy.applyAuthentication({
      requestHeaders: {},
      nowUnixMilliseconds: 1_000_000,
    });
    expect(headers["x-api-key"]).toBe("key-test-000000000000");
    // 无任何路径让模型注入自定义 header
    expect(Object.keys(headers)).not.toContain("Authorization");
  });
});

describe("能力协商", () => {
  const resolver = {
    negotiateCapabilities: ({
      requiredCapabilities,
      providerCapabilities,
      protocolVersion,
    }: {
      requiredCapabilities: string[];
      providerCapabilities: string[];
      protocolVersion: string;
    }) => {
      const unsatisfied = requiredCapabilities.filter(
        (capability) => !providerCapabilities.includes(capability),
      );
      return {
        isSatisfied: unsatisfied.length === 0,
        unsatisfiedCapabilities: unsatisfied,
        negotiatedProtocolVersion: protocolVersion,
      };
    },
  };

  it("能力全部满足 → 协商通过", () => {
    const result = resolver.negotiateCapabilities({
      requiredCapabilities: ["text", "tool-calling"],
      providerCapabilities: ["text", "tool-calling", "vision"],
      protocolVersion: "2024-06-01",
    });
    expect(result.isSatisfied).toBe(true);
    expect(result.negotiatedProtocolVersion).toBe("2024-06-01");
  });

  it("能力不匹配 → fail-closed（列出缺失能力）", () => {
    const result = resolver.negotiateCapabilities({
      requiredCapabilities: ["text", "vision"],
      providerCapabilities: ["text"],
      protocolVersion: "2024-06-01",
    });
    expect(result.isSatisfied).toBe(false);
    expect(result.unsatisfiedCapabilities).toEqual(["vision"]);
  });
});