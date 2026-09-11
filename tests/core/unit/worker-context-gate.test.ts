/**
 * T09A-R1-01：Worker 在必要上下文约束缺失时阻塞，而不是静默执行。
 */
import { describe, expect, it } from "vitest";

import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";

function makeWorker(unsatisfiedConditions: string[]) {
  return new WorkerAgent({
    agentInstanceId: "worker-1",
    missionId: "mission-1",
    task: {
      id: "T-001",
      description: "probe",
      dependsOn: [],
      taskType: "data",
      toolNames: [],
      status: "running",
      assignedAgentId: "worker-1",
      resultLocation: null,
    } as never,
    runtime: {
      run: () => {
        throw new Error("provider 不应被调用");
      },
    } as never,
    toolPort: { execute: async () => ({ kind: "success", callId: "c-1", outputText: "", isSideEffectFree: true }) } as never,
    failureCounter: { recordFailure: () => false, recordSuccess: () => {} } as never,
    feedbackTransport: { setAgentStatus: () => {} } as never,
    maxLoopIterations: 2,
    buildPermissionExplanation: () => "why",
    contextPromptProvider: async () => ({
      promptText: "assembled",
      injectedGlobalDecisionIdentifiers: [],
      injectedFrontierNodeIdentifiers: [],
      excludedClosedNodeCount: 0,
      unsatisfiedNecessaryConditionIdentifiers: unsatisfiedConditions,
    }),
  });
}

describe("T09A-R1-01：Worker 必要条件门禁", () => {
  it("必要条件缺失 → 抛出 context-mandatory-constraint-missing 且不调用 Provider", async () => {
    const worker = makeWorker(["acceptance-criteria"]);
    await expect(worker.run()).rejects.toMatchObject({
      errorCode: "context-mandatory-constraint-missing",
    });
  });

  it("必要条件满足 → 继续调用 Provider（此处 runtime 抛错以便区分路径）", async () => {
    const worker = makeWorker([]);
    await expect(worker.run()).rejects.toThrow("provider 不应被调用");
  });
});
