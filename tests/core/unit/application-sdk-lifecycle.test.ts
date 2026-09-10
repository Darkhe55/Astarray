/**
 * T07D-R1-01：公共应用创建与生命周期（行为反例 → 实现）。
 * 验收：隔离消费者只从包 exports 创建应用；无会话/错误会话/已关闭会话明确失败；
 * mock 保持离线可用；accepted 不得提前发 task-finished。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AstarrayApplicationFacade,
  PublicApplicationError,
} from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r1-01-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createApplication() {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
  });
}

describe("T07D-R1-01：应用创建与会话生命周期", () => {
  it("create() 从公共入口创建应用并开启会话；shutdown 回收运行资源", async () => {
    const application = await createApplication();
    expect(application.isClosed).toBe(false);

    const session = application.createSession({ sessionId: "session-1", mode: "assist" });
    expect(session).toEqual({ sessionId: "session-1", mode: "assist", status: "idle" });
    expect(application.openSession("session-1")).toEqual(session);
    expect(application.listSessions()).toHaveLength(1);

    await application.shutdown();
    expect(application.isClosed).toBe(true);
    expect(application.listSessions()).toHaveLength(0);
  });

  it("无会话提交明确失败（session-not-found）", async () => {
    const application = await createApplication();
    await expect(
      application.submitTask({ sessionId: "missing", taskIdentifier: "t1", prompt: "x" }),
    ).rejects.toMatchObject({ errorCode: "session-not-found" });
    expect(() => application.openSession("missing")).toThrow(PublicApplicationError);
    await application.shutdown();
  });

  it("重复会话 ID 与跨会话任务访问明确失败", async () => {
    const application = await createApplication();
    application.createSession({ sessionId: "session-1", mode: "assist" });
    expect(() =>
      application.createSession({ sessionId: "session-1", mode: "assist" }),
    ).toThrow(/已存在/);

    application.createSession({ sessionId: "session-2", mode: "assist" });
    const accepted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "INT00 probe",
    });
    expect(accepted.taskIdentifier).toBe("task-1");
    expect(accepted.status).toBe("accepted");
    expect(accepted.missionIdentifier).not.toBeNull();

    // accepted 不得提前发 task-finished
    const finishedEvents: string[] = [];
    const subscription = application.subscribe((event) => {
      if (event.eventType === "task-finished") {
        finishedEvents.push(event.taskIdentifier);
      }
    });
    await expect(
      application.queryTask({ sessionId: "session-2", taskIdentifier: "task-1" }),
    ).rejects.toMatchObject({ errorCode: "session-mismatch" });
    expect(finishedEvents).toHaveLength(0);
    subscription.unsubscribe();

    const queried = await application.queryTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
    });
    expect(["running", "done", "blocked", "cancelled"]).toContain(queried.status);
    await application.shutdown();
  });

  it("关闭后一切操作明确失败（application-closed）", async () => {
    const application = await createApplication();
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.shutdown();

    expect(() =>
      application.createSession({ sessionId: "session-2", mode: "assist" }),
    ).toThrow(/已关闭/);
    await expect(
      application.submitTask({ sessionId: "session-1", taskIdentifier: "t1", prompt: "x" }),
    ).rejects.toMatchObject({ errorCode: "application-closed" });
    expect(() => application.openSession("session-1")).toThrow(/已关闭/);
  });

  it("runtime 非 mock 在 T07D-R1 阶段明确拒绝（Provider 属 T07D-R2）", async () => {
    await expect(
      AstarrayApplicationFacade.create({
        stateDirectory,
        mode: "assist",
        runtime: "openai-compatible" as never,
      }),
    ).rejects.toMatchObject({ errorCode: "runtime-unsupported" });
  });
});
