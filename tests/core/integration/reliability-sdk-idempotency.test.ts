/**
 * 行为反例（RELIABILITY-01-02 · R4，2026-10-02）：
 *
 * 审计（RELIABILITY-01-01 §疑点2）确认 `public-sdk.ts#submitTask` 的 idempotencyKey 存在三个缺口：
 *  ① **并发窗口**：检查与登记之间存在 await → 同会话同键并发提交可双执行；
 *  ② **不持久化**：仅进程内 Map → 重启后同键重复提交会再次执行；
 *  ③ **同键异参未拒绝**：命中即静默复用旧结果（卡内明确要求"同键异参拒绝"）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { parseTaskIdempotencyLedger } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-idem-"));
});

afterEach(async () => {
  try {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

describe("幂等账目解析（容错，不伪造历史）", () => {
  it("schemaVersion 非 1 或 entries 非数组 → 空账目", () => {
    expect(parseTaskIdempotencyLedger("{}")).toEqual([]);
    expect(parseTaskIdempotencyLedger(JSON.stringify({ schemaVersion: 2, entries: [] }))).toEqual([]);
    expect(
      parseTaskIdempotencyLedger(JSON.stringify({ schemaVersion: 1, entries: "not-array" })),
    ).toEqual([]);
    expect(parseTaskIdempotencyLedger("不是 JSON")).toEqual([]);
  });

  it("逐条校验：缺字段/类型非法的条目被跳过，合法条目保留", () => {
    const entries = parseTaskIdempotencyLedger(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          null,
          "字符串条目",
          { sessionIdentifier: "s1", idempotencyKey: "k1" },
          {
            sessionIdentifier: "s1",
            idempotencyKey: "k1",
            inputHash: "h1",
            taskIdentifier: "task-1",
            missionIdentifier: "mission-1",
            claimedAtIso: "2026-10-02T00:00:00.000Z",
            settledAtIso: null,
          },
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.missionIdentifier).toBe("mission-1");
    expect(entries[0]?.settledAtIso).toBeNull();
  });
});

describe("SDK idempotencyKey 语义（R4）", () => {  it("③ 同键异参 → 必须拒绝（不得静默复用旧结果）", async () => {
    const application = await createFacade();
    try {
      await application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "写入 A 文件",
        idempotencyKey: "idem-key-1",
      });
      // 同键、**不同参数**（prompt 不同）：卡内要求拒绝。
      await expect(
        application.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-2",
          prompt: "写入 B 文件（完全不同的参数）",
          idempotencyKey: "idem-key-1",
        }),
      ).rejects.toThrow();
    } finally {
      await application.shutdown();
    }
  });

  it("① 并发同键 → 只允许一次受理（不得双执行）", async () => {
    const application = await createFacade();
    try {
      const results = await Promise.allSettled([
        application.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-a",
          prompt: "同一逻辑任务",
          idempotencyKey: "idem-key-concurrent",
        }),
        application.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-b",
          prompt: "同一逻辑任务",
          idempotencyKey: "idem-key-concurrent",
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      // 允许"第二个复用第一个的结果"（同一 mission），但**不得**产生两个不同 mission。
      const missionIdentifiers = new Set(
        fulfilled.map((result) =>
          (result as PromiseFulfilledResult<{ missionIdentifier: string }>).value
            .missionIdentifier,
        ),
      );
      expect(missionIdentifiers.size).toBe(1);
    } finally {
      await application.shutdown();
    }
  });

  it("② 重启后同键同参 → 必须复用（不得再次执行）", async () => {
    const firstApplication = await createFacade();
    const firstAccepted = await firstApplication.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-restart",
      prompt: "同一逻辑任务",
      idempotencyKey: "idem-key-restart",
    });
    await firstApplication.shutdown();

    // 模拟进程重启：同一状态目录、新 facade、新会话标识。
    const secondApplication = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      statusPollIntervalMilliseconds: 10,
    });
    try {
      secondApplication.createSession({ sessionId: "session-1", mode: "assist" });
      const secondAccepted = await secondApplication.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-restart",
        prompt: "同一逻辑任务",
        idempotencyKey: "idem-key-restart",
      });
      // 必须复用同一 mission（持久化幂等），而不是新建。
      expect(secondAccepted.missionIdentifier).toBe(firstAccepted.missionIdentifier);
    } finally {
      await secondApplication.shutdown();
    }
  });
});
