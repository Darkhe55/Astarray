/**
 * 人工编辑窗口代理的自测（Node 内置 test runner；`npm run test:scripts` 会跑到）。
 *
 * 用本地假上游验证行为契约，**不需要额度**：
 *  ① 不含目标工具调用的响应 → 立即放行；
 *  ② 含目标工具调用的响应 → 扣住，直到目标文件内容变化才放行；
 *  ③ 超时未编辑 → 放行但如实标记"未检测到人工编辑"；
 *  ④ 请求体被完整透传（供事后复核"拒绝来源"）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startHumanEditWindowProxy, extractRequestedToolNames } from "./human-edit-window-proxy.mjs";

test("工具调用判定必须解析 tool_calls，而不是子串匹配（2026-10-09 真实失败教训）", () => {
  // 只是文字里提到工具名（任务提示词/模型解释）→ 不得判为发起调用。
  const textOnlyResponse =
    "data: {\"choices\":[{\"delta\":{\"content\":\"我将使用 replaceFileContent 覆盖该文件\"}}]}\n\n" +
    "data: [DONE]\n\n";
  assert.deepEqual(extractRequestedToolNames(textOnlyResponse), []);
  // 真正发起调用（openai-compatible）。
  const openAiToolCall =
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"replaceFileContent\",\"arguments\":\"{}\"}}]}}]}\n\n";
  assert.deepEqual(extractRequestedToolNames(openAiToolCall), ["replaceFileContent"]);
  // 改了别的工具 → 不得判为目标工具。
  const otherToolCall =
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"readFile\",\"arguments\":\"{}\"}}]}}]}\n\n";
  assert.deepEqual(extractRequestedToolNames(otherToolCall), ["readFile"]);
  // anthropic-messages 形态。
  const anthropicToolCall =
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"name\":\"replaceFileContent\"}}\n\n";
  assert.deepEqual(extractRequestedToolNames(anthropicToolCall), ["replaceFileContent"]);
  // 非 JSON / [DONE] 行不得抛错。
  assert.deepEqual(extractRequestedToolNames("data: not-json\n\ndata: [DONE]\n\n"), []);
});

function buildFakeUpstream(responseBodies) {
  let callIndex = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const body = responseBodies[Math.min(callIndex, responseBodies.length - 1)];
      callIndex += 1;
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(body);
    });
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return "http://127.0.0.1:" + String(typeof address === "object" ? address.port : 0) + "/v1/chat/completions";
}

test("默认 5 分钟 requestTimeout 必须关闭（否则长窗口会被 Node 销毁 socket）", async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "astarray-proxy-"));
  const targetFilePath = path.join(temporaryDirectory, "TARGET.txt");
  writeFileSync(targetFilePath, "原始\n", "utf8");
  const upstream = buildFakeUpstream(["data: [DONE]\n\n"]);
  const upstreamEndpoint = await listen(upstream);
  const proxy = await startHumanEditWindowProxy({
    upstreamEndpoint,
    targetFilePath,
    initialTargetContent: "原始\n",
  });
  try {
    assert.deepEqual(proxy.getServerTimeoutMilliseconds(), {
      requestTimeout: 0,
      headersTimeout: 0,
      timeout: 0,
      keepAliveTimeout: 0,
    });
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("不含目标工具调用的响应必须立即放行", async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "astarray-proxy-"));
  const targetFilePath = path.join(temporaryDirectory, "TARGET.txt");
  writeFileSync(targetFilePath, "原始\n", "utf8");
  const upstream = buildFakeUpstream(["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"]);
  const upstreamEndpoint = await listen(upstream);
  const proxy = await startHumanEditWindowProxy({
    upstreamEndpoint,
    targetFilePath,
    initialTargetContent: "原始\n",
    humanEditDeadlineMilliseconds: 5_000,
  });
  try {
    const startedAt = Date.now();
    const response = await fetch(proxy.endpoint, { method: "POST", body: "{}" });
    const elapsed = Date.now() - startedAt;
    assert.equal(await response.text(), "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
    assert.ok(elapsed < 1_000, "不含目标工具调用时不应扣留（耗时 " + String(elapsed) + "ms）");
    assert.equal(proxy.getHeldResponseCount(), 0);
    assert.equal(proxy.wasHumanEditDetected(), false);
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("含目标工具调用的响应必须扣住，直到目标文件内容变化才放行", async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "astarray-proxy-"));
  const targetFilePath = path.join(temporaryDirectory, "TARGET.txt");
  writeFileSync(targetFilePath, "原始\n", "utf8");
  const upstreamBody =
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"replaceFileContent\"}}]}}]}\n\n";
  const upstream = buildFakeUpstream([upstreamBody]);
  const upstreamEndpoint = await listen(upstream);
  const instructionCalls = [];
  const detectedCalls = [];
  const proxy = await startHumanEditWindowProxy({
    upstreamEndpoint,
    targetFilePath,
    initialTargetContent: "原始\n",
    humanEditDeadlineMilliseconds: 10_000,
    onHumanEditInstruction: (detail) => instructionCalls.push(detail),
    onHumanEditDetected: (detail) => detectedCalls.push(detail),
  });
  try {
    let isSettled = false;
    const pendingRequest = fetch(proxy.endpoint, { method: "POST", body: "{\"probe\":true}" }).then(
      async (response) => {
        isSettled = true;
        return response.text();
      },
    );
    // 未编辑前：必须仍在扣留。
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(isSettled, false, "尚未人工编辑时不得放行响应");
    assert.equal(proxy.getHeldResponseCount(), 1);
    assert.equal(instructionCalls.length, 1, "开始等待时应给出一次编辑提示");
    // 人工编辑。
    writeFileSync(targetFilePath, "人工修改（必须保留）\n", "utf8");
    const bodyText = await pendingRequest;
    assert.equal(bodyText, upstreamBody);
    assert.equal(proxy.wasHumanEditDetected(), true);
    assert.equal(proxy.getDetectedHumanContent(), "人工修改（必须保留）\n");
    assert.equal(detectedCalls.length, 1);
    // 请求体被完整透传（供事后复核）。
    assert.equal(proxy.getRequestBodyTexts()[0], "{\"probe\":true}");
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("超时未编辑：放行且如实标记未检测到人工编辑（不伪造成功）", async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "astarray-proxy-"));
  const targetFilePath = path.join(temporaryDirectory, "TARGET.txt");
  writeFileSync(targetFilePath, "原始\n", "utf8");
  // 必须是**真实发起的工具调用**（子串匹配时代这里放的是纯文本，现已按设计不再扣留）。
  const upstreamBody =
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"replaceFileContent\",\"arguments\":\"{}\"}}]}}]}\n\n";
  const upstream = buildFakeUpstream([upstreamBody]);
  const upstreamEndpoint = await listen(upstream);
  const proxy = await startHumanEditWindowProxy({
    upstreamEndpoint,
    targetFilePath,
    initialTargetContent: "原始\n",
    humanEditDeadlineMilliseconds: 600,
  });
  try {
    const startedAt = Date.now();
    const response = await fetch(proxy.endpoint, { method: "POST", body: "{}" });
    assert.equal(await response.text(), upstreamBody);
    assert.ok(Date.now() - startedAt >= 500, "应确实等待过人工编辑");
    assert.equal(proxy.wasHumanEditDetected(), false);
    assert.equal(proxy.getDetectedHumanContent(), null);
    assert.equal(readFileSync(targetFilePath, "utf8"), "原始\n");
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
