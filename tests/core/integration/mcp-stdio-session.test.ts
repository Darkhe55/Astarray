/**
 * BRIDGE-01-02 测试：MCP stdio 会话（换行分隔 JSON-RPC）。
 * 验收：工具面可用；stdout 只输出合法 MCP 消息；取消以通知表达；
 * 协议版本按冻结值协商；解析/方法错误有稳定 JSON-RPC 错误码。
 */
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it } from "vitest";

import {
  McpToolBridge,
  type McpBridgeApplicationPort,
  type McpBridgePrincipal,
} from "../../../packages/core/src/bridge/mcp-tool-bridge.js";
import {
  MCP_SUPPORTED_PROTOCOL_VERSION,
  runMcpStdioSession,
} from "../../../packages/core/src/bridge/mcp-stdio-server.js";

let taskStatuses: Map<string, { status: string; summaryPreview: string | null }>;
let cancelledTaskIdentifiers: string[];

function createPort(): McpBridgeApplicationPort {
  return {
    submitTask: async (input) => {
      taskStatuses.set(input.taskIdentifier, {
        status: "accepted",
        summaryPreview: null,
      });
      return { missionIdentifier: "mission-1" };
    },
    queryTask: async (input) =>
      taskStatuses.get(input.taskIdentifier) ?? {
        status: "accepted",
        summaryPreview: null,
      },
    cancelTask: async (input) => {
      cancelledTaskIdentifiers.push(input.taskIdentifier);
      taskStatuses.set(input.taskIdentifier, {
        status: "cancelled",
        summaryPreview: null,
      });
    },
  };
}

const principal: McpBridgePrincipal = {
  authenticatedPrincipalIdentifier: "external-harness:stdio-client",
  sourceKind: "agent",
  agentInstanceId: "mcp-client-stdio-1",
  sessionId: "mcp-session-stdio",
};

beforeEach(() => {
  taskStatuses = new Map();
  cancelledTaskIdentifiers = [];
});

