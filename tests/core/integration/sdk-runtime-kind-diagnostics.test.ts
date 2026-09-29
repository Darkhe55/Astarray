/**
 * 诊断面 runtimeKind 反例：产品入口必须能直接证明"选到的是 provider 而不是 mock"，
 * 不能只靠 CLI 退出码或选项面间接推断。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-runtime-kind-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("诊断面 runtimeKind", () => {
  it("mock 运行时如实报告 mock", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory: path.join(stateDirectory, "mock"),
      mode: "assist",
      runtime: "mock",
    });
    expect(
      (application.getRuntimeDiagnostics() as Record<string, unknown>).runtimeKind,
    ).toBe("mock");
    await application.shutdown();
  });

  it("provider 运行时如实报告 provider（不因隔离反馈进程而改变）", async () => {
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory: path.join(stateDirectory, "provider"),
      mode: "assist",
      runtime: "provider",
      providerRuntimeRegistry: registry,
      provider: {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelIdentifier: "fake-model",
        allowedModelIdentifiers: ["fake-model"],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: "http://127.0.0.1:9/v1",
        protectedCredentialReferenceId: "cred-1",
      },
      useFeedbackProcess: false,
    });
    expect(
      (application.getRuntimeDiagnostics() as Record<string, unknown>).runtimeKind,
    ).toBe("provider");
    await application.shutdown();
  });
});
