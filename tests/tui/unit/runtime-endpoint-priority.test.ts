/**
 * 行为反例（2026-10-10 **真实 Provider 实测发现**）：显式的 `--provider-endpoint`
 * **不得被静默忽略**。
 *
 * **缺陷现象**：用受保护凭据引用跑真实 Provider 时
 *   `astarray run … --provider-credential-reference prov-X --provider-endpoint <正确端点>`
 * 无论 `--provider-endpoint` 给什么都 **404**，因为该分支
 * （`runtime-selection.ts` 的凭据引用路径）**一律**取 `credentialEntry.baseUrl`，
 * **显式传入的端点被直接丢弃**。
 *
 * 为什么危险：**静默丢弃用户显式给出的参数**比报错更糟 ——
 * 用户看到的是一个毫无线索的 404，会去怀疑端点、协议、模型或凭据，
 * 而**真正的原因是他的参数根本没被读**。
 *
 * 更具体的触发条件（本仓真实数据）：凭据里 `prov-unisound-1` 的 `baseUrl` 是
 * `https://maas-api.unisound.com/v1`（**OpenAI 形态、不含路径**），
 * 而两个 runtime 都把 `baseUrl` 当**完整端点**逐字 POST
 * （`openai-compatible-runtime.ts:149` / `anthropic-messages-runtime.ts:166`）
 * ⇒ 对 `anthropic-messages` 必然 404，且 `--provider-endpoint` 救不回来。
 *
 * 本片钉住的语义：
 *  - **显式给出的 `--provider-endpoint` 优先**（显式输入胜过存储默认值）；
 *  - 未给出时才回退到凭据里的 `baseUrl`（**原有契约不得丢失**，见
 *    `runtime-credential-selection.test.ts` 第一条）；
 *  - 回退来源必须**可区分**（记录 `isEndpointFromCredential`，
 *    便于诊断"我用的是凭据里的端点还是我给的端点"）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProviderCredentialStore } from "../../../packages/tui/src/cli/provider-cli.js";
import { buildRuntimeSelection } from "../../../packages/tui/src/cli/runtime-selection.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-endpoint-priority-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

const credentialBaseUrl = "https://example.invalid/v1";
const explicitEndpoint = "https://example.invalid/anthropic/v1/messages";

async function seedCredential(): Promise<void> {
  const store = new FileProviderCredentialStore(stateDirectory);
  await store.writeCredential({
    referenceId: "ref-1",
    baseUrl: credentialBaseUrl,
    apiKey: "not-a-real-key",
  });
}

describe("凭据引用 + 显式端点：显式端点必须优先", () => {
  it("① 同时给出引用与 --provider-endpoint ⇒ 必须用**显式端点**（不得静默忽略）", async () => {
    await seedCredential();
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      providerEndpoint: explicitEndpoint,
      stateDirectory,
    });
    expect(selection.provider?.baseUrl).toBe(explicitEndpoint);
  });

  it("② 未给 --provider-endpoint ⇒ 回退凭据 baseUrl（原有契约不得丢失）", async () => {
    await seedCredential();
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      stateDirectory,
    });
    expect(selection.provider?.baseUrl).toBe(credentialBaseUrl);
  });

  it("③ 端点来源必须**可区分**（诊断「我用的到底是谁的端点」）", async () => {
    await seedCredential();

    const fromFlag = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      providerEndpoint: explicitEndpoint,
      stateDirectory,
    });
    expect(fromFlag.provider?.isEndpointFromCredential).toBe(false);

    const fromCredential = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      stateDirectory,
    });
    expect(fromCredential.provider?.isEndpointFromCredential).toBe(true);
  });

  it("④ 空字符串的 --provider-endpoint 视同未给出（回退凭据，不产生空端点）", async () => {
    await seedCredential();
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerModelIdentifier: "test-model",
      providerCredentialReference: "ref-1",
      providerEndpoint: "",
      stateDirectory,
    });
    expect(selection.provider?.baseUrl).toBe(credentialBaseUrl);
  });
});