async function runSession(lines: string[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const collected: string[] = [];
  output.on("data", (chunk: Buffer | string) => {
    collected.push(String(chunk));
  });
  const session = runMcpStdioSession({
    input,
    output,
    bridge: new McpToolBridge({ applicationPort: createPort() }),
    principal,
  });
  for (const line of lines) {
    input.write(line + "\n");
  }
  input.end();
  await session;
  const messages = collected
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return messages;
}

function resultOf(message: Record<string, unknown>): Record<string, unknown> {
  return (message["result"] ?? {}) as Record<string, unknown>;
}
function errorOf(message: Record<string, unknown>): Record<string, unknown> {
  return (message["error"] ?? {}) as Record<string, unknown>;
}

describe("BRIDGE-01-02 MCP stdio 会话", () => {
  it("initialize 协商冻结版本；tools/list 暴露四个工具", async () => {
    const messages = await runSession([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: { protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSION },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: "list-1", method: "tools/list" }),
    ]);
    expect(messages).toHaveLength(2);
    const initializeResult = resultOf(messages[0]!);
    expect(initializeResult["protocolVersion"]).toBe(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(initializeResult["isRequestedVersionSupported"]).toBe(true);
    const tools = resultOf(messages[1]!)["tools"] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_task",
      "query_task",
      "read_result",
      "submit_task",
    ]);
  });

  it("tools/call submit_task 返回受理回执；身份注入返回结构化错误", async () => {
    const messages = await runSession([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "submit_task",
          arguments: { prompt: "生成报告", idempotencyKey: "stdio-key" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-2",
        method: "tools/call",
        params: {
          name: "submit_task",
          arguments: { prompt: "x", idempotencyKey: "k", sourceKind: "user" },
        },
      }),
    ]);
    const accepted = resultOf(messages[0]!);
    const acceptedContent = accepted["structuredContent"] as Record<string, unknown>;
    expect(accepted["isError"]).toBe(false);
    expect(acceptedContent["status"]).toBe("accepted");
    expect(acceptedContent["isCompleted"]).toBe(false);

    const rejected = resultOf(messages[1]!);
    expect(rejected["isError"]).toBe(true);
    const rejectedContent = rejected["structuredContent"] as Record<string, unknown>;
    expect(rejectedContent["errorCode"]).toBe("bridge-identity-injection-rejected");
  });

  it("notifications/cancelled 映射为本地任务取消", async () => {
    const messages = await runSession([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-cancel-1",
        method: "tools/call",
        params: {
          name: "submit_task",
          arguments: { prompt: "长任务", idempotencyKey: "cancel-key" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "call-cancel-1", reason: "用户取消" },
      }),
    ]);
    // 通知不产生响应：只有一次 tools/call 结果
    expect(messages).toHaveLength(1);
    expect(cancelledTaskIdentifiers).toHaveLength(1);
  });

  it("解析错误与方法不存在返回稳定 JSON-RPC 错误码", async () => {
    const messages = await runSession([
      "{ not json",
      JSON.stringify({ jsonrpc: "2.0", id: "unknown-1", method: "resources/list" }),
    ]);
    expect(errorOf(messages[0]!)["code"]).toBe(-32700);
    expect(errorOf(messages[1]!)["code"]).toBe(-32601);
  });

  it("stdout 只包含合法 JSON-RPC 消息（无日志混入）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on("data", (chunk: Buffer | string) => {
      collected.push(String(chunk));
    });
    const session = runMcpStdioSession({
      input,
      output,
      bridge: new McpToolBridge({ applicationPort: createPort() }),
      principal,
    });
    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: "list-2", method: "tools/list" }) + "\n",
    );
    input.end();
    await session;
    for (const line of collected.join("").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["jsonrpc"]).toBe("2.0");
    }
  });
});
describe("BRIDGE-01-02 stdio 会话边界", () => {
  it("请求版本不一致时回报支持的版本并标注未支持", async () => {
    const messages = await runSession([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init-old",
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ]);
    expect(messages).toHaveLength(1);
    const initializeResult = resultOf(messages[0]!);
    expect(initializeResult["protocolVersion"]).toBe(MCP_SUPPORTED_PROTOCOL_VERSION);
    expect(initializeResult["isRequestedVersionSupported"]).toBe(false);
  });

  it("缺少 name 或非对象消息返回稳定 JSON-RPC 错误", async () => {
    const messages = await runSession([
      JSON.stringify({ jsonrpc: "2.0", id: "bad-call", method: "tools/call", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: "bad-object", method: "tools/call", params: 5 }),
      "42",
    ]);
    expect(errorOf(messages[0]!)["code"]).toBe(-32602);
    // 非对象 params 同样按缺少 name 处理（-32602），不进入桥接
    expect(errorOf(messages[1]!)["code"]).toBe(-32602);
    expect(errorOf(messages[2]!)["code"]).toBe(-32600);
  });

  it("未知 requestId 的取消通知不产生输出也不取消任何任务", async () => {
    const messages = await runSession([
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "never-seen" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
    ]);
    expect(messages).toHaveLength(0);
    expect(cancelledTaskIdentifiers).toHaveLength(0);
  });

  it("桥接内部异常映射为 -32603", async () => {
    const failingPort: McpBridgeApplicationPort = {
      submitTask: async () => {
        throw new Error("port exploded");
      },
      queryTask: async () => ({ status: "accepted", summaryPreview: null }),
      cancelTask: async () => {},
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on("data", (chunk: Buffer | string) => collected.push(String(chunk)));
    const session = runMcpStdioSession({
      input,
      output,
      bridge: new McpToolBridge({ applicationPort: failingPort }),
      principal,
    });
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "boom-1",
        method: "tools/call",
        params: {
          name: "submit_task",
          arguments: { prompt: "x", idempotencyKey: "boom-key" },
        },
      }) + "\n",
    );
    input.end();
    await session;
    const messages = collected
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(errorOf(messages[0]!)["code"]).toBe(-32603);
  });

  it("单次写入多行时逐条处理", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on("data", (chunk: Buffer | string) => collected.push(String(chunk)));
    const session = runMcpStdioSession({
      input,
      output,
      bridge: new McpToolBridge({ applicationPort: createPort() }),
      principal,
    });
    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: "multi-1", method: "tools/list" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: "multi-2", method: "tools/list" }) +
        "\n",
    );
    input.end();
    await session;
    const messages = collected
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(messages).toHaveLength(2);
  });

  it("输入流错误时会话以拒绝结束", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const session = runMcpStdioSession({
      input,
      output,
      bridge: new McpToolBridge({ applicationPort: createPort() }),
      principal,
    });
    input.emit("error", new Error("stdin broken"));
    await expect(session).rejects.toThrow("stdin broken");
  });
});
