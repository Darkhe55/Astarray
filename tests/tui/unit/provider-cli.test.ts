/**
 * T07D-06 测试：Provider 配置装配与受保护凭据引用。
 * 验收：config provider list/show 与 doctor --provider 无凭据回显；
 * 凭据引用缺失 → doctor 报告缺失；mock 仍为默认离线路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileProviderCredentialStore,
  ProviderCliCatalog,
} from "../../../packages/tui/src/cli/provider-cli.js";
import {
  executeDoctorProviderCommand,
  executeProviderListCommand,
  executeProviderShowCommand,
} from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d06-"));
  stdoutBuffer = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  afterEach(() => {
    process.stdout.write = originalWrite;
  });
});

async function registerDemoProvider() {
  const store = new FileProviderCredentialStore(temporaryDirectory);
  await store.writeCredential({
    referenceId: "cred-ref-demo-1",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-demo-realkey-000000000000",
  });
  const catalog = new ProviderCliCatalog(temporaryDirectory);
  await catalog.registerProvider({
    providerProfileId: "demo-provider",
    protocolName: "generic-openai-compatible",
    apiVersion: "2024-06-01",
    capabilities: ["text", "tool-calling"],
    supportLevel: "adapter-only",
    protectedCredentialReferenceId: "cred-ref-demo-1",
    credentialStore: store,
  });
  return { store, catalog };
}

describe("受保护凭据存储", () => {
  it("凭据文件写入/读取（值只在端口内流转）；引用存在性校验", async () => {
    const store = new FileProviderCredentialStore(temporaryDirectory);
    await store.writeCredential({
      referenceId: "cred-ref-1",
      baseUrl: "https://x",
      apiKey: "sk-secret-value-123",
    });
    expect(await store.doesReferenceExist("cred-ref-1")).toBe(true);
    expect(await store.doesReferenceExist("ghost")).toBe(false);
    expect((await store.readCredential("cred-ref-1"))?.apiKey).toBe(
      "sk-secret-value-123",
    );
    expect(await store.listReferenceIds()).toContain("cred-ref-1");
  });

  it("凭据引用不存在 → 目录登记拒绝", async () => {
    const store = new FileProviderCredentialStore(temporaryDirectory);
    const catalog = new ProviderCliCatalog(temporaryDirectory);
    await expect(
      catalog.registerProvider({
        providerProfileId: "p",
        protocolName: "mock",
        apiVersion: "1",
        capabilities: ["text"],
        supportLevel: "adapter-only",
        protectedCredentialReferenceId: "missing-ref",
        credentialStore: store,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });
});

describe("config provider 命令", () => {
  it("list：列出公开 Provider 信息（无凭据引用/密钥）", async () => {
    await registerDemoProvider();
    await executeProviderListCommand({
      stateDirectory: temporaryDirectory,
      isJsonOutput: true,
    });
    const serialized = stdoutBuffer.join("");
    expect(serialized).toContain("demo-provider");
    expect(serialized).not.toContain("cred-ref");
    expect(serialized).not.toContain("sk-");
  });

  it("show：协议/API 版本/支持等级（无响应正文）", async () => {
    await registerDemoProvider();
    await executeProviderShowCommand({
      stateDirectory: temporaryDirectory,
      providerProfileId: "demo-provider",
      isJsonOutput: false,
    });
    const text = stdoutBuffer.join("");
    expect(text).toContain("generic-openai-compatible@2024-06-01");
    expect(text).toContain("adapter-only");
    expect(text).toContain("未验证");
  });

  it("show：未登记 Provider → 报错", async () => {
    await expect(
      executeProviderShowCommand({
        stateDirectory: temporaryDirectory,
        providerProfileId: "ghost-provider",
        isJsonOutput: true,
      }),
    ).rejects.toThrow(/未登记/);
  });
});

describe("doctor --provider", () => {
  it("凭据引用已解析：报告协议/等级/就绪状态（无网络探测、无凭据回显）", async () => {
    await registerDemoProvider();
    await executeDoctorProviderCommand({
      stateDirectory: temporaryDirectory,
      providerProfileId: "demo-provider",
      isJsonOutput: true,
    });
    const serialized = stdoutBuffer.join("");
    expect(serialized).toContain('"credentialReferenceResolved":true');
    expect(serialized).toContain('"supportLevel":"adapter-only"');
    expect(serialized).toContain('"isReadyForProductPath":false');
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("sk-demo-realkey");
  });

  it("凭据引用缺失：doctor 报告缺失（不静默改用未授权 Provider）", async () => {
    const store = new FileProviderCredentialStore(temporaryDirectory);
    const catalog = new ProviderCliCatalog(temporaryDirectory);
    await store.writeCredential({ referenceId: "other-ref", baseUrl: "x", apiKey: "k" });
    // 登记时引用必须存在（缺失 → 拒绝登记，不会进入目录）
    await expect(
      catalog.registerProvider({
        providerProfileId: "p-missing-creds",
        protocolName: "mock",
        apiVersion: "1",
        capabilities: ["text"],
        supportLevel: "adapter-only",
        protectedCredentialReferenceId: "cred-ref-demo-1",
        credentialStore: store,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    // 未登记的 Provider 在 doctor 中报告未登记（不静默可用）
    await expect(
      executeDoctorProviderCommand({
        stateDirectory: temporaryDirectory,
        providerProfileId: "p-missing-creds",
        isJsonOutput: true,
      }),
    ).rejects.toThrow(/未登记/);
  });
});