/**
 * BRIDGE-01-02 测试：MCP 最小工具映射与本地强制规则。
 * 验收：受理回执不误报完成；外部 Agent 不能冒充用户优先级 0；
 * 字符串 user 前缀或 schema 通过不构成认证。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  McpToolBridge,
  type McpBridgeApplicationPort,
  type McpBridgePrincipal,
} from "../../../packages/core/src/bridge/mcp-tool-bridge.js";

interface RecordedSubmission {
  sessionId: string;
  taskIdentifier: string;
  prompt: string;
}

let submissions: RecordedSubmission[];
let taskStatuses: Map<string, { status: string; summaryPreview: string | null }>;
let cancelledTaskIdentifiers: string[];

function createPort(): McpBridgeApplicationPort {
  return {
    submitTask: async (input) => {
      submissions.push(input);
      taskStatuses.set(input.taskIdentifier, {
        status: "accepted",
        summaryPreview: null,
      });
      return { missionIdentifier: `mission-for-${input.taskIdentifier}` };
    },
    queryTask: async (input) =>
      taskStatuses.get(input.taskIdentifier) ?? {
        status: "failed",
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

const principalA: McpBridgePrincipal = {
  authenticatedPrincipalIdentifier: "external-harness:client-a",
  sourceKind: "agent",
  agentInstanceId: "mcp-client-a",
  sessionId: "mcp-session",
};

const principalB: McpBridgePrincipal = {
  authenticatedPrincipalIdentifier: "user:admin-looking-prefix",
  sourceKind: "agent",
  agentInstanceId: "mcp-client-b",
  sessionId: "mcp-session",
};

beforeEach(() => {
  submissions = [];
  taskStatuses = new Map();
  cancelledTaskIdentifiers = [];
});

describe("BRIDGE-01-02 受理回执与幂等", () => {
  it("受理回执永不误报完成（底层任务已完成时仍返回 accepted/isCompleted=false）", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const outcome = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "生成报告", idempotencyKey: "key-1" },
      principal: principalA,
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent["status"]).toBe("accepted");
    expect(outcome.structuredContent["isCompleted"]).toBe(false);

    // 底层任务随后完成：受理回执不变，完成状态只能经 query/read-result 获取
    const taskIdentifier = String(outcome.structuredContent["taskIdentifier"]);
    taskStatuses.set(taskIdentifier, { status: "done", summaryPreview: "已完成" });
    expect(outcome.structuredContent["status"]).toBe("accepted");
    const queried = await bridge.callTool({
      toolName: "query_task",
      arguments: { taskIdentifier },
      principal: principalA,
    });
    expect(queried.isError).toBe(false);
    expect(queried.structuredContent["status"]).toBe("done");
    expect(queried.structuredContent["isCompleted"]).toBe(true);
  });

  it("同一幂等键重复提交返回同一任务且不重复提交", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const first = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "任务", idempotencyKey: "same-key" },
      principal: principalA,
    });
    const second = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "任务", idempotencyKey: "same-key" },
      principal: principalA,
    });
    expect(submissions).toHaveLength(1);
    expect(second.structuredContent["taskIdentifier"]).toBe(
      first.structuredContent["taskIdentifier"],
    );
    expect(second.structuredContent["isIdempotentReplay"]).toBe(true);
  });
});

describe("BRIDGE-01-02 身份与优先级不可由参数伪造", () => {
  it("参数携带身份字段（含 user 前缀）一律拒绝", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    for (const argumentsList of [
      { prompt: "x", idempotencyKey: "k", sourceKind: "user" },
      { prompt: "x", idempotencyKey: "k", authenticatedPrincipal: "user:admin" },
      { prompt: "x", idempotencyKey: "k", agentInstanceId: "forged" },
    ]) {
      const outcome = await bridge.callTool({
        toolName: "submit_task",
        arguments: argumentsList,
        principal: principalA,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.errorCode).toBe("bridge-identity-injection-rejected");
    }
    expect(submissions).toHaveLength(0);
  });

  it("参数携带优先级字段（层级 0）一律拒绝，不得进入用户层级", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    for (const argumentsList of [
      { prompt: "x", idempotencyKey: "k", priorityTier: 0 },
      { prompt: "x", idempotencyKey: "k", isUserTask: true },
    ]) {
      const outcome = await bridge.callTool({
        toolName: "submit_task",
        arguments: argumentsList,
        principal: principalA,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.errorCode).toBe("bridge-priority-injection-rejected");
    }
    expect(submissions).toHaveLength(0);
  });

  it("来源恒为 agent，不因主体标识前缀而获得用户权限", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const outcome = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "x", idempotencyKey: "k" },
      principal: principalB,
    });
    const provenance = outcome.structuredContent["provenance"] as Record<
      string,
      unknown
    >;
    expect(provenance.sourceKind).toBe("agent");
    expect(provenance.actorId).toBe("user:admin-looking-prefix");
  });
});

describe("BRIDGE-01-02 结果读取与跨主体访问", () => {
  it("未完成不返回结果；完成后返回本地权威摘要", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const submitted = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "任务", idempotencyKey: "read-key" },
      principal: principalA,
    });
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);

    const beforeCompletion = await bridge.callTool({
      toolName: "read_result",
      arguments: { taskIdentifier },
      principal: principalA,
    });
    expect(beforeCompletion.structuredContent["isCompleted"]).toBe(false);
    expect(beforeCompletion.structuredContent["result"]).toBeNull();

    taskStatuses.set(taskIdentifier, { status: "done", summaryPreview: "产物摘要" });
    const afterCompletion = await bridge.callTool({
      toolName: "read_result",
      arguments: { taskIdentifier },
      principal: principalA,
    });
    expect(afterCompletion.structuredContent["isCompleted"]).toBe(true);
    expect(afterCompletion.structuredContent["result"]).toBe("产物摘要");
  });

  it("跨主体访问任务一律拒绝（不做存在性探测）", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const submitted = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "任务", idempotencyKey: "cross-key" },
      principal: principalA,
    });
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);
    for (const toolName of ["query_task", "read_result", "cancel_task"] as const) {
      const outcome = await bridge.callTool({
        toolName,
        arguments: { taskIdentifier },
        principal: principalB,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.errorCode).toBe("task-not-accessible");
    }
    expect(cancelledTaskIdentifiers).toHaveLength(0);
  });

  it("取消任务返回本地权威状态", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const submitted = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "任务", idempotencyKey: "cancel-key" },
      principal: principalA,
    });
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);
    const cancelled = await bridge.callTool({
      toolName: "cancel_task",
      arguments: { taskIdentifier },
      principal: principalA,
    });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.structuredContent["status"]).toBe("cancelled");
    expect(cancelledTaskIdentifiers).toEqual([taskIdentifier]);
  });

  it("未知工具返回稳定错误码", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const outcome = await bridge.callTool({
      toolName: "delete_everything",
      arguments: {},
      principal: principalA,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.errorCode).toBe("unknown-tool");
  });
});
describe("BRIDGE-01-02 参数校验与回执淘汰", () => {
  it("参数缺失或非法返回 invalid-arguments（不调用应用服务）", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const invalidArgumentCases = [
      { prompt: 123, idempotencyKey: "k" },
      { prompt: "", idempotencyKey: "k" },
      { prompt: "x" },
      { prompt: "x", idempotencyKey: "k".repeat(201) },
      { prompt: "x", idempotencyKey: 42 },
    ];
    for (const argumentsList of invalidArgumentCases) {
      const outcome = await bridge.callTool({
        toolName: "submit_task",
        arguments: argumentsList as Record<string, unknown>,
        principal: principalA,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.errorCode).toBe("invalid-arguments");
    }
    expect(submissions).toHaveLength(0);
  });

  it("查询/读取/取消缺少合法 taskIdentifier 返回 invalid-arguments", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    for (const toolName of ["query_task", "read_result", "cancel_task"] as const) {
      const outcome = await bridge.callTool({
        toolName,
        arguments: { taskIdentifier: "" },
        principal: principalA,
      });
      expect(outcome.errorCode).toBe("invalid-arguments");
      const wrongType = await bridge.callTool({
        toolName,
        arguments: { taskIdentifier: 7 },
        principal: principalA,
      });
      expect(wrongType.errorCode).toBe("invalid-arguments");
    }
  });

  it("回执超过上限后淘汰最旧条目（最旧任务不再可访问）", async () => {
    const bridge = new McpToolBridge({
      applicationPort: createPort(),
      maximumTrackedReceipts: 1,
    });
    const first = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "a", idempotencyKey: "evict-1" },
      principal: principalA,
    });
    const second = await bridge.callTool({
      toolName: "submit_task",
      arguments: { prompt: "b", idempotencyKey: "evict-2" },
      principal: principalA,
    });
    const evicted = await bridge.callTool({
      toolName: "query_task",
      arguments: {
        taskIdentifier: String(first.structuredContent["taskIdentifier"]),
      },
      principal: principalA,
    });
    expect(evicted.errorCode).toBe("task-not-accessible");
    const kept = await bridge.callTool({
      toolName: "query_task",
      arguments: {
        taskIdentifier: String(second.structuredContent["taskIdentifier"]),
      },
      principal: principalA,
    });
    expect(kept.isError).toBe(false);
  });

  it("listTools 暴露四个工具及其必填参数", async () => {
    const bridge = new McpToolBridge({ applicationPort: createPort() });
    const tools = bridge.listTools();
    expect(tools).toHaveLength(4);
    expect(tools.find((tool) => tool.name === "submit_task")?.inputSchema.required).toEqual([
      "prompt",
      "idempotencyKey",
    ]);
  });
});
