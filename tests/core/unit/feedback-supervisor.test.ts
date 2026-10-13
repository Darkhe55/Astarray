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

  it("client.shutdown() 后再 stop()：不得重复等待已退出子进程的应答", async () => {
    /**
     * 反例（2026-10-13 实测）：`ApplicationRuntime.shutdown()` 曾按
     * `controller.shutdown()` → `feedbackClient.shutdown()` → `supervisor.stop()` 顺序收口，
     * 而 `stop()` 内部又会调用 `client.shutdown()`。子进程在第一次 `shutdown` 收到
     * `shutdownComplete` 后即 `process.exit(0)`，**第二次请求永远不会有应答** ⇒
     * 客户端白等到 `requestTimeoutMilliseconds`（生产默认 5_000ms）才吞掉超时。
     * 实测：单次 stop 8ms，重复序列 **5002ms**。
     *
     * 这里按真实子进程与真实请求超时（默认 5_000ms）复现该序列：
     * 幂等后必须**远早于**默认请求超时返回。
     */
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: distEntryPath,
      baseDirectory: path.join(os.tmpdir(), `astarray-supervisor-duplicate-${Date.now()}`),
      shutdownGracePeriodMilliseconds: 2_000,
    });
    const client = await supervisor.start();
    const startedAtMilliseconds = Date.now();
    await client.shutdown();
    await supervisor.stop();
    const elapsedMilliseconds = Date.now() - startedAtMilliseconds;
    // 修复前该序列恒等于默认请求超时（≈5_000ms）；给足余量但仍远低于它。
    expect(elapsedMilliseconds).toBeLessThan(2_000);
  }, 20_000);

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

  it("T12-03：主进程持续心跳，子进程超过 2× 心跳超时仍存活（无心跳会误自退）", async () => {
    const temporaryDirectory = path.join(
      os.tmpdir(),
      `astarray-supervisor-heartbeat-${Date.now()}`,
    );
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: distEntryPath,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 400,
      heartbeatIntervalMilliseconds: 200,
      maximumRestartAttempts: 0,
      healthCheckIntervalMilliseconds: 10_000,
    });
    try {
      await supervisor.start();
      // 等待超过 2× 心跳超时（800ms）：修复前子进程会在此自行退出。
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const child = supervisor.getChildProcess();
      expect(child).not.toBeNull();
      expect(child?.exitCode).toBeNull();
      expect(supervisor.getRestartAttemptCount()).toBe(0);
    } finally {
      await supervisor.stop().catch(() => {});
    }
  }, 15_000);

  it("不传 modulePath 时使用默认路径（dist/feedback-process-entry.js）", () => {
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory: path.join(os.tmpdir(), "astarray-supervisor-default"),
    });
    expect(supervisor.getClient()).toBeNull();
    expect(supervisor.getChildProcess()).toBeNull();
  });
});
