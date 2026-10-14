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
  /** COMM-01-02：捕获入队消息，用于断言**反馈去向**。 */
  const enqueuedRecipientIds: string[] = [];
  return {
    statuses,
    enqueuedRecipientIds,
    transport: {
      enqueue: async (message: { recipientId: string }) => {
        enqueuedRecipientIds.push(message.recipientId);
      },
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

  it("COMM-01-02：任务记录了发布者 ⇒ 反馈**投给发布者**而非默认 scheduler", async () => {
    /**
     * 用户澄清："每条任务的反馈路径**默认走任务发布者的反向通道**"。
     * 修复前 `reportOutcome()` 硬编码 `scheduler:<missionId>` ⇒ 本用例会红。
     */
    const { transport, enqueuedRecipientIds } = makeTransport();
    const worker = new WorkerAgent({
      agentInstanceId: "worker-1",
      missionId: "mission-1",
      task: { ...makeTask(), publishedByRecipientId: "main:mission-7" },
      runtime: new ScriptedRuntime([
        { type: "text", text: "完成结果" },
        { type: "finish", reason: "success", detail: "完成" },
      ]) as unknown as AgentRuntime,
      toolPort: {
        execute: async () => ({
          kind: "success",
          callId: "c1",
          outputText: "ok",
        }),
      } as never,
      failureCounter: new ToolFailureCounter(),
      feedbackTransport: transport,
      maxLoopIterations: 5,
      buildPermissionExplanation: () => "说明",
    });

    await worker.run();

    expect(enqueuedRecipientIds).toEqual(["main:mission-7"]);
    expect(enqueuedRecipientIds).not.toContain("scheduler:mission-1");
  });

  it("COMM-01-02：任务**未记录**发布者 ⇒ 回退默认 scheduler（旧路径不变）", async () => {
    const { transport, enqueuedRecipientIds } = makeTransport();
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
        }),
      } as never,
      failureCounter: new ToolFailureCounter(),
      feedbackTransport: transport,
      maxLoopIterations: 5,
      buildPermissionExplanation: () => "说明",
    });

    await worker.run();

    expect(enqueuedRecipientIds).toEqual(["scheduler:mission-1"]);
  });
});
