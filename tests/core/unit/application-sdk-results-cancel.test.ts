/**
 * T07D-R1-03：结果、取消与安全关闭（行为反例 → 实现）。
 * 验收：权威结果存储（非永空 Map）；成功/失败/取消稳定终态；订阅退订与回调异常隔离；
 * shutdown 收敛在途调用并释放资源。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r1-03-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

type CapturedEvent = { eventType: string; taskIdentifier?: string; status?: string };

function makeFakeRuntime(options: {
  missionStatus?: string;
  handleUserMessageRejects?: boolean;
  resultSummaries?: Array<{ taskId: string | null; entryType: string; summary: string }>;
} = {}) {
  const cancelMission = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const readMissionResultSummaries = vi.fn(async () =>
    options.resultSummaries ?? [
      { taskId: "T-001", entryType: "result", summary: "（权威执行输出）" },
    ],
  );
  const controller = {
    getCurrentMode: () => "assist",
    handleUserMessage: async () => {
      if (options.handleUserMessageRejects === true) {
        throw new Error("provider exploded");
      }
      return "mission-fake-1";
    },
    queryMissionStatus: async () => ({
      summary: { status: options.missionStatus ?? "running" },
      taskChain: { tasks: [{ status: options.missionStatus ?? "running" }] },
    }),
    cancelMission,
  };
  const runtime = {
    controller: controller as never,
    readMissionResultSummaries,
    shutdown,
  } as never;
  return { runtime, cancelMission, shutdown, readMissionResultSummaries };
}

async function waitForStatus(
  application: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
  expected: string[],
  timeoutMilliseconds = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await application.queryTask({ sessionId, taskIdentifier });
    if (expected.includes(result.status)) {
      return result.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待任务终态超时");
}

describe("T07D-R1-03：结果、取消与安全关闭", () => {
  it("成功任务的结果预览来自权威工作存档（非占位）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "T07D-R1-03 probe",
    });
    const status = await waitForStatus(application, "session-1", "task-1", [
      "done",
      "failed",
      "blocked",
    ]);
    expect(status).toBe("done");

    const result = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    expect(result.summaryPreview).toContain("mock 执行器");

    // 终态稳定：重复查询结果一致
    const repeated = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    expect(repeated.summaryPreview).toBe(result.summaryPreview);
    expect(repeated.status).toBe("done");
    await application.shutdown();
  });

  it("取消产生稳定终态且只发一次 finished", async () => {
    const fake = makeFakeRuntime({ missionStatus: "running" });
    const application = new AstarrayApplicationFacade(fake.runtime, {
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const events: CapturedEvent[] = [];
    application.subscribe((event) => events.push(event as CapturedEvent));

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "cancel probe",
    });
    await application.cancelTask({ sessionId: "session-1", taskIdentifier: "task-1" });
    expect(fake.cancelMission).toHaveBeenCalledWith("mission-fake-1");

    const first = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    expect(first.status).toBe("cancelled");

    await application.cancelTask({ sessionId: "session-1", taskIdentifier: "task-1" });
    const finishedEvents = events.filter(
      (event) => event.eventType === "task-finished",
    );
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0]?.status).toBe("cancelled");
    await application.shutdown();
  });

  it("订阅退订生效，回调异常不破坏其他订阅者", async () => {
    const fake = makeFakeRuntime({ missionStatus: "running" });
    const application = new AstarrayApplicationFacade(fake.runtime, {
      statusPollIntervalMilliseconds: 5,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const healthyEvents: string[] = [];
    const throwingSubscription = application.subscribe(() => {
      throw new Error("subscriber broken");
    });
    const healthySubscription = application.subscribe((event) => {
      healthyEvents.push(event.eventType);
    });

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "subscription probe",
    });
    expect(healthyEvents.length).toBeGreaterThan(0);

    healthySubscription.unsubscribe();
    const countAfterUnsubscribe = healthyEvents.length;
    await application.cancelTask({ sessionId: "session-1", taskIdentifier: "task-1" });
    expect(healthyEvents.length).toBe(countAfterUnsubscribe);
    throwingSubscription.unsubscribe();
    await application.shutdown();
  });

  it("shutdown 收敛在途调用并释放运行时资源", async () => {
    const fake = makeFakeRuntime({ missionStatus: "running" });
    const application = new AstarrayApplicationFacade(fake.runtime, {
      statusPollIntervalMilliseconds: 5,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const events: CapturedEvent[] = [];
    application.subscribe((event) => events.push(event as CapturedEvent));

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "shutdown probe",
    });
    await application.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
    const countAfterShutdown = events.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.length).toBe(countAfterShutdown);
  });

  it("提交失败传播为稳定错误码且不留下任务", async () => {
    const fake = makeFakeRuntime({ handleUserMessageRejects: true });
    const application = new AstarrayApplicationFacade(fake.runtime, {
      statusPollIntervalMilliseconds: 5,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await expect(
      application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "failure probe",
      }),
    ).rejects.toMatchObject({ errorCode: "submit-failed" });
    await expect(
      application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" }),
    ).rejects.toMatchObject({ errorCode: "task-not-found" });
    await application.shutdown();
  });
});
