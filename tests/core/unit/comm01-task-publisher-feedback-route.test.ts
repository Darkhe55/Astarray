/**
 * 反例（2026-10-25）：**反馈默认走任务发布者的反向通道**。
 *
 * 依据用户 2026-10-22 澄清：
 * > "反馈**不是根据上下级关系**进行的，是**每条任务的反馈路径默认走任务发布者的反向通道**。"
 *
 * 修复前实测缺口：`worker-agent.reportOutcome()` **硬编码** `scheduler:<missionId>`，
 * 且 `TaskDependencyNode` **没有发布者字段** ⇒ 别处发布的任务反馈会**错投**。
 */
import { describe, expect, it } from "vitest";

import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";
import type { WorkerAgent, WorkerAgentOptions } from "../../../packages/core/src/orchestration/worker-agent.js";
import {
  resolveFeedbackRecipient,
  resolvePublisherRecipientIdForTask,
  stampPublisherOnTasks,
} from "../../../packages/core/src/orchestration/task-publisher-feedback-route.js";

const DEFAULT_SCHEDULER = "scheduler:mission-1";

function buildTask(overrides: Partial<TaskDependencyNode> = {}): TaskDependencyNode {
  return {
    id: "task-1",
    description: "写报告",
    dependsOn: [],
    taskType: "implementation",
    toolNames: [],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
    ...overrides,
  };
}

