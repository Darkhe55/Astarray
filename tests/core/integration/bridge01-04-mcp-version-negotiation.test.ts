/**
 * 行为反例（2026-10-10 **真实客户端验证发现**）：`initialize` 必须按 MCP 规范
 * **协商到客户端请求的版本**，而不是无条件回自己的首选版本。
 *
 * **缺陷现象**：`opencode` 与 `pi` 都在 `initialize` 后**直接拒绝连接**：
 *
 * ```
 * astarray failed — Server's protocol version is not supported: 2026-07-28
 * ```
 *
 * 原因：本仓 `MCP_SUPPORTED_PROTOCOL_VERSION = "2026-07-28"`，
 * 而 `initialize` **总是**回这个值。真实客户端的支持集（从其实现读出，非猜测）：
 *  - `@earendil-works/pi-mcp`：`SUPPORTED_PROTOCOL_VERSIONS =`
 *    `["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]`，
 *    且它按 `LATEST_PROTOCOL_VERSION = "2025-11-25"` 发起请求；
 *  - `opencode`：同样不接受 `2026-07-28`。
 *
 * 为什么脚本化闭环没发现：`scripts/verify-mcp-bridge-loop.mjs` 里那个客户端是
 * **我们自己写的**，它回显我们自己的版本 ⇒ "协商成功"是**自证**。
 * 真实客户端会严格校验，这才是"他证"。**这正是 BRIDGE-01-04 存在的理由。**
 *
 * 本文件钉住的规范语义：
 *  - 客户端请求的版本在兼容集内 ⇒ **必须回该版本**，且
 *    `isRequestedVersionSupported` 为 `true`（不得出现"回了它请求的版本、
 *    却说自己不支持"的自相矛盾）；
 *  - 请求的版本完全不在兼容集内 ⇒ 回首选版本并如实报 `false`
 *    （让客户端决定是否断开，服务端不单方面宣称支持）；
 *  - 不传 `protocolVersion` ⇒ 回首选版本且视为可接受。
 *
 * 本文件在修复前必须失败（旧实现在 ① 回 `2026-07-28`）。
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  McpToolBridge,
  type McpBridgeApplicationPort,
  type McpBridgePrincipal,
} from "../../../packages/core/src/bridge/mcp-tool-bridge.js";
import {
  MCP_COMPATIBLE_PROTOCOL_VERSIONS,
  MCP_SUPPORTED_PROTOCOL_VERSION,
  runMcpStdioSession,
} from "../../../packages/core/src/bridge/mcp-stdio-server.js";

function createPort(): McpBridgeApplicationPort {
  return {
    submitTask: async () => ({ missionIdentifier: "mission-1" }),
    queryTask: async () => ({ status: "accepted", summaryPreview: null }),
    cancelTask: async () => {},
  };
}

function openBridgeSession(bridge: McpToolBridge): McpBridgePrincipal {
  return bridge.openSession({
    authenticatedPrincipalIdentifier: "external-harness:negotiation-probe",
    sessionId: "mcp-session-negotiation",
  }).principal;
}

/** 发一条 `initialize`，返回 `result`。 */
async function initializeWith(protocolVersion: string | undefined): Promise<Record<string, unknown>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const collected: string[] = [];
  output.on("data", (chunk: Buffer | string) => collected.push(String(chunk)));
  const bridge = new McpToolBridge({ applicationPort: createPort() });
  const session = runMcpStdioSession({
    input,
    output,
    bridge,
    principal: openBridgeSession(bridge),
  });
  const params = protocolVersion === undefined ? {} : { protocolVersion };
  input.write(
    JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params }) + "\n",
  );
  input.end();
  await session;
  const messages = collected
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return (messages[0]?.["result"] ?? {}) as Record<string, unknown>;
}

describe("BRIDGE-01-04：MCP 协议版本必须与真实客户端协商", () => {
  it("① pi 的 LATEST（2025-11-25）⇒ 必须回该版本且声明支持（修复前回 2026-07-28 ⇒ 客户端拒连）", async () => {
    const result = await initializeWith("2025-11-25");
    expect(result["protocolVersion"]).toBe("2025-11-25");
    // 不得自相矛盾：回了它请求的版本，就必须说支持
    expect(result["isRequestedVersionSupported"]).toBe(true);
  });

  it("② 覆盖 pi 与 opencode 支持集内的每个版本 ⇒ 逐个都必须回同一版本", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const result = await initializeWith(version);
      expect(result["protocolVersion"], `请求 ${version}`).toBe(version);
      expect(result["isRequestedVersionSupported"], `请求 ${version}`).toBe(true);
    }
  });

  it("③ 请求本仓首选版本 ⇒ 仍须回该版本（既有行为不得回退）", async () => {
    const result = await initializeWith(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(result["protocolVersion"]).toBe(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(result["isRequestedVersionSupported"]).toBe(true);
  });

  it("④ 完全不兼容的版本 ⇒ 回首选版本并**如实**报 false（不得假称支持）", async () => {
    const result = await initializeWith("1999-01-01");
    expect(result["protocolVersion"]).toBe(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(result["isRequestedVersionSupported"]).toBe(false);
  });

  it("⑤ 未提供 protocolVersion ⇒ 回首选版本且视为可接受", async () => {
    const result = await initializeWith(undefined);
    expect(result["protocolVersion"]).toBe(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(result["isRequestedVersionSupported"]).toBe(true);
  });

  it("⑥ 兼容集必须包含两个真实客户端支持的全部版本（防止日后被误删）", () => {
    for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      expect(MCP_COMPATIBLE_PROTOCOL_VERSIONS, version).toContain(version);
    }
    // 首选版本也必须在集内（否则④会回一个自己都不认的版本）
    expect(MCP_COMPATIBLE_PROTOCOL_VERSIONS).toContain(MCP_SUPPORTED_PROTOCOL_VERSION);
  });
});
