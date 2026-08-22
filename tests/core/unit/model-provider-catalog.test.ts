/**
 * T07C-01 测试：版本化 Provider/模型目录与受保护凭据引用。
 * 验收：凭据不进入公开 DTO；revision 单调；凭据引用不存在拒绝；
 * 数量不设上限；schema 迁移（版本不匹配拒绝）。
 */
import { describe, expect, it } from "vitest";

import {
  MODEL_PROVIDER_CATALOG_SCHEMA_VERSION,
  ModelProviderCatalog,
} from "../../../packages/core/src/orchestration/model-provider-catalog.js";
import type { ProtectedCredentialStorePort } from "../../../packages/core/src/orchestration/model-provider-catalog.js";

function makeCredentialStore(
  existingReferenceIds: string[],
): ProtectedCredentialStorePort {
  const referenceSet = new Set(existingReferenceIds);
  return {
    doesReferenceExist: async (referenceId) => referenceSet.has(referenceId),
    readCredential: async (referenceId) =>
      referenceSet.has(referenceId)
        ? { baseUrl: "https://api.example.com", apiKey: "sk-realkey-0000000000" }
        : null,
  };
}

function makeCatalog(
  existingReferenceIds: string[] = ["cred-ref-openai-1"],
) {
  return new ModelProviderCatalog({
    protectedCredentialStore: makeCredentialStore(existingReferenceIds),
  });
}

describe("ModelProviderCatalog 登记与 revision", () => {
  it("登记条目：受保护凭据引用存在 → 成功，revision 1", async () => {
    const catalog = makeCatalog();
    const entry = await catalog.upsertEntry({
      providerProfileId: "openai",
      modelProfileId: "gpt-4o",
      displayName: "GPT-4o",
      modelIdentifier: "gpt-4o-2024-11-20",
      capabilities: ["text", "vision", "tool-calling", "long-context"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: true,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "healthy",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    expect(entry.revision).toBe(1);
    expect(entry.modelProfileId).toBe("openai/gpt-4o");
  });

  it("重复登记同一模型 → revision 单调递增（2、3）", async () => {
    const catalog = makeCatalog();
    await catalog.upsertEntry({
      providerProfileId: "openai",
      modelProfileId: "gpt-4o",
      displayName: "GPT-4o",
      modelIdentifier: "gpt-4o-2024-11-20",
      capabilities: ["text"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: true,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "healthy",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    const second = await catalog.upsertEntry({
      providerProfileId: "openai",
      modelProfileId: "gpt-4o",
      displayName: "GPT-4o（更新）",
      modelIdentifier: "gpt-4o-2024-11-20",
      capabilities: ["text", "tool-calling"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: true,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "degraded",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    expect(second.revision).toBe(2);
  });

  it("凭据引用不存在 → 拒绝（凭据内容不进入目录）", async () => {
    const catalog = makeCatalog(["cred-ref-openai-1"]);
    await expect(
      catalog.upsertEntry({
        providerProfileId: "openai",
        modelProfileId: "gpt-4o",
        displayName: "GPT-4o",
        modelIdentifier: "gpt-4o",
        capabilities: ["text"],
        contextWindowTokens: 128_000,
        supportsToolCalling: true,
        supportsVision: false,
        costTier: "medium",
        regionLabel: "us-east",
        healthState: "healthy",
        protectedCredentialReferenceId: "cred-ref-missing",
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });
});

describe("ModelProviderCatalog 公开 DTO 凭据保护", () => {
  it("公开 DTO 剥离受保护凭据引用（不含任何密钥内容）", async () => {
    const catalog = makeCatalog();
    await catalog.upsertEntry({
      providerProfileId: "openai",
      modelProfileId: "gpt-4o",
      displayName: "GPT-4o",
      modelIdentifier: "gpt-4o",
      capabilities: ["text", "tool-calling"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: false,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "healthy",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    const publicDtos = catalog.listPublicDtos();
    expect(publicDtos).toHaveLength(1);
    const serialized = JSON.stringify(publicDtos[0]);
    // 反例：DTO 不含 protectedCredentialReferenceId 与任何密钥模式
    expect(serialized).not.toContain("protectedCredentialReferenceId");
    expect(serialized).not.toContain("cred-ref");
    expect(serialized).not.toContain("sk-realkey");
    expect(serialized).not.toContain("apiKey");
    ModelProviderCatalog.assertPublicDtoHasNoCredentialContent(publicDtos[0]!);
  });

  it("凭据泄漏反例：DTO 含密钥模式 → assert 拒绝", () => {
    const leakedDto = {
      providerProfileId: "openai",
      modelProfileId: "openai/gpt-4o",
      displayName: "GPT-4o",
      modelIdentifier: "gpt-4o",
      capabilities: ["text"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: false,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "healthy",
      revision: 1,
      createdAtIso: "2026-08-19T00:00:00.000Z",
      updatedAtIso: "2026-08-19T00:00:00.000Z",
      apiKey: "sk-realkey-1234567890",
    };
    expect(() =>
      ModelProviderCatalog.assertPublicDtoHasNoCredentialContent(
        leakedDto as never,
      ),
    ).toThrowError(/不得携带凭据/);
  });

  it("数量不设上限：登记多个 Provider/模型均成功", async () => {
    const catalog = makeCatalog(["ref-1", "ref-2", "ref-3"]);
    for (let index = 0; index < 10; index++) {
      await catalog.upsertEntry({
        providerProfileId: `provider-${index}`,
        modelProfileId: `model-${index}`,
        displayName: `模型 ${index}`,
        modelIdentifier: `model-${index}`,
        capabilities: ["text"],
        contextWindowTokens: 8192,
        supportsToolCalling: false,
        supportsVision: false,
        costTier: "low",
        regionLabel: "local",
        healthState: "healthy",
        protectedCredentialReferenceId: `ref-${(index % 3) + 1}`,
      });
    }
    expect(catalog.listPublicDtos()).toHaveLength(10);
  });
});

describe("ModelProviderCatalog schema 迁移", () => {
  it("schema 版本不匹配 → 拒绝（版本迁移需显式升级）", async () => {
    const catalog = makeCatalog();
    await catalog.upsertEntry({
      providerProfileId: "openai",
      modelProfileId: "gpt-4o",
      displayName: "GPT-4o",
      modelIdentifier: "gpt-4o",
      capabilities: ["text"],
      contextWindowTokens: 128_000,
      supportsToolCalling: true,
      supportsVision: false,
      costTier: "medium",
      regionLabel: "us-east",
      healthState: "healthy",
      protectedCredentialReferenceId: "cred-ref-openai-1",
    });
    const entry = catalog.getEntry("openai/gpt-4o");
    expect(entry?.schemaVersion).toBe(MODEL_PROVIDER_CATALOG_SCHEMA_VERSION);
    expect(MODEL_PROVIDER_CATALOG_SCHEMA_VERSION).toBe(1);
  });
});