describe("COMM-01-02：反馈去向 = 任务发布者的反向通道", () => {
  it("① 任务记录了发布者 ⇒ 反馈**投给发布者**（不是默认 scheduler）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask({ publishedByRecipientId: "main:mission-7" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.recipientId).toBe("main:mission-7");
    expect(route.isPublisherReverseChannel).toBe(true);
    expect(route.fallbackReason).toBeNull();
  });

  it("② 任务**未记录**发布者 ⇒ 回退默认信箱，且**如实说明回退原因**（不静默）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask(),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.recipientId).toBe(DEFAULT_SCHEDULER);
    expect(route.isPublisherReverseChannel).toBe(false);
    // 必须能让调用方看出来"这不是按发布者投的"
    expect(String(route.fallbackReason)).toContain("未记录发布者信箱");
    expect(String(route.fallbackReason)).toContain(DEFAULT_SCHEDULER);
  });

  it("③ 发布者字段为**空白字符串** ⇒ 视为未记录（不得把空串当有效信箱）", () => {
    const route = resolveFeedbackRecipient({
      task: buildTask({ publishedByRecipientId: "   " }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(route.isPublisherReverseChannel).toBe(false);
    expect(route.recipientId).toBe(DEFAULT_SCHEDULER);
  });

  it("④ 发布者可**批量登记**到任务链全部任务（发布时使用）", () => {
    const tasks = [buildTask({ id: "a" }), buildTask({ id: "b" })];

    const stamped = stampPublisherOnTasks({
      tasks,
      publisherRecipientId: "main:mission-9",
    });

    expect(stamped).toHaveLength(2);
    for (const task of stamped) {
      expect(task.publishedByRecipientId).toBe("main:mission-9");
    }
    // 必须**不改动**其它字段，且不原地修改入参
    expect(stamped[0]!.id).toBe("a");
    expect(tasks[0]!.publishedByRecipientId).toBeUndefined();
  });

  it("⑤ 两条任务由**不同发布者**发布 ⇒ 各自反馈回各自发布者（不串档）", () => {
    const first = resolveFeedbackRecipient({
      task: buildTask({ id: "a", publishedByRecipientId: "main:mission-7" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });
    const second = resolveFeedbackRecipient({
      task: buildTask({ id: "b", publishedByRecipientId: "scheduler:mission-2" }),
      defaultSchedulerRecipientId: DEFAULT_SCHEDULER,
    });

    expect(first.recipientId).toBe("main:mission-7");
    expect(second.recipientId).toBe("scheduler:mission-2");
    expect(first.recipientId).not.toBe(second.recipientId);
  });
});

describe("COMM-01-02：发布者登记规则（编排器发布任务时用）", () => {
  it("⑥ 任务未带发布者 ⇒ 登记**本编排器**的信箱", () => {
    const recipientId = resolvePublisherRecipientIdForTask({
      task: buildTask(),
      publisherRecipientId: "scheduler:mission-1",
    });

    expect(recipientId).toBe("scheduler:mission-1");
  });

  it("⑦ 任务**已带**发布者 ⇒ 尊重原值（不覆盖别人的反向通道）", () => {
    const recipientId = resolvePublisherRecipientIdForTask({
      task: buildTask({ publishedByRecipientId: "main:mission-7" }),
      publisherRecipientId: "scheduler:mission-1",
    });

    // 覆盖会把反馈从真正的发布者改投到我们这里 —— 那是另一种"错投"
    expect(recipientId).toBe("main:mission-7");
  });

  it("⑧ 发布者字段为空白 ⇒ 视为未登记，用本编排器信箱补齐", () => {
    const recipientId = resolvePublisherRecipientIdForTask({
      task: buildTask({ publishedByRecipientId: "  " }),
      publisherRecipientId: "scheduler:mission-1",
    });

    expect(recipientId).toBe("scheduler:mission-1");
  });

  it("⑨ 登记后再解析去向 ⇒ 走发布者反向通道（两段规则衔接一致）", () => {
    const task = buildTask();
    const stamped = {
      ...task,
      publishedByRecipientId: resolvePublisherRecipientIdForTask({
        task,
        publisherRecipientId: "scheduler:mission-1",
      }),
    };

    const route = resolveFeedbackRecipient({
      task: stamped,
      defaultSchedulerRecipientId: "scheduler:mission-1",
    });

    expect(route.recipientId).toBe("scheduler:mission-1");
    // 关键：登记后**不再**是"回退"，而是**正向的发布者反向通道**
    expect(route.isPublisherReverseChannel).toBe(true);
    expect(route.fallbackReason).toBeNull();
  });
});

describe("COMM-01-02：编排器构造 Worker 时确实登记发布者（端到端于该类内部）", () => {
  /**
   * 为何用**子类 + 调用 `buildWorkerAgent`**：
   * `MissionOrchestrator` 的构造依赖很重（TaskStore/租约/调度器/各种工厂），
   * 但在全仓没有构造它的集成测试之前，"编排器确实登记了发布者"这件事
   * 只能靠类型检查 + 纯函数测试支撑（上一轮我如实标注了这一点）。
   *
   * 本轮把内联的 `new WorkerAgent({...})` 抽成可覆写的 `buildWorkerAgent`，
   * 于是可以：
   *  1. 覆写它以**捕获真实编排代码产出的配置**（而不是复制一份配置来测）；
   *  2. 直接调用该 protected 方法并断言其返回值 —— 这就是**编排代码本身**的行为，
   *     不再是我复制的逻辑。
   *
   * 若有人把那段登记逻辑删掉，本用例会红。
   */
  class CapturingOrchestrator extends MissionOrchestrator {
    capture(options: WorkerAgentOptions): WorkerAgent {
      return this.buildWorkerAgent(options);
    }
  }

  function buildOrchestrator(): CapturingOrchestrator {
    return new CapturingOrchestrator({
      initialChain: {
        schemaVersion: 1,
        missionId: "mission-1",
        revision: 1,
        updatedAtIso: "2026-10-27T00:00:00.000Z",
        tasks: [buildTask()],
      },
      missionId: "mission-1",
      concurrency: 1,
      taskStore: {
        readTaskChain: async () => null,
        writeTaskChain: async () => {},
      } as never,
      feedbackTransportFactory: async () =>
        ({
          onMessage: () => {},
          enqueue: async () => {},
          queryHealth: async () => ({
            isHealthy: true,
            processPid: 0,
            protocolVersion: 1,
            queuedMessageCount: 0,
          }),
          shutdown: async () => {},
          setAgentStatus: () => {},
        }) as never,
      workerFactories: {
        runtimeFactory: () => ({}) as never,
        toolPortFactory: () => ({}) as never,
        buildPermissionExplanation: () => "无需工具",
      },
      maxLoopIterations: 1,
      onUserEscalation: () => {},
    } as never);
  }

  it("⑩ 编排器产出的 Worker 配置里，任务带着**编排器自己的信箱**", () => {
    const orchestrator = buildOrchestrator();
    const task = buildTask();

    const worker = orchestrator.capture({
      agentInstanceId: "worker-1",
      missionId: "mission-1",
      task,
      runtime: {} as never,
      toolPort: {} as never,
    } as never);

    // 通过 WorkerAgent 自身的 options 读回（契约：构造时传入什么就持有什么）
    const capturedTask = (worker as unknown as { options: WorkerAgentOptions }).options.task;
    expect(capturedTask.publishedByRecipientId).toBe("scheduler:mission-1");
  });

  it("⑪ 任务**已带**发布者 ⇒ 编排器不覆盖（尊重别人的反向通道）", () => {
    const orchestrator = buildOrchestrator();
    const task = buildTask({ publishedByRecipientId: "main:mission-7" });

    const worker = orchestrator.capture({
      agentInstanceId: "worker-1",
      missionId: "mission-1",
      task,
      runtime: {} as never,
      toolPort: {} as never,
    } as never);

    const capturedTask = (worker as unknown as { options: WorkerAgentOptions }).options.task;
    expect(capturedTask.publishedByRecipientId).toBe("main:mission-7");
  });
});
