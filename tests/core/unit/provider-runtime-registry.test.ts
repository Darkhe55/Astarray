/**
 * T07D-R2-01：Provider 配置与运行时注册（行为反例 → 实现）。
 * 验收：runtime 选择不静默回退 mock；缺配置/无匹配模型/能力不足稳定失败；
 * 凭据不进入模型、错误或导出。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  ProviderConfigurationError,
  ProviderRuntimeRegistry,
  type ProviderRuntimeRegistration,
} from "../../../packages/core/src/runtime/provider-runtime-registry.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

const SECRET_SENTINEL = "sk-sentinel-must-not-leak-12345";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r2-01-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function makeRecordingRegistration(label: string) {
  const createdModelIdentifiers: string[] = [];
  const registration: ProviderRuntimeRegistration = {
    providerId: "test-provider",
    protocol: "openai-compatible",
    protocolVersion: "chat-completions/stream-tools-2026-09-10",
    supportedCapabilities: ["streaming", "tool-calling", "cancellation"],
    createRuntime: (config) => {
      createdModelIdentifiers.push(config.modelIdentifier);
      return new ScriptedRuntime([
        { type: "text", text: "（registered provider runtime " + label + "）" },
        { type: "finish", reason: "success", detail: "provider run" },
      ]);
    },
  };
  return { registration, createdModelIdentifiers };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "test-provider",
    modelIdentifier: "test-model",
    allowedModelIdentifiers: ["test-model"],
    baseUrl: "http://127.0.0.1:9/v1/chat/completions",
    protectedCredentialReferenceId: "credential-ref-1",
    ...overrides,
  } as never;
}

describe("T07D-R2-01：Provider 运行时注册与配置协商", () => {
  it("未注册 provider 稳定失败（不回退 mock）", async () => {
    const registry = new ProviderRuntimeRegistry();
    await expect(
      registry.resolveRuntime(baseRequest({ providerId: "unknown-provider" })),
    ).rejects.toMatchObject({ errorCode: "runtime-unsupported" });
  });

  it("重复注册与缺配置/模型/能力均稳定失败", async () => {
    const registry = new ProviderRuntimeRegistry();
    const recording = makeRecordingRegistration("A");
    registry.register(recording.registration);
    expect(() => registry.register(recording.registration)).toThrow(
      /provider-already-registered|已注册/,
    );

    await expect(
      registry.resolveRuntime(baseRequest({ baseUrl: null })),
    ).rejects.toMatchObject({ errorCode: "provider-config-missing" });

    await expect(
      registry.resolveRuntime(
        baseRequest({ allowedModelIdentifiers: ["another-model"] }),
      ),
    ).rejects.toMatchObject({ errorCode: "model-not-allowed" });

    await expect(
      registry.resolveRuntime(
        baseRequest({ requiredCapabilities: ["vision-input"] }),
      ),
    ).rejects.toMatchObject({ errorCode: "capability-unavailable" });
  });

  it("凭据引用缺失稳定失败，且秘密不进入错误或描述", async () => {
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => false,
        readCredential: async () => ({
          baseUrl: "http://127.0.0.1:9/v1/chat/completions",
          apiKey: SECRET_SENTINEL,
        }),
      },
    });
    registry.register(makeRecordingRegistration("B").registration);

    let captured: unknown;
    try {
      await registry.resolveRuntime(baseRequest());
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ProviderConfigurationError);
    expect(captured).toMatchObject({ errorCode: "credential-reference-missing" });
    const serialized = JSON.stringify(captured) + String(captured);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(registry.describeRegistrations())).not.toContain(
      SECRET_SENTINEL,
    );
  });

  it("成功解析返回无秘密描述符与每次新建运行时工厂", async () => {
    const registry = new ProviderRuntimeRegistry();
    const recording = makeRecordingRegistration("C");
    registry.register(recording.registration);

    const resolved = await registry.resolveRuntime(baseRequest());
    expect(resolved.descriptor).toMatchObject({
      providerId: "test-provider",
      protocol: "openai-compatible",
    });
    expect(JSON.stringify(resolved.descriptor)).not.toContain("apiKey");
    expect(resolved.createRuntime()).toBeDefined();
    expect(resolved.createRuntime()).toBeDefined();
    expect(recording.createdModelIdentifiers).toEqual(["test-model", "test-model"]);
  });
});

describe("T07D-R2-01：应用入口的运行时选择", () => {
  it("选择 provider 但无注册表 → runtime-unsupported（不得回退 mock）", async () => {
    await expect(
      AstarrayApplicationFacade.create({
        stateDirectory,
        mode: "assist",
        runtime: "provider",
        provider: {
          providerId: "test-provider",
          modelIdentifier: "test-model",
          allowedModelIdentifiers: ["test-model"],
          baseUrl: "http://127.0.0.1:9/v1/chat/completions",
          protectedCredentialReferenceId: "credential-ref-1",
        },
      }),
    ).rejects.toMatchObject({ errorCode: "runtime-unsupported" });
  });

  it("真实使用已注册 Provider 运行时完成 mock 服务器前的选择链路", async () => {
    const registry = new ProviderRuntimeRegistry();
    const recording = makeRecordingRegistration("selected");
    registry.register(recording.registration);

    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "provider",
      providerRuntimeRegistry: registry,
      provider: {
        providerId: "test-provider",
        modelIdentifier: "test-model",
        allowedModelIdentifiers: ["test-model"],
        requiredCapabilities: ["streaming", "tool-calling"],
        baseUrl: "http://127.0.0.1:9/v1/chat/completions",
        protectedCredentialReferenceId: "credential-ref-1",
      },
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const accepted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "provider selection probe",
    });
    let result;
    const deadline = Date.now() + 5_000;
    while (true) {
      result = await application.queryTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
      });
      if (["done", "failed", "blocked", "cancelled"].includes(result.status) || Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await application.shutdown();

    expect(accepted.status).toBe("accepted");
    expect(result?.status).toBe("done");
    // 选择链路证据：已注册运行时被真实创建并用于该 mission 的执行。
    expect(recording.createdModelIdentifiers.length).toBeGreaterThanOrEqual(1);
    expect(recording.createdModelIdentifiers).toContain("test-model");
    // 结果预览属 T07D-R1-03；此处容错终端状态先于存档写入的时序。
    if (result?.summaryPreview !== null) {
      expect(result?.summaryPreview ?? "").toContain("registered provider runtime");
    }
  });
});
