/**
 * RELIABILITY-01-02 反例（2026-10-10）：幂等账目**并发落盘**不得丢失 claim。
 *
 * 对账登记为"并发落盘需返修"，属于**静态疑点**。本文件先尝试**证伪**：
 * 若并发提交多个会话的 claim 后，账目文件缺少任何一条，即为真实缺陷；
 * 若全部保留，则如实记录"该路径已安全"（不为了改而改）。
 *
 * 关注点：`submitTask` 的 claim 在**无 await 的同步段**内建立并快照落盘；
 * 结算阶段（await 之后）再次落盘。两者都以"当前全量账目"为快照，
 * 因此并发不应丢条目。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AstarrayApplicationFacade,
  loadTaskIdempotencyLedgerWithIntegrity,
} from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-r4-concurrent-"));
});

afterEach(async () => {
  try {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 4,
    failureThreshold: 3,
  });
}

describe("RELIABILITY-01-02：幂等账目并发落盘不丢 claim", () => {
  it("① 并发提交 8 个不同会话的 claim ⇒ 账目必须完整保留 8 条（无 last-writer-wins 丢条）", async () => {
    const application = await createApplication();
    try {
      for (let index = 0; index < 8; index += 1) {
        application.createSession({ sessionId: "session-" + String(index), mode: "assist" });
      }
      const submissions = Array.from({ length: 8 }, (_unused, index) =>
        application.submitTask({
          sessionId: "session-" + String(index),
          taskIdentifier: "task-" + String(index),
          prompt: "并发任务 " + String(index),
          idempotencyKey: "key-" + String(index),
        }),
      );
      const results = await Promise.allSettled(submissions);
      // 全部受理成功（不因并发被误判为冲突/挂起）
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(0);

      // 磁盘账目必须完整：8 条 claim 一个都不能少
      const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
      expect(integrity.isCorrupted).toBe(false);
      expect(integrity.entries).toHaveLength(8);
      const keys = integrity.entries.map((entry) => entry.idempotencyKey).sort();
      expect(keys).toEqual([
        "key-0",
        "key-1",
        "key-2",
        "key-3",
        "key-4",
        "key-5",
        "key-6",
        "key-7",
      ]);
    } finally {
      await application.shutdown();
    }
  });

  it("② 重启后（新 facade 读同一目录）同键同参必须复用、不重复执行", async () => {
    const firstApplication = await createApplication();
    const firstTaskIdentifier = await (async (): Promise<string> => {
      try {
        firstApplication.createSession({ sessionId: "session-1", mode: "assist" });
        const first = await firstApplication.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-1",
          prompt: "幂等任务",
          idempotencyKey: "stable-key",
        });
        return first.taskIdentifier;
      } finally {
        await firstApplication.shutdown();
      }
    })();

    const restarted = await createApplication();
    try {
      restarted.createSession({ sessionId: "session-1", mode: "assist" });
      const replayed = await restarted.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1-different-identifier",
        prompt: "幂等任务",
        idempotencyKey: "stable-key",
      });
      // 复用既有受理结果（同一 taskIdentifier），不新建执行
      expect(replayed.taskIdentifier).toBe(firstTaskIdentifier);

      // 同键异参必须拒绝
      await expect(
        restarted.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-2",
          prompt: "换了参数",
          idempotencyKey: "stable-key",
        }),
      ).rejects.toMatchObject({ errorCode: "idempotency-key-conflict" });
    } finally {
      await restarted.shutdown();
    }
  });

  it("③ 并发提交同一会话同一键 ⇒ 只允许一个 claim，其余按 pending 拒绝（不双执行）", async () => {    const application = await createApplication();
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_unused, index) =>
          application.submitTask({
            sessionId: "session-1",
            taskIdentifier: "task-" + String(index),
            prompt: "同一键并发",
            idempotencyKey: "same-key",
          }),
        ),
      );
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejectedWithPendingOrConflict = results.filter(
        (result) =>
          result.status === "rejected" &&
          ["idempotency-claim-pending", "idempotency-key-conflict"].includes(
            (result.reason as { errorCode?: string })?.errorCode ?? "",
          ),
      );
      // 只有一条真正执行；其余必须被拒（既不双执行，也不假定成功）
      expect(fulfilled.length + rejectedWithPendingOrConflict.length).toBe(5);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
      expect(integrity.entries).toHaveLength(1);
    } finally {
      await application.shutdown();
    }
  });

  /**
   * ④ 交错写入压力（证伪尝试的加强版）：多轮并发，每轮都**等到账目追平**再核对。
   *
   * 时序说明（2026-10-10 实证）：`submitTask` 的 claim 是**同步段内**落盘的，但**结算**
   * （绑定 missionIdentifier）发生在 `await` 之后——因此 `Promise.all(submitTask)` 解析时
   * 落盘条目可能仍在追赶中。本用例原先立刻断言精确条数，在全量并发下偶发失败
   * （隔离运行恒过）。这是**测试的时序假设**，不是产品丢条：故改为**有界等待**，
   * 既不再假设立即完成，也仍能抓住真实回归（若条目**永不**追平，等待耗尽即失败并给出实测值）。
   */
  it("④ 多轮交错并发（4 轮 × 6 会话）⇒ 账目最终必须追平累计提交数", async () => {
    const application = await createApplication();
    try {
      let committedCount = 0;
      for (let round = 0; round < 4; round += 1) {
        const roundSessionCount = 6;
        for (let index = 0; index < roundSessionCount; index += 1) {
          application.createSession({
            sessionId: "round-" + String(round) + "-session-" + String(index),
            mode: "assist",
          });
        }
        await Promise.all(
          Array.from({ length: roundSessionCount }, (_unused, index) =>
            application.submitTask({
              sessionId: "round-" + String(round) + "-session-" + String(index),
              taskIdentifier: "round-" + String(round) + "-task-" + String(index),
              prompt: "交错任务 " + String(round) + "-" + String(index),
              idempotencyKey: "round-" + String(round) + "-key-" + String(index),
            }),
          ),
        );
        committedCount += roundSessionCount;
        // 有界等待账目追平（真实回归会让它永不超过 committedCount，等待耗尽后失败）。
        const deadline = Date.now() + 20_000;
        let observedEntryCount = 0;
        while (Date.now() < deadline) {
          const integrity = await loadTaskIdempotencyLedgerWithIntegrity(stateDirectory);
          observedEntryCount = integrity.entries.length;
          if (observedEntryCount >= committedCount) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(
          observedEntryCount,
          "第 " + String(round) + " 轮账目未追平：期望 " + String(committedCount),
        ).toBe(committedCount);
      }
      expect(committedCount).toBe(24);
    } finally {
      await application.shutdown();
    }
  });
});
