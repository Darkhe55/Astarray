/**
 * 反例（裁定输入必须有界 + Provider 单次请求超时可配置）：
 * 1. `InteractivePermissionAskDecisionPort` 读取 stdin 时**没有超时**：管道输入在第一轮
 *    被消费后，第二轮会永久挂起（2026-10-01 真实收口实测：CLI 卡死 16 分钟，被迫人工终止）。
 * 2. CLI 三个入口从未把 Provider 单次请求超时传下去，只能吃注册表默认 30_000ms；
 *    实测真实模型单次响应可能超过 30s → `Provider 请求失败或超时（30000ms）`。
 *
 * 本文件在实现前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InteractivePermissionAskDecisionPort } from "../../../packages/tui/src/cli/permission-ask-adjudication.js";
import { buildRuntimeSelection } from "../../../packages/tui/src/cli/runtime-selection.js";

const ASK = {
  taskIdentifier: "T-001",
  toolName: "createProjectFile",
  argumentsJson: '{"filePath":"tasks/PROBE.md","content":"x"}',
  explanation: "执行任务需要调用工具 createProjectFile",
};

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-timeout-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("裁决输入有界性", () => {
  it("stdin 无任何输入 → 在超时后返回 null（fail-closed，不永久挂起）", async () => {
    const port = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => true,
      readLine: () => new Promise<string | null>(() => {}), // 永不结算：模拟管道已耗尽
      readTimeoutMilliseconds: 60,
    });
    const startedAt = Date.now();
    const decision = await port.readDecision(ASK);
    const elapsedMilliseconds = Date.now() - startedAt;
    expect(decision).toBeNull();
    expect(elapsedMilliseconds).toBeGreaterThanOrEqual(50);
    expect(elapsedMilliseconds).toBeLessThan(2_000);
  });

  it("默认超时为有界正数（不得为 0/Infinity）", () => {
    const port = new InteractivePermissionAskDecisionPort({
      isInteractive: () => false,
      hasDecisionInput: () => true,
      readLine: () => new Promise<string | null>(() => {}),
    });
    expect(port.getReadTimeoutMilliseconds()).toBeGreaterThan(0);
    expect(Number.isFinite(port.getReadTimeoutMilliseconds())).toBe(true);
  });
});

describe("Provider 单次请求超时可由入口配置", () => {
  it("运行时选择把 providerRequestTimeoutMilliseconds 传给 Provider 配置", async () => {
    const credentialStoreDirectory = path.join(stateDirectory, "providers");
    await fs.mkdir(credentialStoreDirectory, { recursive: true });
    await fs.writeFile(
      path.join(credentialStoreDirectory, "provider-credentials.json"),
      JSON.stringify({
        "cred-timeout": {
          referenceId: "cred-timeout",
          baseUrl: "http://127.0.0.1:9/v1/chat/completions",
          apiKey: "k",
        },
      }),
      "utf8",
    );
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      stateDirectory,
      providerModelIdentifier: "m",
      providerCredentialReference: "cred-timeout",
      providerRequestTimeoutMilliseconds: 123_456,
    });
    expect(selection.provider?.requestTimeoutMilliseconds).toBe(123_456);
  });

  it("未给该参数时不覆盖（由注册表默认决定）", async () => {
    const selection = await buildRuntimeSelection({
      runtime: "openai-compatible",
      providerEndpoint: "http://127.0.0.1:9/v1/chat/completions",
      providerModelIdentifier: "m",
    });
    expect(selection.provider?.requestTimeoutMilliseconds).toBeUndefined();
  });
});
