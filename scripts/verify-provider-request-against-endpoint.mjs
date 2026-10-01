#!/usr/bin/env node
/**
 * 真实 Provider 请求体对照工具（**会产生真实网络请求，默认拒绝执行**）。
 *
 * 用途：把「本地捕获的请求体」按不同变体发给真实端点，用于区分
 * 服务端拒绝是请求形态问题还是内容问题（如 2026-10-01 的
 * `400 invalid msg role: function`）。
 *
 * 用法：
 *   node scripts/verify-provider-request-against-endpoint.mjs \
 *     --reference <受保护凭据引用 ID> --file <.tmp/captures/request-02.json> \
 *     --variant full|no-tools|truncate|openai-spec --allow-live-request
 *
 * 纪律：
 * - 必须显式给出 `--allow-live-request`，且 `--count`（默认 1）有上限，避免误刷费用；
 * - 凭据只从状态目录的受保护引用读取，不回显、不写日志；
 * - 变体说明：`openai-spec` 会把 `role=function` 改写为
 *   `assistant.tool_calls` + `role=tool`，用于验证规范形态是否被接受。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const argumentsList = process.argv.slice(2);
function takeArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

const isLiveAllowed = argumentsList.includes("--allow-live-request");
const referenceId = takeArgument("--reference", "prov-live-1");
const captureFilePath = path.resolve(takeArgument("--file", ".tmp/captures/request-02.json"));
const variant = takeArgument("--variant", "full");
const requestCount = Number.parseInt(takeArgument("--count", "1"), 10);
const stateDirectory = path.resolve(takeArgument("--state-directory", ".astarray"));

if (!isLiveAllowed) {
  console.error(
    "拒绝执行：本脚本会产生真实 Provider 请求与费用。确认后追加 --allow-live-request。",
  );
  process.exit(2);
}
if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 3) {
  console.error("--count 必须为 1..3（默认 1），防止误刷费用。");
  process.exit(2);
}

const credentialFilePath = path.join(stateDirectory, "providers", "provider-credentials.json");
const credentialEntries = JSON.parse(await fs.readFile(credentialFilePath, "utf8"));
const credentialEntry = credentialEntries[referenceId];
if (credentialEntry === undefined) {
  console.error(`受保护凭据引用不存在: ${referenceId}`);
  process.exit(2);
}

const captured = JSON.parse(await fs.readFile(captureFilePath, "utf8"));
let requestBody = captured.body ?? captured;
if (variant === "no-tools") {
  requestBody = { ...requestBody, tools: [] };
}
if (variant === "truncate") {
  requestBody = {
    ...requestBody,
    messages: (requestBody.messages ?? []).map((message) => ({
      ...message,
      content: String(message.content).slice(0, 60),
    })),
  };
}
if (variant === "openai-spec") {
  const originalMessages = requestBody.messages ?? [];
  const legacyToolMessage = originalMessages.find((message) => message.role === "function");
  if (legacyToolMessage === undefined) {
    console.error("openai-spec 变体需要一条 role=function 的遗留消息作为输入。");
    process.exit(2);
  }
  requestBody = {
    ...requestBody,
    messages: [
      ...originalMessages.filter((message) => message.role !== "function"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: legacyToolMessage.tool_call_id,
            type: "function",
            function: { name: legacyToolMessage.name, arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: legacyToolMessage.tool_call_id,
        content: String(legacyToolMessage.content),
      },
    ],
  };
}

const roleSummary = (requestBody.messages ?? []).map((message) => message.role).join(",");
console.log(
  `引用=${referenceId} 文件=${captureFilePath} 变体=${variant} bodyLength=${Buffer.byteLength(JSON.stringify(requestBody), "utf8")} roles=${roleSummary}`,
);

for (let attemptIndex = 1; attemptIndex <= requestCount; attemptIndex += 1) {
  const startedAt = Date.now();
  const response = await fetch(credentialEntry.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentialEntry.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (response.ok) {
    await response.text();
    console.log(`#${attemptIndex} ${response.status} OK（${Date.now() - startedAt}ms）`);
  } else {
    const errorText = (await response.text()).slice(0, 400).replace(/\s+/g, " ");
    console.log(`#${attemptIndex} ${response.status} FAIL（${Date.now() - startedAt}ms）: ${errorText}`);
  }
}
