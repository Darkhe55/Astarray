/**
 * T04 FeedbackProcessSupervisor 单元测试：
 * 崩溃循环上限、健康检查重启、onMessage 重注册。
 */
import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FeedbackProcessSupervisor } from "../../../packages/core/src/feedback-process/process-supervisor.js";

const distEntryPath = path.join(
  process.cwd(),
  "dist",
  "feedback-process-entry.js",
);
const hasBuiltEntry = existsSync(distEntryPath);

describe.skipIf(!hasBuiltEntry)("FeedbackProcessSupervisor", () => {
  it("modulePath 无效时反复重启直到达到上限并停止", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: path.join(os.tmpdir(), "non-existent-entry.js"),
      baseDirectory: path.join(os.tmpdir(), "astarray-supervisor-test"),
      maximumRestartAttempts: 3,
      restartBackoffMilliseconds: 10,
      healthCheckIntervalMilliseconds: 20,
    });
    await expect(
      Promise.race([
        supervisor.start(),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]),
    ).resolves.toBeUndefined();

    const deadline = Date.now() + 5_000;
    while (
      supervisor.getRestartAttemptCount() <= 3 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(supervisor.getRestartAttemptCount()).toBeGreaterThan(3);
    await supervisor.stop();
  });

  it("健康检查发现断开后触发重启", async () => {
    const temporaryDirectory = path.join(
      os.tmpdir(),
      `astarray-supervisor-health-${Date.now()}`,
    );
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: distEntryPath,
      baseDirectory: temporaryDirectory,
      maximumRestartAttempts: 3,
      restartBackoffMilliseconds: 50,
      healthCheckIntervalMilliseconds: 30,
    });
    const client = await supervisor.start();
    client.onMessage(() => {});
    const originalClient = supervisor.getClient();

    supervisor.getChildProcess()?.kill("SIGKILL");

    const deadline = Date.now() + 5_000;
    while (
      supervisor.getRestartAttemptCount() < 1 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(supervisor.getRestartAttemptCount()).toBeGreaterThanOrEqual(1);
    expect(supervisor.getClient()).not.toBe(originalClient);
    await supervisor.stop();
  });

  it("stop 幂等：多次调用不抛错", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: distEntryPath,
      baseDirectory: path.join(os.tmpdir(), "astarray-supervisor-stop"),
      shutdownGracePeriodMilliseconds: 2_000,
    });
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
  });

  it("不响应的子进程在宽限期后被强制终止", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: path.join(process.cwd(), "tests", "core", "fixtures", "never-exit.mjs"),
      baseDirectory: path.join(os.tmpdir(), "astarray-supervisor-grace"),
      shutdownGracePeriodMilliseconds: 300,
    });
    void supervisor.start().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    await supervisor.stop();
    expect(supervisor.getChildProcess()).toBeNull();
  }, 20_000);

  it("不传 modulePath 时使用默认路径（dist/feedback-process-entry.js）", () => {
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory: path.join(os.tmpdir(), "astarray-supervisor-default"),
    });
    expect(supervisor.getClient()).toBeNull();
    expect(supervisor.getChildProcess()).toBeNull();
  });
});
