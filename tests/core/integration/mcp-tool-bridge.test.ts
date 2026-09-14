/**
 * BRIDGE-01-02/03 测试：MCP 最小工具映射 + 边界与断连。
 * -02：受理回执不误报完成；外部 Agent 不能冒充用户优先级 0；user 前缀/schema 不构成认证。
 * -03：跨主体访问拒绝；重放不重复任务；输出注入/秘密回显/取消后续写反例；会话隔离与关闭；
 *      逐次权限复检；协议层不直接执行底层写工具。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES,
  McpToolBridge,
  type McpBridgeApplicationPort,
  type McpBridgePrincipal,
  type McpToolBridgeOptions,
} from "../../../packages/core/src/bridge/mcp-tool-bridge.js";

let submissions: Array<{ taskIdentifier: string; prompt: string }>;
let taskStatuses: Map<string, { status: string; summaryPreview: string | null }>;
let cancelledTaskIdentifiers: string[];

function createPort(): McpBridgeApplicationPort {
  return {
    submitTask: async (input) => {
      submissions.push({ taskIdentifier: input.taskIdentifier, prompt: input.prompt });
      taskStatuses.set(input.taskIdentifier, { status: "accepted", summaryPreview: null });
      return { missionIdentifier: `mission-for-${input.taskIdentifier}` };
    },
    queryTask: async (input) =>
      taskStatuses.get(input.taskIdentifier) ?? { status: "failed", summaryPreview: null },
    cancelTask: async (input) => {
      cancelledTaskIdentifiers.push(input.taskIdentifier);
      taskStatuses.set(input.taskIdentifier, { status: "cancelled", summaryPreview: "已取消" });
    },
  };
}

interface Harness {
  bridge: McpToolBridge;
  sessionA: { sessionIdentifier: string; principal: McpBridgePrincipal };
  principalA: McpBridgePrincipal;
  principalB: McpBridgePrincipal;
}

function createHarness(options: Partial<McpToolBridgeOptions> = {}): Harness {
  const bridge = new McpToolBridge({ applicationPort: createPort(), ...options });
  const sessionA = bridge.openSession({
    authenticatedPrincipalIdentifier: "external-harness:client-a",
    sessionId: "mcp-session",
  });
  const sessionB = bridge.openSession({
    authenticatedPrincipalIdentifier: "user:admin-looking-prefix",
    sessionId: "mcp-session",
  });
  return {
    bridge,
    sessionA,
    principalA: sessionA.principal,
    principalB: sessionB.principal,
  };
}

function submit(
  bridge: McpToolBridge,
  principal: McpBridgePrincipal,
  prompt: string,
  idempotencyKey: string,
) {
  return bridge.callTool({
    toolName: "submit_task",
    arguments: { prompt, idempotencyKey },
    principal,
  });
}

function call(
  bridge: McpToolBridge,
  principal: McpBridgePrincipal,
  toolName: string,
  args: Record<string, unknown>,
) {
  return bridge.callTool({ toolName, arguments: args, principal });
}

beforeEach(() => {
  submissions = [];
  taskStatuses = new Map();
  cancelledTaskIdentifiers = [];
});

describe("BRIDGE-01-02 受理回执、幂等与注入防护", () => {
  it("受理回执永不误报完成（底层已完成仍是 accepted/false），完成状态经 query 读取", async () => {
    const { bridge, principalA } = createHarness();
    const accepted = await submit(bridge, principalA, "生成报告", "key-1");
    expect(accepted.structuredContent["status"]).toBe("accepted");
    expect(accepted.structuredContent["isCompleted"]).toBe(false);
    const taskIdentifier = String(accepted.structuredContent["taskIdentifier"]);
    taskStatuses.set(taskIdentifier, { status: "done", summaryPreview: "已完成" });
    const queried = await call(bridge, principalA, "query_task", { taskIdentifier });
    expect(queried.structuredContent["status"]).toBe("done");
    expect(queried.structuredContent["isCompleted"]).toBe(true);
    expect(accepted.structuredContent["status"]).toBe("accepted");
  });

  it("同一幂等键重复提交返回同一任务且只提交一次", async () => {
    const { bridge, principalA } = createHarness();
    const first = await submit(bridge, principalA, "任务", "same-key");
    const second = await submit(bridge, principalA, "任务", "same-key");
    expect(submissions).toHaveLength(1);
    expect(second.structuredContent["taskIdentifier"]).toBe(
      first.structuredContent["taskIdentifier"],
    );
    expect(second.structuredContent["isIdempotentReplay"]).toBe(true);
  });

  it("参数携带身份字段（含 user 前缀）一律拒绝", async () => {
    const { bridge, principalA } = createHarness();
    for (const args of [
      { prompt: "x", idempotencyKey: "k", sourceKind: "user" },
      { prompt: "x", idempotencyKey: "k", authenticatedPrincipal: "user:admin" },
      { prompt: "x", idempotencyKey: "k", agentInstanceId: "forged" },
      { prompt: "x", idempotencyKey: "k", sessionIdentifier: "forged" },
    ]) {
      expect((await call(bridge, principalA, "submit_task", args)).errorCode).toBe(
        "bridge-identity-injection-rejected",
      );
    }
    expect(submissions).toHaveLength(0);
  });

  it("参数携带优先级字段一律拒绝（不得进入用户层级 0）", async () => {
    const { bridge, principalA } = createHarness();
    for (const args of [
      { prompt: "x", idempotencyKey: "k", priorityTier: 0 },
      { prompt: "x", idempotencyKey: "k", isUserTask: true },
    ]) {
      expect((await call(bridge, principalA, "submit_task", args)).errorCode).toBe(
        "bridge-priority-injection-rejected",
      );
    }
    expect(submissions).toHaveLength(0);
  });

  it("来源恒为 agent，主体前缀不构成用户权限", async () => {
    const { bridge, principalB } = createHarness();
    const outcome = await submit(bridge, principalB, "x", "k");
    const provenance = outcome.structuredContent["provenance"] as Record<string, unknown>;
    expect(provenance.sourceKind).toBe("agent");
    expect(provenance.actorId).toBe("user:admin-looking-prefix");
  });
});

describe("BRIDGE-01-03 会话隔离、重连重放与关闭", () => {
  it("同一主体重连后重放同一幂等键不重复任务，且可读取自己的任务", async () => {
    const { bridge, sessionA, principalA } = createHarness();
    const first = await submit(bridge, principalA, "任务", "reconnect-key");
    const taskIdentifier = String(first.structuredContent["taskIdentifier"]);
    bridge.closeSession(sessionA.sessionIdentifier);
    const reconnected = bridge.openSession({
      authenticatedPrincipalIdentifier: "external-harness:client-a",
      sessionId: "mcp-session",
    });
    const replay = await submit(bridge, reconnected.principal, "任务", "reconnect-key");
    expect(submissions).toHaveLength(1);
    expect(replay.structuredContent["taskIdentifier"]).toBe(taskIdentifier);
    expect(
      (await call(bridge, reconnected.principal, "query_task", { taskIdentifier })).isError,
    ).toBe(false);
  });

  it("跨主体访问任务一律拒绝（不区分不存在/不属于）", async () => {
    const { bridge, principalA, principalB } = createHarness();
    const submitted = await submit(bridge, principalA, "任务", "cross-key");
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);
    for (const toolName of ["query_task", "read_result", "cancel_task"]) {
      expect((await call(bridge, principalB, toolName, { taskIdentifier })).errorCode).toBe(
        "task-not-accessible",
      );
    }
    expect(cancelledTaskIdentifiers).toHaveLength(0);
  });

  it("会话关闭或未打开一律 bridge-session-closed", async () => {
    const { bridge, sessionA, principalA } = createHarness();
    expect(bridge.isSessionOpen(sessionA.sessionIdentifier)).toBe(true);
    bridge.closeSession(sessionA.sessionIdentifier);
    expect(bridge.isSessionOpen(sessionA.sessionIdentifier)).toBe(false);
    expect((await submit(bridge, principalA, "x", "closed-key")).errorCode).toBe(
      "bridge-session-closed",
    );
    const forged = { ...principalA, sessionIdentifier: "not-opened" };
    expect((await submit(bridge, forged, "x", "forged-key")).errorCode).toBe(
      "bridge-session-closed",
    );
  });
});

describe("BRIDGE-01-03 逐次权限、脱敏与写工具隔离", () => {
  it("逐次权限复检：拒绝时不调用应用服务，且每次调用都复检", async () => {
    let recheckCount = 0;
    const { bridge, principalA } = createHarness({
      permissionRecheckPort: {
        recheckToolPermission: async () => {
          recheckCount += 1;
          return { isAllowed: false, deniedReason: "测试策略拒绝" };
        },
      },
    });
    expect((await submit(bridge, principalA, "x", "perm-1")).errorCode).toBe(
      "bridge-permission-denied",
    );
    await submit(bridge, principalA, "x", "perm-2");
    expect(recheckCount).toBe(2);
    expect(submissions).toHaveLength(0);
  });

  it("结果与错误消息均脱敏（秘密不回显）", async () => {
    const { bridge, principalA } = createHarness();
    const submitted = await submit(bridge, principalA, "任务", "secret-key");
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);
    taskStatuses.set(taskIdentifier, {
      status: "done",
      summaryPreview: "含 sk-abcdefgh12345678 与 api_key=topsecret",
    });
    const result = await call(bridge, principalA, "read_result", { taskIdentifier });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-abcdefgh12345678");
    expect(serialized).not.toContain("topsecret");
    const injected = await call(bridge, principalA, "submit_task", {
      prompt: "x",
      idempotencyKey: "k",
      sourceKind: "sk-abcdefgh12345678",
    });
    expect(JSON.stringify(injected.structuredContent)).not.toContain(
      "sk-abcdefgh12345678",
    );
  });

  it("协议层拒绝本地写/执行工具，且工具面不含它们", async () => {
    const { bridge, principalA } = createHarness();
    for (const toolName of MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES) {
      expect(
        (await call(bridge, principalA, toolName, { filePath: "x", content: "y" }))
          .errorCode,
      ).toBe("bridge-local-write-tool-rejected");
    }
    const exposed = bridge.listTools().map((tool) => tool.name);
    for (const forbidden of MCP_BRIDGE_FORBIDDEN_LOCAL_TOOL_NAMES) {
      expect(exposed).not.toContain(forbidden);
    }
  });

  it("取消后不返回结果（取消后续写反例），状态为权威 cancelled", async () => {
    const { bridge, principalA } = createHarness();
    const submitted = await submit(bridge, principalA, "任务", "cancel-key");
    const taskIdentifier = String(submitted.structuredContent["taskIdentifier"]);
    const cancelled = await call(bridge, principalA, "cancel_task", { taskIdentifier });
    expect(cancelled.structuredContent["status"]).toBe("cancelled");
    expect(cancelled.structuredContent["result"]).toBeNull();
    expect(cancelledTaskIdentifiers).toEqual([taskIdentifier]);
    const afterCancel = await call(bridge, principalA, "read_result", { taskIdentifier });
    expect(afterCancel.structuredContent["isCompleted"]).toBe(true);
    expect(afterCancel.structuredContent["status"]).toBe("cancelled");
  });
});

describe("BRIDGE-01-02 参数校验与回执淘汰", () => {
  it("参数缺失或非法返回 invalid-arguments（不调用应用服务）", async () => {
    const { bridge, principalA } = createHarness();
    for (const args of [
      { prompt: 123, idempotencyKey: "k" },
      { prompt: "", idempotencyKey: "k" },
      { prompt: "x" },
      { prompt: "x", idempotencyKey: "k".repeat(201) },
      { prompt: "x", idempotencyKey: 42 },
    ]) {
      expect((await call(bridge, principalA, "submit_task", args)).errorCode).toBe(
        "invalid-arguments",
      );
    }
    expect(submissions).toHaveLength(0);
  });

  it("查询/读取/取消缺少合法 taskIdentifier 返回 invalid-arguments", async () => {
    const { bridge, principalA } = createHarness();
    for (const toolName of ["query_task", "read_result", "cancel_task"]) {
      expect((await call(bridge, principalA, toolName, { taskIdentifier: "" })).errorCode).toBe(
        "invalid-arguments",
      );
      expect((await call(bridge, principalA, toolName, { taskIdentifier: 7 })).errorCode).toBe(
        "invalid-arguments",
      );
    }
  });

  it("回执超上限淘汰最旧条目；listTools 暴露四个工具", async () => {
    const bridge = new McpToolBridge({
      applicationPort: createPort(),
      maximumTrackedReceipts: 1,
    });
    const session = bridge.openSession({
      authenticatedPrincipalIdentifier: "external-harness:client-a",
      sessionId: "mcp-session",
    });
    const first = await submit(bridge, session.principal, "a", "evict-1");
    const second = await submit(bridge, session.principal, "b", "evict-2");
    expect(
      (
        await call(bridge, session.principal, "query_task", {
          taskIdentifier: String(first.structuredContent["taskIdentifier"]),
        })
      ).errorCode,
    ).toBe("task-not-accessible");
    expect(
      (
        await call(bridge, session.principal, "query_task", {
          taskIdentifier: String(second.structuredContent["taskIdentifier"]),
        })
      ).isError,
    ).toBe(false);
    expect(bridge.listTools()).toHaveLength(4);
  });
});
