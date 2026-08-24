/**
 * T07D-05 测试：Azure OpenAI 与 Amazon Bedrock 适配边界。
 * 验收：Azure deployment/api-version 路径与双认证模式；
 * Bedrock ConverseStream 事件与 SigV4 本地签名（凭据不进入 Agent 上下文）。
 */
import { describe, expect, it } from "vitest";

import { AzureOpenAiAdapter } from "../../../packages/core/src/runtime/azure-openai-adapter.js";
import {
  AwsSigV4Signer,
  BedrockConverseAdapter,
} from "../../../packages/core/src/runtime/bedrock-converse-adapter.js";
import type { NormalizedProviderEvent } from "../../../packages/core/src/runtime/provider-protocol-port.js";

async function collect(
  adapter: {
    parseEventStream(chunks: AsyncIterable<string>): AsyncIterable<NormalizedProviderEvent>;
  },
  chunks: string[],
) {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.parseEventStream(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  )) {
    events.push(event);
  }
  return events;
}

describe("AzureOpenAiAdapter", () => {
  it("请求路径含 deployment 与 api-version（无凭据）", () => {
    const adapter = new AzureOpenAiAdapter({
      endpointBaseUrl: "https://my-resource.openai.azure.com",
      deploymentName: "gpt-4o-deploy",
      apiVersion: "2024-06-01",
      authMode: { kind: "api-key", apiKeyReference: "cred-ref-azure-1" },
    });
    const requestPath = adapter.buildRequestPath();
    expect(requestPath).toContain("/openai/deployments/gpt-4o-deploy/chat/completions");
    expect(requestPath).toContain("api-version=2024-06-01");
    expect(requestPath).not.toContain("api-key");
    expect(requestPath).not.toContain("cred-ref");
  });

  it("认证模式二选一：API key 与 Entra token provider 均非 Bearer 硬编码", () => {
    const apiKeyAdapter = new AzureOpenAiAdapter({
      endpointBaseUrl: "https://my-resource.openai.azure.com",
      deploymentName: "deploy",
      apiVersion: "2024-06-01",
      authMode: { kind: "api-key", apiKeyReference: "cred-ref-azure-1" },
    });
    expect(apiKeyAdapter.getAuthMode()).toEqual({
      kind: "api-key",
      apiKeyReference: "cred-ref-azure-1",
    });
    const entraAdapter = new AzureOpenAiAdapter({
      endpointBaseUrl: "https://my-resource.openai.azure.com",
      deploymentName: "deploy",
      apiVersion: "2024-06-01",
      authMode: {
        kind: "entra-token-provider",
        tokenProviderReference: "cred-ref-entra-1",
      },
    });
    expect(entraAdapter.getAuthMode()).toEqual({
      kind: "entra-token-provider",
      tokenProviderReference: "cred-ref-entra-1",
    });
  });

  it("协议标识为 azure-openai（非冒充 Responses/Chat）", () => {
    const adapter = new AzureOpenAiAdapter({
      endpointBaseUrl: "https://my-resource.openai.azure.com",
      deploymentName: "deploy",
      apiVersion: "2024-06-01",
      authMode: { kind: "api-key", apiKeyReference: "cred-ref-azure-1" },
    });
    expect(adapter.protocolName).toBe("azure-openai");
    expect(adapter.protocolName).not.toBe("openai-responses");
  });
});

