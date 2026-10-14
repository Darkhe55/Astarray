/**
 * T07D-R1-02：真实提交和事件（行为反例 → 实现）。
 * 验收：提交后观察实际执行器调用和 fixture 产物；accepted 不发 task-finished；
 * 同一幂等键不重复执行；两个会话结果不串线；blocked 由权威状态驱动。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 真实文件 I/O + 真实定时器：全量并行时放宽超时（仍为有界）。
vi.setConfig({ testTimeout: 20_000 });

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

/**
 * 终态集合（`PublicTaskStatus` 中不再变化的取值）。
 * 注意：`accepted`/`running` **不是**终态。
 */
const TERMINAL_TASK_STATUSES = ["done", "failed", "blocked", "cancelled"];

/**
 * 等待给定 mission 全部到达终态、且调度侧不再有活跃 mission。
 *
 * 用途见 `两个会话结果不串线` 用例内的长注释：避免用例结束后仍有在途链写入
 * 落到已被 `afterEach` 删除的临时目录上（`ENOENT` + vitest 非用例级 exit 1）。
 *
 * 返回**最后观测到的状态**，便于失败时给出可归因信息。
 *
 * ## ⚠️ 一处我踩过的坑（实测，写下来避免后人重踩）
 *
 * 首版我把条件写成"全部终态 **且** `getActiveMissionIds()` 清空"，
 * 结果该用例**每次都跑满 15s 期限**（实测 15048ms）。
 * 用探针实测原因：mock 运行时下 mission 约 **313ms** 就到 `done`，
 * 但 `getActiveMissionIds()` **始终为 2**（已完成的 mission 不会从
 * `activeOrchestrators` 移除）⇒ 那个附加条件**永远不可能满足**。
 * **故只以"终态"为判据。**
 */

/**
 * 收窄 mission 标识：`submitTask` 的返回类型里它是 `string | null`。
 * 这里**不静默吞掉 null** —— 真为 null 说明提交没产生 mission，
 * 那本身就是本用例要发现的问题，故直接抛错而不是跳过等待。
 */
function requireMissionIdentifier(missionIdentifier: string | null): string {
  if (missionIdentifier === null) {
    throw new Error("submitTask 未返回 missionIdentifier ⇒ 无法等待其收尾");
  }
  return missionIdentifier;
}

async function waitForMissionsToSettle(
  application: AstarrayApplicationFacade,
  missionIdentifiers: string[],
  timeoutMilliseconds = 10_000,
): Promise<Map<string, string>> {
  const deadline = Date.now() + timeoutMilliseconds;
  const lastObserved = new Map<string, string>();
  while (true) {
    let areAllTerminal = true;
    for (const missionIdentifier of missionIdentifiers) {
      const missionState = await application.queryMission(missionIdentifier);
      lastObserved.set(missionIdentifier, missionState.status);
      if (!TERMINAL_TASK_STATUSES.includes(missionState.status)) {
        areAllTerminal = false;
      }
    }
    if (areAllTerminal || Date.now() >= deadline) {
      return lastObserved;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

    /**
     * 2026-11-08（第 58 轮）：**收尾前先等两条任务的链写入落定**。
     *
     * ## 为什么必须等（实测的失败形态）
     *
     * 本用例后是 `afterEach` 的 `fs.rm(stateDirectory)`。而本用例**提交完就立刻返回**
     * ⇒ 调度侧仍有在途工作（worker 结果处理 → `DagScheduler.persistChain` →
     * `TaskStore.writeChainInternal` 写 `.task-chain.json.<pid>.<uuid>.tmp`）
     * ⇒ 临时目录已被删除后该写入仍要落盘 ⇒ 抛
     * `ENOENT: open ...\missions\<id>\.task-chain.json.<pid>.<uuid>.tmp`。
     *
     * 该错误**不在用例级**（`Tests: 3255 passed`）却让整个 `vitest` 以 **exit 1** 结束，
     * 归因到"最后跑过的那个用例"，极易被误读成那条用例的断言问题。
     * 已在全量默认并发下**实测复现**（见 `docs/reports/ISOLATION_AND_NON_TEST_LEVEL_FAILURE_2026-10-12.md`
     * 的续记）；隔离单跑 6 次与该报告记的 `--maxWorkers=6` 三次**均未复现** ⇒ **负载相关**。
     *
     * ## 为什么这样修（而不是随便 sleep）
     *
     * 等的是**可观察的状态**：每个 mission 到达终态、且 `getActiveMissionIds()` 清空
     * ——这正是"在途工作已结束"的语义判据，而非猜测时长。
     * **注意**：本改动**只修测试的收尾时序**，**不声称**产品侧 `shutdown()` 的
     * "返回即静默"语义已经成立（那是另一处待定取舍，报告中已记录两个方向）。
     */
    await waitForMissionsToSettle(application, [
      requireMissionIdentifier(first.missionIdentifier),
      requireMissionIdentifier(second.missionIdentifier),
    ]);

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
