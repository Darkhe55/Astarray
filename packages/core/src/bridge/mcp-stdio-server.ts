/**
 * MCP stdio 会话（BRIDGE-01-02 / ADR-0032）。
 *
 * 按 ADR-0032 冻结：客户端启动子进程，双端通过 stdin/stdout 交换
 * **换行分隔的 JSON-RPC**；stdout 只允许合法 MCP 消息（日志走 stderr）。
 * 仅实现最小面：initialize / tools/list / tools/call 与
 * notifications/cancelled（stdio 下取消以通知表达）。
 */
import type {
  McpBridgePrincipal,
  McpToolBridge,
} from "./mcp-tool-bridge.js";

/** 冻结的协议修订（ADR-0032）。 */
export const MCP_SUPPORTED_PROTOCOL_VERSION = "2026-07-28";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpStdioSessionOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  bridge: McpToolBridge;
  principal: McpBridgePrincipal;
  serverName?: string;
  serverVersion?: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export async function runMcpStdioSession(
  options: McpStdioSessionOptions,
): Promise<void> {
  const serverName = options.serverName ?? "astarray-mcp-bridge";
  const serverVersion = options.serverVersion ?? "0.1.0";
  /** 已受理请求 id → 该请求创建/涉及的任务标识（用于取消映射）。 */
  const taskIdentifierByRequestId = new Map<string, string>();

  const writeMessage = (message: Record<string, unknown>): void => {
    options.output.write(JSON.stringify(message) + "\n");
  };
  const writeResult = (id: unknown, result: Record<string, unknown>): void => {
    writeMessage({ jsonrpc: "2.0", id: id ?? null, result });
  };
  const writeError = (
    id: unknown,
    code: number,
    message: string,
  ): void => {
    writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  };

  let bufferedText = "";
  const handleLine = async (line: string): Promise<void> => {
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeError(null, JSONRPC_PARSE_ERROR, "无法解析 JSON-RPC 消息");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      writeError(null, JSONRPC_INVALID_REQUEST, "JSON-RPC 消息必须是对象");
      return;
    }
    const method = typeof parsed.method === "string" ? parsed.method : null;
    const identifier = parsed.id;
    const isNotification = identifier === undefined || identifier === null;

    if (method === "notifications/cancelled") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const cancelledRequestId = params["requestId"];
      if (typeof cancelledRequestId === "string") {
        const taskIdentifier = taskIdentifierByRequestId.get(cancelledRequestId);
        if (taskIdentifier !== undefined) {
          // stdio 下取消以通知表达：映射为本地任务取消（取消结果由 query 读取）
          await options.bridge.callTool({
            toolName: "cancel_task",
            arguments: { taskIdentifier },
            principal: options.principal,
          });
          taskIdentifierByRequestId.delete(cancelledRequestId);
        }
      }
      return;
    }
    if (method === "notifications/initialized" || isNotification) {
      // 其他通知不产生响应（规范：通知无 id，不得回应）
      return;
    }
    if (method === "initialize") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const requestedVersion =
        typeof params["protocolVersion"] === "string"
          ? params["protocolVersion"]
          : null;
      writeResult(identifier, {
        protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSION,
        isRequestedVersionSupported:
          requestedVersion === null ||
          requestedVersion === MCP_SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
      });
      return;
    }
    if (method === "tools/list") {
      writeResult(identifier, { tools: options.bridge.listTools() });
      return;
    }
    if (method === "tools/call") {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const toolName = params["name"];
      if (typeof toolName !== "string" || toolName === "") {
        writeError(identifier, JSONRPC_INVALID_PARAMS, "tools/call 需要 name");
        return;
      }
      const toolArguments =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Record<string, unknown>)
          : {};
      try {
        const outcome = await options.bridge.callTool({
          toolName,
          arguments: toolArguments,
          principal: options.principal,
        });
        const createdTaskIdentifier = outcome.structuredContent["taskIdentifier"];
        if (
          !outcome.isError &&
          typeof createdTaskIdentifier === "string" &&
          typeof identifier === "string"
        ) {
          taskIdentifierByRequestId.set(identifier, createdTaskIdentifier);
        }
        writeResult(identifier, {
          content: [{ type: "text", text: outcome.textContent }],
          isError: outcome.isError,
          structuredContent: outcome.structuredContent,
        });
      } catch (error) {
        writeError(
          identifier,
          JSONRPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    writeError(identifier, JSONRPC_METHOD_NOT_FOUND, `未知方法: ${method ?? "null"}`);
  };

  await new Promise<void>((resolve, reject) => {
    let processingChain: Promise<void> = Promise.resolve();
    options.input.on("data", (chunk: Buffer | string) => {
      bufferedText += String(chunk);
      let newlineIndex = bufferedText.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = bufferedText.slice(0, newlineIndex).trim();
        bufferedText = bufferedText.slice(newlineIndex + 1);
        if (line !== "") {
          processingChain = processingChain.then(() => handleLine(line));
        }
        newlineIndex = bufferedText.indexOf("\n");
      }
    });
    options.input.on("error", (error: Error) => reject(error));
    options.input.on("end", () => {
      processingChain.then(() => resolve()).catch(reject);
    });
  });
}
