/**
 * T07D-00 测试：Provider 支持记录 schema 与宣称规则。
 * 验收：adapter-only 不可宣称支持；无动态证据必须"未验证"；
 * 支持等级/认证方式冻结。
 */
import { describe, expect, it } from "vitest";

import {
  PROVIDER_AUTH_METHODS,
  PROVIDER_SUPPORT_LEVELS,
  PROVIDER_SUPPORT_RECORD_SCHEMA_VERSION,
  canClaimProviderSupport,
  providerSupportRecordSchema,
} from "../../../packages/core/src/orchestration/provider-support-record.js";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PROVIDER_SUPPORT_RECORD_SCHEMA_VERSION,
    providerProfileId: "openai",
    protocolName: "openai-chat-completions",
    apiVersion: "2024-06-01",
    authMethods: ["bearer"],
    capabilities: ["text", "tool-calling"],
    supportLevel: "adapter-only",
    verifiedAtIso: null,
    testEvidenceReferences: [],
    knownLimitations: ["无 fake-server 契约测试；无增量流；无产品路径"],
    isClaimableAsSupported: false,
    ...overrides,
  };
}

describe("Provider 支持等级冻结", () => {
  it("四级支持等级冻结", () => {
    expect(PROVIDER_SUPPORT_LEVELS).toEqual([
      "adapter-only",
      "fake-server-conformant",
      "live-smoke-verified",
      "product-path-verified",
    ]);
  });

  it("认证方式冻结", () => {
    expect(PROVIDER_AUTH_METHODS).toEqual([
      "bearer",
      "named-api-key-header",
      "async-token-provider",
      "request-signing",
    ]);
  });

  it("adapter-only 不可宣称支持；其余等级可宣称", () => {
    expect(canClaimProviderSupport("adapter-only")).toBe(false);
    expect(canClaimProviderSupport("fake-server-conformant")).toBe(true);
    expect(canClaimProviderSupport("live-smoke-verified")).toBe(true);
    expect(canClaimProviderSupport("product-path-verified")).toBe(true);
  });
});

describe("ProviderSupportRecord schema", () => {
  it("合法记录通过（adapter-only 未验证）", () => {
    expect(providerSupportRecordSchema.safeParse(makeRecord()).success).toBe(true);
  });

  it("反例：支持等级非法、API 版本为空 → 拒绝", () => {
    expect(
      providerSupportRecordSchema.safeParse(
        makeRecord({ supportLevel: "fully-working" }),
      ).success,
    ).toBe(false);
    expect(
      providerSupportRecordSchema.safeParse(makeRecord({ apiVersion: "" })).success,
    ).toBe(false);
  });

  it("反例：schemaVersion 不匹配（迁移拒绝）", () => {
    expect(
      providerSupportRecordSchema.safeParse(makeRecord({ schemaVersion: 99 }))
        .success,
    ).toBe(false);
  });

  it("反例：宣称支持但等级为 adapter-only（isClaimableAsSupported 与等级矛盾由调用方断言）", () => {
    // schema 允许记录矛盾字段（记录是事实）；宣称规则由 canClaimProviderSupport 决定
    const record = makeRecord({ isClaimableAsSupported: true });
    expect(providerSupportRecordSchema.safeParse(record).success).toBe(true);
    expect(canClaimProviderSupport(record.supportLevel as never)).toBe(false);
  });
});