describe("BedrockConverseAdapter", () => {
  const adapter = new BedrockConverseAdapter();

  it("协议/API 版本显式记录", () => {
    expect(adapter.protocolName).toBe("bedrock-converse");
    expect(adapter.supportedApiVersion).toBe("2023-07-31");
  });

  it("文本流：streamStart → textDelta 多片 → messageStop", async () => {
    const events = await collect(adapter, [
      'data: {"eventType":"streamStart"}\n\n',
      'data: {"eventType":"contentBlockDelta","contentBlockIndex":0,"delta":{"type":"textDelta","text":"你好"}}\n\n',
      'data: {"eventType":"contentBlockDelta","contentBlockIndex":0,"delta":{"type":"textDelta","text":"世界"}}\n\n',
      'data: {"eventType":"messageStop","stopReason":"end_turn"}\n\n',
    ]);
    expect(events[0]).toMatchObject({ eventType: "response-started" });
    expect(events[1]).toMatchObject({ eventType: "text-delta", textDelta: "你好" });
    expect(events[2]).toMatchObject({ eventType: "text-delta", textDelta: "世界" });
    expect(events[3]).toMatchObject({
      eventType: "provider-completed",
      providerStopReason: "end_turn",
    });
  });

  it("工具调用：toolUse 起始 + inputJsonDelta 累积 + 完成", async () => {
    const events = await collect(adapter, [
      'data: {"eventType":"contentBlockStart","contentBlockIndex":0,"start":{"type":"toolUse","toolUseId":"tu-1","name":"project.read"}}\n\n',
      'data: {"eventType":"contentBlockDelta","contentBlockIndex":0,"delta":{"type":"toolUseDelta","inputJsonDelta":"{\\"file\\":"}}\n\n',
      'data: {"eventType":"contentBlockDelta","contentBlockIndex":0,"delta":{"type":"toolUseDelta","inputJsonDelta":"\\"a.ts\\"}"}}\n\n',
      'data: {"eventType":"contentBlockStop","contentBlockIndex":0}\n\n',
    ]);
    expect(events[0]).toMatchObject({
      eventType: "tool-call-started",
      toolCallIdentifier: "tu-1",
      toolName: "project.read",
    });
    expect(events[3]).toMatchObject({
      eventType: "tool-call-completed",
      finalArgumentsJson: '{"file":"a.ts"}',
    });
  });
});

describe("AwsSigV4Signer", () => {
  const signer = new AwsSigV4Signer({
    regionLabel: "us-east-1",
    serviceName: "bedrock",
    nowUnixMilliseconds: () => 1_752_000_000_000,
  });

  it("生成 SigV4 Authorization header（含签名；不含明文 secretKey）", () => {
    const signed = signer.signRequest({
      method: "POST",
      requestPath: "/model/anthropic.claude-3-5-sonnet/converse-stream",
      queryString: "",
      requestHeaders: {
        "content-type": "application/json",
        host: "bedrock-runtime.us-east-1.amazonaws.com",
      },
      requestBodyJson: '{"messages":[{"role":"user","content":"hi"}]}',
      credentials: {
        accessKeyId: "AKIAEXAMPLE00000000",
        secretAccessKey: "super-secret-aws-key-000000000000",
        sessionToken: null,
      },
    });
    expect(signed.authorizationHeader).toContain("AWS4-HMAC-SHA256");
    expect(signed.authorizationHeader).toContain("Credential=AKIAEXAMPLE00000000/");
    expect(signed.authorizationHeader).toContain("Signature=");
    // 凭据不进入 Agent 上下文：header 不含明文 secretKey
    expect(signed.authorizationHeader).not.toContain("super-secret-aws-key");
    expect(signed.canonicalRequestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("相同输入产生确定性签名；sessionToken 参与签名头", () => {
    const first = signer.signRequest({
      method: "POST",
      requestPath: "/model/m",
      queryString: "",
      requestHeaders: { "content-type": "application/json", host: "h" },
      requestBodyJson: "{}",
      credentials: {
        accessKeyId: "AKIAEXAMPLE00000000",
        secretAccessKey: "secret-1",
        sessionToken: "session-token-1",
      },
    });
    const second = signer.signRequest({
      method: "POST",
      requestPath: "/model/m",
      queryString: "",
      requestHeaders: { "content-type": "application/json", host: "h" },
      requestBodyJson: "{}",
      credentials: {
        accessKeyId: "AKIAEXAMPLE00000000",
        secretAccessKey: "secret-1",
        sessionToken: "session-token-1",
      },
    });
    expect(first.authorizationHeader).toBe(second.authorizationHeader);
    expect(first.authorizationHeader).toContain("x-amz-security-token");
  });
});