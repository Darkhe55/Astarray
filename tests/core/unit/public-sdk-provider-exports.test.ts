/**
 * 公开入口可用性反例：SDK 消费者必须能**只用公开 exports** 构造 Provider 运行时，
 * 否则 runtime: "provider" 在打包后不可用（tarball 验收会直接失败）。
 */
import { describe, expect, it } from "vitest";

import * as publicSdk from "../../../packages/core/src/public-sdk.js";

describe("公开入口的 Provider 构造能力", () => {
  it("暴露注册表与 openai-compatible 注册入口", () => {
    expect(typeof (publicSdk as Record<string, unknown>).ProviderRuntimeRegistry).toBe("function");
    expect(
      typeof (publicSdk as Record<string, unknown>).createOpenAiCompatibleProviderRegistration,
    ).toBe("function");
    expect((publicSdk as Record<string, unknown>).OPENAI_COMPATIBLE_PROVIDER_ID).toBe(
      "openai-compatible",
    );
  });

  it("可实际注册 openai-compatible 运行时", () => {
    const ProviderRuntimeRegistryClass = (
      publicSdk as unknown as { ProviderRuntimeRegistry: new (options: unknown) => { register(r: unknown): void; listProviderIds(): string[] } }
    ).ProviderRuntimeRegistry;
    const registry = new ProviderRuntimeRegistryClass({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }),
      },
    });
    registry.register(
      (publicSdk as unknown as { createOpenAiCompatibleProviderRegistration: () => unknown }).createOpenAiCompatibleProviderRegistration(),
    );
    expect(registry.listProviderIds()).toContain("openai-compatible");
  });
});
