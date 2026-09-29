/**
 * 受保护凭据引用反例：provider 运行必须能走 config provider 写入的受保护引用，
 * 且引用缺失时 fail-closed（不回退环境变量、不回退 mock）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProviderCredentialStore } from "../../../packages/tui/src/cli/provider-cli.js";
import { buildRuntimeSelection } from "../../../packages/tui/src/cli/runtime-selection.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cred-ref-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("受保护凭据引用", () => {
  it("引用存在 → 使用受保护存储的 baseUrl/key，无需 --provider-endpoint", async () => {
    const store = new FileProviderCredentialStore(stateDirectory);
    await store.writeCredential({
      referenceId: "ref-1",
      baseUrl: "http://127.0.0.1:9/v1/chat/completions",
      apiKey: "secret-key",
    });
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      stateDirectory,
    });
    expect(selection.runtime).toBe("provider");
    expect(selection.provider?.protectedCredentialReferenceId).toBe("ref-1");
    expect(selection.provider?.baseUrl).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(selection.providerRuntimeRegistry).toBeDefined();
  });

  it("引用不存在 → provider-credential-not-found（不回退环境变量/mock）", async () => {
    await expect(
      buildRuntimeSelection({
        runtime: "openai-compatible",
        providerModelIdentifier: "test-model",
        providerCredentialReference: "missing-ref",
        stateDirectory,
      }),
    ).rejects.toMatchObject({ errorCode: "provider-credential-not-found" });
  });

  it("仍保留环境变量路径（未给引用时）", async () => {
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerEndpoint: "http://127.0.0.1:9/v1/chat/completions",
      providerModelIdentifier: "test-model",
    });
    expect(selection.runtime).toBe("provider");
    expect(selection.provider?.protectedCredentialReferenceId).toBe(
      "credential-reference:cli-provider",
    );
  });
});
