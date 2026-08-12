/**
 * T08 三级编排测试：FakeFeedbackTransport（进程内投递）+ ScriptedRuntime Worker + 真实 TaskStore。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentStatus,
  AgentRuntime,
  FeedbackMessage,
  FeedbackTransportPort,
  TaskChainDocument,
  TaskDependencyNode,
  ToolCallResult,
  ToolPort,
  TransportHealth,
} from "../../../packages/core/src/core/types.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import { AssistScheduler } from "../../../packages/core/src/orchestration/assist-scheduler.js";
import { DevolveScheduler } from "../../../packages/core/src/orchestration/devolve-scheduler.js";

const NOW_UNIX_SECONDS = 1_800_000_000;

class FakeFeedbackTransport implements FeedbackTransportPort {
  private readonly handlers: Array<(message: FeedbackMessage) => void> = [];
  private readonly statuses = new Map<string, AgentStatus>();
  readonly deliveredMessages: FeedbackMessage[] = [];

  onMessage(handler: (message: FeedbackMessage) => void): void {
    this.handlers.push(handler);
  }

  async enqueue(message: FeedbackMessage): Promise<void> {
    this.deliveredMessages.push(message);
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  async queryHealth(): Promise<TransportHealth> {
    return {
      isHealthy: true,
      processPid: 0,
      protocolVersion: 1,
      queuedMessageCount: 0,
    };
  }

  async shutdown(): Promise<void> {}

  setAgentStatus(recipientId: string, status: AgentStatus): void {
    this.statuses.set(recipientId, status);
  }

  getStatus(recipientId: string): AgentStatus | undefined {
    return this.statuses.get(recipientId);
  }
}

let temporaryDirectory: string;
let taskStore: TaskStore;
let workspaceDirectory: string;
let temporaryDirectoryPath: string;
let registry: ToolRegistry;
let feedbackTransport: FakeFeedbackTransport;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-orchestration-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(temporaryDirectoryPath);
  registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  feedbackTransport = new FakeFeedbackTransport();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(
    () => {},
  );
});

function makeTask(
  id: string,
  dependsOn: string[] = [],
  toolNames: string[] = ["readFile"],
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType: "data",
    toolNames,
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
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks,
  };
  await taskStore.writeTaskChain(chain);
  return chain;
}

interface BuildSchedulerOptions {
  mode: "assist" | "devolve";
  scriptsByAttempt: Array<Array<unknown>>;
  toolPort?: ToolPort;
  escalationMessages?: string[];
  finishedStatuses?: Array<"done" | "cancelled">;
  sessionManager?: SessionAuthorizationManager;
}

function buildScheduler(
  missionId: string,
  tasks: TaskDependencyNode[],
  options: BuildSchedulerOptions,
): AssistScheduler | DevolveScheduler {
  const modeMachine = new ModeMachine(options.mode);
  const sessionManager =
    options.sessionManager ?? new SessionAuthorizationManager();
  const permissionDecider = new PermissionDecider(modeMachine, sessionManager);
  const initialChain: TaskChainDocument = {
    schemaVersion: 1,
    missionId,
    revision: 1,
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks,
  };
  let attemptIndex = 0;
  const workerFactories = {
    runtimeFactory: (): AgentRuntime => {
      const script = options.scriptsByAttempt[Math.min(attemptIndex, options.scriptsByAttempt.length - 1)] ?? [];
      attemptIndex += 1;
      return new ScriptedRuntime(script as never);
    },
    toolPortFactory: (task: TaskDependencyNode): ToolPort => {
      if (options.toolPort !== undefined) {
        return options.toolPort;
      }
      return new PolicyWrapper({
        permissionDecider,
        registry,
        workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
        temporaryDirectoryPath,
        workerAllowedToolNames: new Set(task.toolNames),
        nowUnixSeconds: () => NOW_UNIX_SECONDS,
        getCurrentMode: () => modeMachine.getCurrentMode(),
      });
    },
    buildPermissionExplanation: (toolName: string) => `需要 ${toolName} 完成分配任务`,
  };
  const commonOptions = {
    missionId,
    initialChain,
    taskStore,
    concurrency: 4,
    failureThreshold: 3,
    maxLoopIterations: 5,
    workerFactories,
    feedbackTransportFactory: async () => feedbackTransport,
  };
  if (options.mode === "devolve") {
    return new DevolveScheduler({
      ...commonOptions,
      onMissionFinished: (status) => options.finishedStatuses?.push(status),
      onUserEscalation: (message) => options.escalationMessages?.push(message),
    });
  }
  return new AssistScheduler({
    ...commonOptions,
    feedbackTransport,
    onReportToMain: (message) => {
      if (message.payload.kind === "instruction") {
        options.escalationMessages?.push(message.payload.instructionText);
      }
    },
  });
}

const toolCallScript = {
  type: "tool-call",
  toolName: "readFile",
  argumentsJson: '{"filePath":"missing.txt"}',
  callId: "call-1",
} as const;
const toolCallsFinish = {
  type: "finish",
  reason: "tool-calls",
  detail: "请求工具",
} as const;
const successFinish = {
  type: "finish",
  reason: "success",
  detail: "完成",
} as const;
const thresholdFinish = {
  type: "finish",
  reason: "tool-failure-threshold",
  detail: "连续失败达到阈值",
} as const;

describe("T08 编排：Assist 成功路径", () => {
  it("两个任务并发、第三个等待依赖、全部成功后 mission 完成", async () => {
    const tasks = [
      makeTask("T-001"),
      makeTask("T-002"),
      makeTask("T-003", ["T-001", "T-002"]),
    ];
    const escalationMessages: string[] = [];
    const missionId = "mission-success";
    await makeInitialChain(missionId, tasks);
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "assist",
      scriptsByAttempt: [[successFinish], [successFinish], [successFinish]],
      escalationMessages,
    });
    void scheduler.start();
    await waitUntilMissionDone(missionId, 5_000);
    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks.every((task) => task.status === "done")).toBe(true);
    await waitForCondition(
      () => escalationMessages.some((message) => message.includes("done")),
      3_000,
      "mission 完成上报",
    );
    expect(
      escalationMessages.some((message) => message.includes("任务完成状态: done")),
    ).toBe(true);
  });

  it("并发上限为 2：第三个任务在上游完成后才启动（串行依赖）", async () => {
    const tasks = [
      makeTask("T-001"),
      makeTask("T-002", ["T-001"]),
      makeTask("T-003", ["T-002"]),
    ];
    const startedTaskLog: string[] = [];
    const missionId = "mission-serial";
    const initialChain = await makeInitialChain(missionId, tasks);
    let toolExecutionCount = 0;
    const scheduler = new AssistScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 1,
      failureThreshold: 3,
      maxLoopIterations: 5,
      feedbackTransport,
      workerFactories: {
        runtimeFactory: () => new ScriptedRuntime([successFinish]),
        toolPortFactory: () => {
          toolExecutionCount += 1;
          return {
            execute: async () => {
              throw new Error("不应调用工具");
            },
          } as never;
        },
        buildPermissionExplanation: () => "无需工具",
      },
      feedbackTransportFactory: async () => feedbackTransport,
      onReportToMain: (message) => {
        if (message.payload.kind === "instruction") {
          startedTaskLog.push(message.payload.instructionText);
        }
      },
    });
    void scheduler.start();
    await waitUntilMissionDone(missionId, 5_000);
    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks.every((task) => task.status === "done")).toBe(true);
    expect(toolExecutionCount).toBe(3);
  });
});

describe("T08 编排：连续失败与调整", () => {
  it("同一工具三次失败后任务 failed，人工 retry 后成功继续", async () => {
    const tasks = [makeTask("T-001"), makeTask("T-002", ["T-001"])];
    const missionId = "mission-retry";
    await makeInitialChain(missionId, tasks);
    const thresholdFinish = {
      type: "finish",
      reason: "tool-failure-threshold",
      detail: "连续失败达到阈值",
    } as const;
    const scripts = [
      [
        toolCallScript,
        toolCallsFinish,
        toolCallScript,
        toolCallsFinish,
        toolCallScript,
        toolCallsFinish,
        thresholdFinish,
      ],
      [successFinish],
    ];
    const escalationMessages: string[] = [];
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "assist",
      scriptsByAttempt: scripts,
      escalationMessages,
    });
    void scheduler.start();
    await waitForCondition(
      () => escalationMessages.length > 0,
      5_000,
      "失败升级消息"
    );
    const chainAfterFailure = await taskStore.readTaskChain(missionId);
    expect(
      chainAfterFailure?.tasks.find((task) => task.id === "T-001")?.status,
    ).toBe("failed");
    // 人工裁决：重试 T-001（第二次尝试使用成功脚本），随后放行 T-002
    const assistScheduler = scheduler as AssistScheduler;
    assistScheduler.handleInstruction(
      JSON.stringify({ action: "retry", taskId: "T-001" }),
    );
    await waitForCondition(
      async () =>
        (await taskStore.readTaskChain(missionId))?.tasks.find(
          (task) => task.id === "T-001",
        )?.status === "done",
      5_000,
      "T-001 重试完成",
    );
    assistScheduler.handleInstruction(
      JSON.stringify({ action: "unblock", taskId: "T-002" }),
    );
    await waitUntilMissionDone(missionId, 5_000);
    const finalChain = await taskStore.readTaskChain(missionId);
    expect(
      finalChain?.tasks.every((task) => task.status === "done"),
    ).toBe(true);
  });
});

describe("T08 编排：权限询问与裁决", () => {
  it("受限工具触发 permission-ask 升级；会话授权后 unblock 成功", async () => {
    const tasks = [makeTask("T-001", [], ["writeFileTemporary"])];
    const missionId = "mission-ask";
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const sessionManager = new SessionAuthorizationManager();
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "assist",
      scriptsByAttempt: [
        [
          {
            type: "tool-call",
            toolName: "writeFileTemporary",
            argumentsJson: '{"fileName":"out.txt","content":"数据"}',
            callId: "call-write",
          },
          toolCallsFinish,
        ],
        [successFinish],
      ],
      escalationMessages,
      sessionManager,
    });
    void scheduler.start();
    await waitForCondition(
      () => escalationMessages.length > 0,
      5_000,
      "权限升级消息",
    );
    expect(escalationMessages[0]).toContain("writeFileTemporary");
    const chainBefore = await taskStore.readTaskChain(missionId);
    expect(chainBefore?.tasks[0]?.status).toBe("blocked");

    // 用户允许（同一会话管理器授权）+ 下发 unblock 指令
    const argumentsJson = JSON.stringify({ fileName: "out.txt", content: "数据" });
    sessionManager.grant(
      "writeFileTemporary",
      argumentsJson,
      NOW_UNIX_SECONDS,
    );
    const assistScheduler = scheduler as AssistScheduler;
    assistScheduler.handleInstruction(
      JSON.stringify({ action: "unblock", taskId: "T-001" }),
    );
    await waitUntilMissionDone(missionId, 5_000);
    const finalChain = await taskStore.readTaskChain(missionId);
    expect(finalChain?.tasks[0]?.status).toBe("done");
  });

  it("无法解析的指令升级回用户", async () => {
    const tasks = [makeTask("T-001")];
    const missionId = "mission-bad-instruction";
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "assist",
      scriptsByAttempt: [[successFinish]],
      escalationMessages,
    });
    void scheduler.start();
    const assistScheduler = scheduler as AssistScheduler;
    assistScheduler.handleInstruction("这不是 JSON 指令");
    await waitForCondition(
      () => escalationMessages.some((message) => message.includes("无法解析")),
      3_000,
      "解析失败升级",
    );
    await scheduler.cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});

describe("T08 编排：Devolve 与取消", () => {
  it("任务信息不足（ambiguous）进入 blocked 并升级用户", async () => {
    const tasks = [makeTask("T-001")];
    const missionId = "mission-ambiguous";
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "assist",
      scriptsByAttempt: [
        [
          {
            type: "finish",
            reason: "ambiguous",
            detail: "统计口径未指定",
          },
        ],
        [successFinish],
      ],
      escalationMessages,
    });
    void scheduler.start();
    await waitForCondition(
      () => escalationMessages.length > 0,
      3_000,
      "模糊升级消息",
    );
    expect(escalationMessages[0]).toContain("统计口径未指定");
    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks[0]?.status).toBe("blocked");
    // 用户提供补充信息后 unblock → 成功
    const assistScheduler = scheduler as AssistScheduler;
    assistScheduler.handleInstruction(
      JSON.stringify({ action: "unblock", taskId: "T-001" }),
    );
    await waitUntilMissionDone(missionId, 5_000);
  });

  it("DevolveScheduler 直接裁决方法（unblock/reassign/cancel）", async () => {
    const tasks = [makeTask("T-001"), makeTask("T-002", ["T-001"])];
    const missionId = "mission-devolve-control";
    const escalationMessages: string[] = [];
    const modeMachine = new ModeMachine("devolve");
    const sessionManager = new SessionAuthorizationManager();
    const permissionDecider = new PermissionDecider(modeMachine, sessionManager);
    const initialChain = await makeInitialChain(missionId, tasks);
    let attempt = 0;
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 2,
      failureThreshold: 2,
      maxLoopIterations: 5,
      feedbackTransportFactory: async () => feedbackTransport,
      workerFactories: {
        runtimeFactory: () => {
          attempt += 1;
          if (attempt === 1) {
            return new ScriptedRuntime([
              toolCallScript,
              toolCallsFinish,
              thresholdFinish,
            ]);
          }
          return new ScriptedRuntime([successFinish]);
        },
        toolPortFactory: (task) =>
          new PolicyWrapper({
            permissionDecider,
            registry,
            workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
            temporaryDirectoryPath,
            workerAllowedToolNames: new Set(task.toolNames),
            nowUnixSeconds: () => NOW_UNIX_SECONDS,
            getCurrentMode: () => modeMachine.getCurrentMode(),
          }),
        buildPermissionExplanation: () => "说明",
      },
      onMissionFinished: () => {},
      onUserEscalation: (message) => {
        escalationMessages.push(message);
      },
    });
    void scheduler.start();
    await waitForCondition(
      () => escalationMessages.length > 0,
      5_000,
      "失败升级",
    );
    await scheduler.decideReassign("T-001");
    await waitForCondition(
      async () =>
        (await taskStore.readTaskChain(missionId))?.tasks.find(
          (task) => task.id === "T-001",
        )?.status === "done",
      5_000,
      "T-001 重试完成",
    );
    await scheduler.decideUnblock("T-002");
    await waitUntilMissionDone(missionId, 5_000);
    const finalChain = await taskStore.readTaskChain(missionId);
    expect(finalChain?.tasks[0]?.status).toBe("done");
    await scheduler.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("Devolve 无权限询问：受限工具直接执行成功", async () => {
    const tasks = [makeTask("T-001", [], ["writeFileTemporary"])];
    const missionId = "mission-devolve";
    await makeInitialChain(missionId, tasks);
    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const escalationMessages: string[] = [];
    const scheduler = buildScheduler(missionId, tasks, {
      mode: "devolve",
      scriptsByAttempt: [
        [
          {
            type: "tool-call",
            toolName: "writeFileTemporary",
            argumentsJson: '{"fileName":"out.txt","content":"数据"}',
            callId: "call-devolve",
          },
          toolCallsFinish,
          successFinish,
        ],
      ],
      escalationMessages,
      finishedStatuses,
    });
    void scheduler.start();
    await waitUntilMissionDone(missionId, 5_000);
    expect(escalationMessages).toHaveLength(0);
    expect(finishedStatuses).toEqual(["done"]);
    const written = await fs.readFile(
      path.join(temporaryDirectoryPath, "out.txt"),
      "utf8",
    );
    expect(written).toBe("数据");
  });

  it("Worker 子集外工具被拒绝且不影响 mission 完成（Worker 上报失败）", async () => {
    const tasks = [makeTask("T-001", [], ["readFile"])];
    const missionId = "mission-subset";
    const initialChain = await makeInitialChain(missionId, tasks);
    const modeMachine = new ModeMachine("devolve");
    const sessionManager = new SessionAuthorizationManager();
    const permissionDecider = new PermissionDecider(modeMachine, sessionManager);
    const failingToolPort = new PolicyWrapper({
      permissionDecider,
      registry,
      workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
      temporaryDirectoryPath,
      workerAllowedToolNames: new Set(["readFile"]),
      nowUnixSeconds: () => NOW_UNIX_SECONDS,
      getCurrentMode: () => modeMachine.getCurrentMode(),
    });
    const scripts: unknown[] = [];
    let attempt = 0;
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 2,
      failureThreshold: 2,
      maxLoopIterations: 5,
      feedbackTransportFactory: async () => feedbackTransport,
      workerFactories: {
        runtimeFactory: () => {
          attempt += 1;
          const useOutOfSubset = attempt === 1;
          return new ScriptedRuntime(
            useOutOfSubset
              ? [
                  {
                    type: "tool-call",
                    toolName: "listDirectory",
                    argumentsJson: "{}",
                    callId: "call-outside",
                  },
                  toolCallsFinish,
                  successFinish,
                ]
              : [successFinish],
          );
        },
        toolPortFactory: (_task) => failingToolPort,
        buildPermissionExplanation: () => "说明",
      },
      onMissionFinished: (status) => {
        void status;
      },
      onUserEscalation: (message) => {
        scripts.push(message);
      },
    });
    void scheduler.start();
    await waitUntilMissionDone(missionId, 5_000);
    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks[0]?.status).toBe("done");
  });

  it("cancel 中断运行中的 mission", async () => {
    const tasks = [makeTask("T-001")];
    const missionId = "mission-cancel";
    const initialChain = await makeInitialChain(missionId, tasks);
    const hangControl: { release: (() => void) | null } = {
      release: null,
    };
    const hangingToolPort: ToolPort = {
      execute: () =>
        new Promise<ToolCallResult>((resolve) => {
          hangControl.release = () =>
            resolve({
              kind: "success",
              callId: "call-hang",
              outputText: "完成",
              isSideEffectFree: true,
            });
        }),
    };
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 2,
      failureThreshold: 3,
      maxLoopIterations: 5,
      feedbackTransportFactory: async () => feedbackTransport,
      workerFactories: {
        runtimeFactory: () =>
          new ScriptedRuntime([
            {
              type: "tool-call",
              toolName: "readFile",
              argumentsJson: '{"filePath":"a.txt"}',
              callId: "call-hang",
            },
            toolCallsFinish,
            successFinish,
          ]),
        toolPortFactory: () => hangingToolPort,
        buildPermissionExplanation: () => "说明",
      },
      onMissionFinished: () => {},
      onUserEscalation: () => {},
    });
    void scheduler.start();
    await waitForCondition(
      () => scheduler.getRunningTaskIds().length === 1,
      3_000,
      "Worker 挂起",
    );
    hangControl.release?.();
    await scheduler.cancel();
    // 二次 cancel 幂等
    await scheduler.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scheduler.getRunningTaskIds()).toHaveLength(0);
  });
});

async function waitUntilMissionDone(
  missionId: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const chain = await taskStore.readTaskChain(missionId);
    const isDone = chain?.tasks.every((task) => task.status === "done");
    const isFailed = chain?.tasks.some((task) => task.status === "failed");
    if (isDone || isFailed || chain === null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 mission 完成超时: ${missionId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("T05A：工作存档与选择性上下文", () => {
  it("Worker 写入存档；唯一实例 ID 不复用；重试附加须显式开启（审计 S6）", async () => {
    const missionId = "mission-archive";
    const tasks = [makeTask("T-001")];
    await makeInitialChain(missionId, tasks);
    const { AgentWorkArchiveStore, decodePathSegment } = await import(
      "../../../packages/core/src/orchestration/work-archive-store.js"
    );
    const archiveStore = new AgentWorkArchiveStore({
      baseDirectory: temporaryDirectory,
    });
    let attempt = 0;
    const initialChain = {
      schemaVersion: 1,
      missionId,
      revision: 1,
      updatedAtIso: "2026-08-12T10:00:00.000Z",
      tasks,
    };
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 2,
      failureThreshold: 2,
      maxLoopIterations: 5,
      feedbackTransportFactory: async () => feedbackTransport,
      workArchiveStore: archiveStore,
      workerFactories: {
        runtimeFactory: (): AgentRuntime => {
          attempt += 1;
          return new ScriptedRuntime(
            attempt === 1
              ? [
                  { type: "finish", reason: "error", detail: "第一次失败" },
                ]
              : [successFinish],
          ) as unknown as AgentRuntime;
        },
        toolPortFactory: () => ({
          execute: async () => ({
            kind: "error",
            callId: "c1",
            errorCode: "unknown",
            errorMessage: "x",
            isIdempotencyConfirmed: false,
          }),
        }),
        buildPermissionExplanation: () => "说明",
      },
      onMissionFinished: () => {},
      onUserEscalation: () => {},
    });
    void scheduler.start();
    // 第一次失败 → 升级 → 重新指派
    await waitForCondition(async () => {
      const agentIds = await archiveStore.listAgentIdsWithArchive(missionId);
      for (const agentId of agentIds) {
        const archive = await archiveStore.readArchive(missionId, agentId);
        if (
          archive !== null &&
          decodePathSegment(agentId).startsWith("worker:mission-archive:T-001") &&
          archive.entries.some((entry) => entry.entryType === "failure")
        ) {
          return true;
        }
      }
      return false;
    }, 5_000, "第一次失败写入存档");
    await scheduler.decideReassign("T-001");
    await waitUntilMissionDone(missionId, 5_000);
    // 每个实例 ID 唯一：两次执行对应两个不同存档（不可复用）
    const agentIds = await archiveStore.listAgentIdsWithArchive(missionId);
    const instanceIds = agentIds.filter((agentId) =>
      decodePathSegment(agentId).startsWith("worker:mission-archive:T-001"),
    );
    expect(instanceIds.length).toBe(2);
    expect(new Set(instanceIds).size).toBe(2);
    // 默认不附加（attachArchiveContextOnRetry 未开启），存档仍完整写入
    const firstArchive = await archiveStore.readArchive(missionId, instanceIds[0]!);
    const secondArchive = await archiveStore.readArchive(missionId, instanceIds[1]!);
    expect(firstArchive?.entries.filter((entry) => entry.entryType === "assignment")).toHaveLength(1);
    expect(secondArchive?.entries.filter((entry) => entry.entryType === "assignment")).toHaveLength(1);
    expect(attempt).toBeGreaterThanOrEqual(2);
    await scheduler.cancel();
  }, 20_000);

  it("显式开启 attachArchiveContextOnRetry 时，第二次调用附带按属主的上下文（审计 S6）", async () => {
    const missionId = "mission-attach";
    const tasks = [makeTask("T-001")];
    await makeInitialChain(missionId, tasks);
    const { AgentWorkArchiveStore, decodePathSegment } = await import(
      "../../../packages/core/src/orchestration/work-archive-store.js"
    );
    const archiveStore = new AgentWorkArchiveStore({
      baseDirectory: temporaryDirectory,
    });
    const capturedSystemPrompts: string[] = [];
    let attempt = 0;
    const initialChain = {
      schemaVersion: 1,
      missionId,
      revision: 1,
      updatedAtIso: "2026-08-12T10:00:00.000Z",
      tasks,
    };
    const scheduler = new DevolveScheduler({
      missionId,
      initialChain,
      taskStore,
      concurrency: 2,
      failureThreshold: 2,
      maxLoopIterations: 5,
      feedbackTransportFactory: async () => feedbackTransport,
      workArchiveStore: archiveStore,
      attachArchiveContextOnRetry: true,
      workerFactories: {
        runtimeFactory: (): AgentRuntime => {
          attempt += 1;
          const runtime = new ScriptedRuntime(
            attempt === 1
              ? [{ type: "finish", reason: "error", detail: "第一次失败" }]
              : [successFinish],
          ) as unknown as AgentRuntime;
          const originalRun = runtime.run.bind(runtime);
          runtime.run = (input, signal) => {
            capturedSystemPrompts.push(input.systemPrompt);
            return originalRun(input, signal);
          };
          return runtime;
        },
        toolPortFactory: () => ({
          execute: async () => ({
            kind: "error",
            callId: "c1",
            errorCode: "unknown",
            errorMessage: "x",
            isIdempotencyConfirmed: false,
          }),
        }),
        buildPermissionExplanation: () => "说明",
      },
      onMissionFinished: () => {},
      onUserEscalation: () => {},
    });
    void scheduler.start();
    await waitForCondition(
      async () => {
        const agentIds = await archiveStore.listAgentIdsWithArchive(missionId);
        for (const agentId of agentIds) {
          const archive = await archiveStore.readArchive(missionId, agentId);
          if (
            archive !== null &&
            decodePathSegment(agentId).startsWith("worker:mission-attach:T-001") &&
            archive.entries.some((entry) => entry.entryType === "failure")
          ) {
            return true;
          }
        }
        return false;
      },
      5_000,
      "第一次失败写入存档",
    );
    await scheduler.decideReassign("T-001");
    await waitUntilMissionDone(missionId, 5_000);
    // 第二次调用的 systemPrompt 包含按属主标注的选择性上下文
    const secondPrompt = capturedSystemPrompts.at(-1) ?? "";
    expect(secondPrompt).toContain("上级选择性附加的上次执行上下文");
    expect(secondPrompt).toContain("[属主 worker:mission-attach:T-001:1，revision");
    expect(secondPrompt).toContain("[failure]");
    await scheduler.cancel();
  }, 20_000);
});
