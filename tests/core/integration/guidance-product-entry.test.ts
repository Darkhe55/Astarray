/**
 * GUIDE-01-04：公共门面提交运行中指导 → 安全点应用 → 行为实际改变与延迟记录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type {
  AgentRunInput,
  AgentRuntime,
} from "../../../packages/core/src/core/types.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guide-entry-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待条件超时");
}

describe("GUIDE-01-04 公共门面提交指导并在安全点应用", () => {
  it("任务运行中途提交指导 → 下一次模型调用前生效并记录延迟", async () => {

    const firstIterationGate: { release: (() => void) | null } = { release: null };
    const isFirstIterationReached = { value: false };

    const recordingRuntime: AgentRuntime = {
      inputs: [],
      async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
        (this.inputs as AgentRunInput[]).push(input);
        const iteration = (this.inputs as AgentRunInput[]).length;
        if (iteration === 1) {
          isFirstIterationReached.value = true;
          await new Promise<void>((resolve) => {
            firstIterationGate.release = resolve;
          });
          yield {
            kind: "toolCallRequested",
            callId: "call-1",
            toolName: "listDirectory",
            argumentsJson: JSON.stringify({ path: "." }),
          };
          yield {
            kind: "runFinished",
            agentId: "worker-1",
            reason: "tool-calls",
            detail: "需要工具",
          };
          return;
        }
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "success",
          detail: "完成",
        };
      },
    } as AgentRuntime & { inputs: AgentRunInput[] };

    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 4,
      useFeedbackProcess: false,
      streamOutput: () => {},
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      workerRuntimeFactory: () => recordingRuntime,
    });
    const facade = new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: 20,
      stateDirectory,
    });
    facade.createSession({ sessionId: "session-1", mode: "assist" });
    const mainAgentProjectionBefore =
      runtime.controller.getMainAgentToolProjection();

    const submitted = await facade.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "列出目录",
    });
    const missionIdentifier = submitted.missionIdentifier ?? "";
    expect(missionIdentifier).not.toBe("");

    await waitFor(async () => isFirstIterationReached.value);
    // 从权威任务链取得目标 task 标识（指导作用域必须精确匹配）。
    const missionStatus = (await runtime.controller.queryMissionStatus(
      missionIdentifier,
    )) as { taskChain?: { tasks: Array<{ id: string }> } };
    const taskIdentifier = missionStatus.taskChain?.tasks[0]?.id ?? "";
    expect(taskIdentifier).not.toBe("");

    const guidanceResult = await facade.submitRuntimeGuidance({
      missionIdentifier,
      taskIdentifier,
      instructionText: "改为只读校验，不再写入",
    });
    expect(guidanceResult.status).toBe("accepted");
    expect(guidanceResult.behaviorTier).toBe("safe-point-guidance");
    firstIterationGate.release?.();

    await waitFor(async () => {
      const status = await facade.queryTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
      });
      return ["done", "failed", "blocked", "cancelled"].includes(status.status);
    });

    const inputs = (recordingRuntime as unknown as { inputs: AgentRunInput[] }).inputs;
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(inputs[1]?.toolResultMessages ?? [])).toContain(
      "运行中指导",
    );
    expect(JSON.stringify(inputs[1]?.toolResultMessages ?? [])).toContain(
      "改为只读校验，不再写入",
    );

    const statusEntries = await facade.queryGuidanceStatus({
      guidanceIdentifier: guidanceResult.guidanceIdentifier,
    });
    expect(statusEntries).toHaveLength(1);
    expect(statusEntries[0]).toMatchObject({
      status: "applied",
      missionIdentifier,
      taskIdentifier,
    });
    expect(statusEntries[0]?.appliedAtIso).not.toBeNull();
    expect(statusEntries[0]?.latencyMilliseconds).toBeGreaterThanOrEqual(0);

    // 主 Agent 仍只读：指导不改变主 Agent 的工具投影。
    expect(runtime.controller.getMainAgentToolProjection()).toEqual(
      mainAgentProjectionBefore,
    );

    // 跨进程可见：应用结果已回写状态日志，新进程可读到 applied 与延迟。
    await facade.shutdown();
    const secondRuntime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 1,
      useFeedbackProcess: false,
      streamOutput: () => {},
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
    });
    const secondFacade = new AstarrayApplicationFacade(secondRuntime, {
      statusPollIntervalMilliseconds: 20,
      stateDirectory,
    });
    secondFacade.createSession({ sessionId: "session-2", mode: "assist" });
    try {
      const persisted = await secondFacade.queryGuidanceStatus({
        guidanceIdentifier: guidanceResult.guidanceIdentifier,
      });
      expect(persisted[0]).toMatchObject({
        status: "applied",
        isApplicationStatusKnown: true,
      });
      expect(persisted[0]?.latencyMilliseconds).toBeGreaterThanOrEqual(0);
    } finally {
      await secondFacade.shutdown();
    }
  }, 60_000);

  it("作用域不符/空文本的提交被拒绝且不进入队列", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 1,
      useFeedbackProcess: false,
      streamOutput: () => {},
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
    });
    const facade = new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: 20,
      stateDirectory,
    });
    facade.createSession({ sessionId: "session-1", mode: "assist" });
    try {
      await expect(
        facade.submitRuntimeGuidance({
          missionIdentifier: "mission-not-running",
          taskIdentifier: "task-x",
          instructionText: "   ",
        }),
      ).rejects.toThrow();
      const result = await facade.submitRuntimeGuidance({
        missionIdentifier: "mission-not-running",
        taskIdentifier: "task-x",
        instructionText: "对不存在的任务下指导",
      });
      // 受理（排队）但不会应用：没有运行中的任务消费它。
      expect(result.status).toBe("accepted");
      const entries = await facade.queryGuidanceStatus({
        guidanceIdentifier: result.guidanceIdentifier,
      });
      expect(entries[0]?.status).toBe("queued");
      expect(entries[0]?.latencyMilliseconds).toBeNull();
    } finally {
      await facade.shutdown();
    }
  }, 60_000);
});
