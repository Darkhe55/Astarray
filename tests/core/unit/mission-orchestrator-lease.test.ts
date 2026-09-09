/**
 * T12-02 编排会话租约测试：跨进程 mission 活动租约与运行会话生命周期。
 * 通过真实 TaskStore/MissionLeaseStore + DevolveScheduler（ScriptedRuntime）验证：
 * 正常完成释放租约；其他进程活动租约时 start() mission-locked 且不调度。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentRuntime,
  FeedbackMessage,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  ToolPort,
  TransportHealth,
} from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import { DevolveScheduler } from "../../../packages/core/src/orchestration/devolve-scheduler.js";

const successFinish = {
  type: "finish",
  reason: "success",
  detail: "完成",
} as const;

class NoopFeedbackTransport implements FeedbackTransportPort {
  onMessage(_handler: (message: FeedbackMessage) => void): void {}
  async enqueue(_message: FeedbackMessage): Promise<void> {}
  async queryHealth(): Promise<TransportHealth> {
    return {
      isHealthy: true,
      processPid: 0,
      protocolVersion: 1,
      queuedMessageCount: 0,
    };
  }
  async shutdown(): Promise<void> {}
  setAgentStatus(_recipientId: string, _status: never): void {}
}

let temporaryDirectory: string;
let taskStore: TaskStore;
let leaseStore: MissionLeaseStore;
let feedbackTransport: NoopFeedbackTransport;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-orch-lease-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  leaseStore = new MissionLeaseStore({ stateDirectory: temporaryDirectory });
  feedbackTransport = new NoopFeedbackTransport();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function makeTask(id: string, dependsOn: string[] = []): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType: "data",
    toolNames: ["readFile"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

async function makeInitialChain(
  missionId: string,
  tasks: TaskDependencyNode[],
): Promise<TaskChainDocument> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId,
    revision: 1,
    updatedAtIso: "2026-08-26T10:00:00.000Z",
    tasks,
  };
  await taskStore.writeTaskChain(chain);
  return chain;
}

interface BuildSchedulerOptions {
  missionId: string;
  tasks: TaskDependencyNode[];
  processInstanceId: string;
  finishedStatuses?: Array<"done" | "cancelled">;
  escalationMessages?: string[];
}

function buildDevolveScheduler(options: BuildSchedulerOptions): DevolveScheduler {
  const workerFactories = {
    runtimeFactory: (): AgentRuntime => new ScriptedRuntime([successFinish] as never),
    toolPortFactory: (_task: TaskDependencyNode): ToolPort => {
      return {
        execute: async () => {
          throw new Error("成功脚本不应触发工具调用");
        },
      } as unknown as ToolPort;
    },
    buildPermissionExplanation: (_toolName: string) => "无需工具",
  };
  const initialChain = {
    schemaVersion: 1,
    missionId: options.missionId,
    revision: 1,
    updatedAtIso: "2026-08-26T10:00:00.000Z",
    tasks: options.tasks,
  } as TaskChainDocument;
  return new DevolveScheduler({
    missionId: options.missionId,
    initialChain,
    taskStore,
    concurrency: 2,
    failureThreshold: 3,
    maxLoopIterations: 5,
    workerFactories,
    feedbackTransportFactory: async () => feedbackTransport,
    onMissionFinished: (status) => options.finishedStatuses?.push(status),
    onUserEscalation: (message) => options.escalationMessages?.push(message),
    missionLeaseStore: leaseStore,
    processInstanceId: options.processInstanceId,
  });
}

describe("MissionOrchestrator 会话租约（T12-02）", () => {
  it("装配租约：mission 正常完成后租约被释放（后续进程可重新取得）", async () => {
    const missionId = "mission-lease-finish";
    const tasks = [makeTask("T-001")];
    await makeInitialChain(missionId, tasks);

    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const scheduler = buildDevolveScheduler({
      missionId,
      tasks,
      processInstanceId: "process-orch-a",
      finishedStatuses,
    });
    await scheduler.start();

    expect(finishedStatuses).toContain("done");
    const summary = await leaseStore.readLeaseSummary(missionId, "process-orch-b");
    expect(summary.exists).toBe(false);
    expect(summary.isActive).toBe(false);
  });

  it("其他进程持活动租约时 start() 拒绝 mission-locked，且不推进任何任务", async () => {
    const missionId = "mission-lease-conflict";
    const tasks = [makeTask("T-001")];
    await makeInitialChain(missionId, tasks);
    const foreignAcquire = await leaseStore.tryAcquire({
      missionId,
      processInstanceId: "process-other",
      purpose: "run",
    });
    expect(foreignAcquire.status).toBe("acquired");

    const scheduler = buildDevolveScheduler({
      missionId,
      tasks,
      processInstanceId: "process-orch-b",
    });
    await expect(scheduler.start()).rejects.toMatchObject({
      errorCode: "mission-locked",
    });

    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks.every((task) => task.status === "pending")).toBe(true);
    const lease = await leaseStore.readLeaseSummary(missionId, "process-orch-b");
    expect(lease.isActive).toBe(true);
    expect(lease.ownerProcessInstanceId).toBe("process-other");
  });

  it("活动租约释放后，同 mission 可由新进程实例正常完成", async () => {
    const missionId = "mission-lease-retry";
    const tasks = [makeTask("T-001")];
    await makeInitialChain(missionId, tasks);
    const foreignAcquire = await leaseStore.tryAcquire({
      missionId,
      processInstanceId: "process-other",
      purpose: "run",
    });
    expect(foreignAcquire.status).toBe("acquired");
    if (foreignAcquire.status !== "acquired") {
      return;
    }
    expect(
      await leaseStore.releaseLease(
        missionId,
        foreignAcquire.lease.leaseRevision,
        "process-other",
      ),
    ).toBe(true);

    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const scheduler = buildDevolveScheduler({
      missionId,
      tasks,
      processInstanceId: "process-orch-c",
      finishedStatuses,
    });
    await scheduler.start();
    expect(finishedStatuses).toContain("done");
    const summary = await leaseStore.readLeaseSummary(missionId, "process-other");
    expect(summary.exists).toBe(false);
  });
});
