import { describe, expect, it } from "vitest";

import type { AgentRuntime, TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { ToolFailureCounter } from "../../../packages/core/src/orchestration/failure-counter.js";
import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

function makeTask(): TaskDependencyNode {
  return {
    id: "T-001",
    description: "测试任务",
    dependsOn: [],
    taskType: "data",
    toolNames: ["readFile"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

function makeTransport() {
  const statuses: string[] = [];
  return {
    statuses,
    transport: {
      enqueue: async () => {},
      queryHealth: async () => ({
        isHealthy: true,
        processPid: 0,
        protocolVersion: 1,
        queuedMessageCount: 0,
      }),
      shutdown: async () => {},
      setAgentStatus: (_recipientId: string, status: string) => {
        statuses.push(status);
      },
      onMessage: () => {},
    } as never,
  };
}

describe("WorkerAgent", () => {
  it("成功任务上报 success 并回到 idle", async () => {
    const { statuses, transport } = makeTransport();
    const worker = new WorkerAgent({
      agentInstanceId: "worker-1",
      missionId: "mission-1",
      task: makeTask(),
      runtime: new ScriptedRuntime([
        { type: "text", text: "完成结果" },
        { type: "finish", reason: "success", detail: "完成" },
      ]) as unknown as AgentRuntime,
      toolPort: {
        execute: async () => ({
          kind: "success",
          callId: "c1",
          outputText: "ok",
          isSideEffectFree: true,
        }),
      } as never,
      failureCounter: new ToolFailureCounter(),
      feedbackTransport: transport,
      maxLoopIterations: 5,
      buildPermissionExplanation: () => "说明",
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("success");
    expect(statuses).toEqual(["busy", "idle"]);
  });

  it("取消信号使 Worker 以 cancelled 结束", async () => {
    const { statuses, transport } = makeTransport();
    const worker = new WorkerAgent({
      agentInstanceId: "worker-2",
      missionId: "mission-2",
      task: makeTask(),
      runtime: new ScriptedRuntime([
        { type: "text", text: "不执行" },
        { type: "finish", reason: "success", detail: "完成" },
      ]) as unknown as AgentRuntime,
      toolPort: {
        execute: async () => ({
          kind: "success",
          callId: "c1",
          outputText: "ok",
          isSideEffectFree: true,
        }),
      } as never,
      failureCounter: new ToolFailureCounter(),
      feedbackTransport: transport,
      maxLoopIterations: 5,
      buildPermissionExplanation: () => "说明",
    });
    worker.cancel();
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("cancelled");
    expect(statuses).toEqual(["busy", "idle"]);
  });

  it("模糊任务上报 ambiguous 并回到 idle", async () => {
    const { statuses, transport } = makeTransport();
    const worker = new WorkerAgent({
      agentInstanceId: "worker-3",
      missionId: "mission-3",
      task: makeTask(),
      runtime: new ScriptedRuntime([
        { type: "finish", reason: "ambiguous", detail: "统计口径未指定" },
      ]) as unknown as AgentRuntime,
      toolPort: {
        execute: async () => ({
          kind: "error",
          callId: "c1",
          errorCode: "unknown",
          errorMessage: "x",
          isIdempotencyConfirmed: false,
        }),
      } as never,
      failureCounter: new ToolFailureCounter(),
      feedbackTransport: transport,
      maxLoopIterations: 5,
      buildPermissionExplanation: () => "说明",
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("ambiguous");
    expect(statuses).toEqual(["busy", "idle"]);
  });
});
