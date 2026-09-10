/**
 * T07D-R1-02：真实提交和事件（行为反例 → 实现）。
 * 验收：提交后观察实际执行器调用和 fixture 产物；accepted 不发 task-finished；
 * 同一幂等键不重复执行；两个会话结果不串线；blocked 由权威状态驱动。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r1-02-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

type CapturedEvent = {
  eventType: string;
  taskIdentifier?: string;
  status?: string;
};

async function waitForEvent(
  events: CapturedEvent[],
  predicate: (event: CapturedEvent) => boolean,
  timeoutMilliseconds = 5_000,
): Promise<CapturedEvent> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待事件超时: " + JSON.stringify(events));
}

function collectEvents(application: AstarrayApplicationFacade) {
  const events: CapturedEvent[] = [];
  const subscription = application.subscribe((event) => {
    events.push(event as CapturedEvent);
  });
  return { events, subscription };
}

/** 注入式假运行时：驱动权威状态序列，验证事件不由字符串占位决定。 */
function makeFakeRuntime(statusSequence: string[]): ApplicationRuntime {
  let pollIndex = 0;
  const controller = {
    getCurrentMode: () => "assist",
    handleUserMessage: async () => "mission-fake-1",
    queryMissionStatus: async () => {
      const status = statusSequence[Math.min(pollIndex, statusSequence.length - 1)];
      pollIndex += 1;
      return { summary: { status }, taskChain: { tasks: [{ status }] } };
    },
    cancelMission: async () => {},
  };
  return {
    controller: controller as never,
    shutdown: async () => {},
  } as never;
}

describe("T07D-R1-02：提交、幂等与会话隔离", () => {
  it("mock 运行时：accepted 先发、finished 只发一次、落盘真实产物", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const { events, subscription } = collectEvents(application);

    const accepted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "T07D-R1-02 probe",
      idempotencyKey: "idem-1",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.missionIdentifier).not.toBeNull();
    expect(
      events.some((event) => event.eventType === "task-finished"),
    ).toBe(false);
    expect(
      events.some(
        (event) => event.eventType === "task-status" && event.status === "accepted",
      ),
    ).toBe(true);

    const finished = await waitForEvent(
      events,
      (event) => event.eventType === "task-finished",
    );
    expect(["done", "failed", "cancelled", "blocked"]).toContain(finished.status);
    expect(
      events.filter((event) => event.eventType === "task-finished"),
    ).toHaveLength(1);
    const acceptedIndex = events.findIndex(
      (event) => event.eventType === "task-status" && event.status === "accepted",
    );
    const finishedIndex = events.findIndex(
      (event) => event.eventType === "task-finished",
    );
    expect(acceptedIndex).toBeLessThan(finishedIndex);

    const missionDirectory = path.join(
      stateDirectory,
      "missions",
      accepted.missionIdentifier as string,
    );
    const taskChainRaw = await fs.readFile(
      path.join(missionDirectory, "task-chain.json"),
      "utf8",
    );
    expect(taskChainRaw).toContain("T-001");

    subscription.unsubscribe();
    await application.shutdown();
  });

  it("同一会话同一幂等键不重复执行", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });

    const first = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "same request",
      idempotencyKey: "idem-shared",
    });
    const second = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-2",
      prompt: "same request",
      idempotencyKey: "idem-shared",
    });
    expect(second.missionIdentifier).toBe(first.missionIdentifier);

    const missionEntries = await fs.readdir(path.join(stateDirectory, "missions"));
    expect(missionEntries).toHaveLength(1);
    await application.shutdown();
  });

  it("两个会话结果不串线", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    application.createSession({ sessionId: "session-1", mode: "assist" });
    application.createSession({ sessionId: "session-2", mode: "assist" });

    const first = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "probe one",
    });
    const second = await application.submitTask({
      sessionId: "session-2",
      taskIdentifier: "task-2",
      prompt: "probe two",
    });
    expect(first.missionIdentifier).not.toBe(second.missionIdentifier);
    await expect(
      application.queryTask({ sessionId: "session-2", taskIdentifier: "task-1" }),
    ).rejects.toMatchObject({ errorCode: "session-mismatch" });
    await expect(
      application.queryTask({ sessionId: "session-1", taskIdentifier: "task-2" }),
    ).rejects.toMatchObject({ errorCode: "session-mismatch" });
    await application.shutdown();
  });

  it("blocked 由权威状态驱动，且不提前发 finished", async () => {
    const application = new AstarrayApplicationFacade(
      makeFakeRuntime(["running", "blocked"]),
    );
    application.createSession({ sessionId: "session-1", mode: "assist" });
    const { events, subscription } = collectEvents(application);

    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "blocked probe",
    });
    await waitForEvent(
      events,
      (event) => event.eventType === "task-status" && event.status === "running",
    );
    await waitForEvent(
      events,
      (event) => event.eventType === "task-status" && event.status === "blocked",
    );
    expect(events.some((event) => event.eventType === "task-finished")).toBe(false);

    subscription.unsubscribe();
    await application.shutdown();
  });
});
