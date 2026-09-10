/**
 * AR-07 批次 6：反馈进程监管器（FeedbackProcessSupervisor）分支补测。
 * 沙箱禁止真实 fork（spawn EPERM），因此在测试内 mock
 * node:child_process.fork 与 ForkFeedbackClient，覆盖启动/健康检查/重启退避/
 * 上限停止/心跳/优雅关闭与孤儿清理等全部分支。
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

vi.mock("../../../packages/core/src/feedback-process/transport.js", () => {
  class FakeFeedbackClient {
    static instances: FakeFeedbackClient[] = [];
    readonly waitUntilReady = vi.fn(async () => {});
    readonly shutdown = vi.fn(async () => {});
    readonly onMessage = vi.fn();
    readonly sendHello = vi.fn();
    readonly sendHeartbeat = vi.fn();
    readonly handleInboundMessage = vi.fn();
    readonly requestReplay = vi.fn(async () => 0);
    readonly isDisconnected = vi.fn(() => false);
    readonly queryHealth = vi.fn(async () => ({
      isHealthy: true,
      processPid: 1,
      protocolVersion: 1,
      queuedMessageCount: 0,
    }));
    constructor(readonly childProcess: unknown) {
      FakeFeedbackClient.instances.push(this);
    }
  }
  return { ForkFeedbackClient: FakeFeedbackClient };
});

import { fork } from "node:child_process";
import { ForkFeedbackClient } from "../../../packages/core/src/feedback-process/transport.js";
import { FeedbackProcessSupervisor } from "../../../packages/core/src/feedback-process/process-supervisor.js";

type FakeClient = InstanceType<typeof ForkFeedbackClient> & {
  waitUntilReady: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
  sendHello: ReturnType<typeof vi.fn>;
  sendHeartbeat: ReturnType<typeof vi.fn>;
  handleInboundMessage: ReturnType<typeof vi.fn>;
  requestReplay: ReturnType<typeof vi.fn>;
  isDisconnected: ReturnType<typeof vi.fn>;
  queryHealth: ReturnType<typeof vi.fn>;
};

class FakeChildProcess extends EventEmitter {
  connected = true;
  pid = 4_242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly send = vi.fn();
  readonly kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

const forkMock = fork as unknown as ReturnType<typeof vi.fn>;
const clientInstances = () =>
  (ForkFeedbackClient as unknown as { instances: FakeClient[] }).instances;

function latestClient(): FakeClient {
  const clients = clientInstances();
  return clients[clients.length - 1]!;
}

function spawnSequence(supervisor: FeedbackProcessSupervisor) {
  return { supervisor, child: forkMock.mock.results.at(-1)?.value as FakeChildProcess };
}

beforeEach(() => {
  vi.useFakeTimers();
  forkMock.mockReset();
  clientInstances().length = 0;
  forkMock.mockImplementation(() => new FakeChildProcess());
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AR-07 批次6：FeedbackProcessSupervisor 分支", () => {
  it("start 使用默认配置、注册处理器并启动心跳/健康检查", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
    });
    const handler = vi.fn();
    supervisor.onMessage(handler); // client 为 null → 仅入队
    await supervisor.start();
    const client = latestClient();
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.sendHello).toHaveBeenCalledWith("state", 30_000);
    expect(supervisor.getClient()).toBe(client);
    expect(supervisor.getChildProcess()).not.toBeNull();
    expect(supervisor.getRestartAttemptCount()).toBe(0);

    // 再注册：client 非空 → 立刻转发
    supervisor.onMessage(handler);
    expect(client.onMessage).toHaveBeenCalledTimes(2);

    // 心跳循环
    client.sendHeartbeat.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.sendHeartbeat).toHaveBeenCalled();

    // 健康检查循环（连通）
    client.queryHealth.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.queryHealth).toHaveBeenCalled();

    // 子进程入站消息转发
    spawnSequence(supervisor).child.emit("message", { type: "ready", protocolVersion: 1 });
    expect(client.handleInboundMessage).toHaveBeenCalled();

    // 优雅关闭：shutdown + 等待退出
    const stopPromise = supervisor.stop();
    await vi.advanceTimersByTimeAsync(1);
    spawnSequence(supervisor).child.emit("exit", 0, null);
    await stopPromise;
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(supervisor.getClient()).toBeNull();
    expect(supervisor.getChildProcess()).toBeNull();

    // client/child 均为 null 时重复 stop 安全
    await supervisor.stop();
  });

  it("显式覆盖所有超时/退避/上限配置", () => {
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory: "state",
      shutdownGracePeriodMilliseconds: 10,
      healthCheckIntervalMilliseconds: 20,
      restartBackoffMilliseconds: 30,
      maximumRestartAttempts: 2,
      heartbeatTimeoutMilliseconds: 40,
      heartbeatIntervalMilliseconds: 50,
    });
    expect(supervisor).toBeInstanceOf(FeedbackProcessSupervisor);
  });

  it("心跳超时较小时取最小 1000ms 间隔（默认公式分支）", () => {
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory: "state",
      heartbeatTimeoutMilliseconds: 400,
    });
    expect(supervisor).toBeInstanceOf(FeedbackProcessSupervisor);
  });

  it("错误事件触发重启退避；关闭中不再重启", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 100,
      maximumRestartAttempts: 3,
    });
    await supervisor.start();
    const firstChild = spawnSequence(supervisor).child;
    firstChild.exitCode = null;
    firstChild.emit("error", new Error("ipc failure"));
    expect(supervisor.getRestartAttemptCount()).toBe(1);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");

    // 退避后自动重启
    await vi.advanceTimersByTimeAsync(100);
    expect(forkMock).toHaveBeenCalledTimes(2);

    // 关闭中再触发错误 → 直接返回
    const shuttingDownSupervisor = supervisor as unknown as { isShuttingDown: boolean };
    shuttingDownSupervisor.isShuttingDown = true;
    const secondChild = spawnSequence(supervisor).child;
    secondChild.emit("error", new Error("late failure"));
    expect(supervisor.getRestartAttemptCount()).toBe(1);
  });

  it("退避定时器在关闭中不重启", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 100,
      maximumRestartAttempts: 3,
    });
    await supervisor.start();
    spawnSequence(supervisor).child.emit("error", new Error("boom"));
    (supervisor as unknown as { isShuttingDown: boolean }).isShuttingDown = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it("重启次数超过上限后停止循环", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 0,
    });
    await supervisor.start();
    const child = spawnSequence(supervisor).child;
    child.emit("error", new Error("fatal"));
    expect(supervisor.getRestartAttemptCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it("exit 事件在关闭中忽略；非关闭时按失败处理", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    (supervisor as unknown as { isShuttingDown: boolean }).isShuttingDown = true;
    spawnSequence(supervisor).child.emit("exit", 1, null);
    expect(supervisor.getRestartAttemptCount()).toBe(0);
    (supervisor as unknown as { isShuttingDown: boolean }).isShuttingDown = false;
    spawnSequence(supervisor).child.emit("exit", null, "SIGTERM");
    expect(supervisor.getRestartAttemptCount()).toBe(1);
  });

  it("心跳循环在 client 为空时跳过", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 5_000,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    const client = latestClient();
    spawnSequence(supervisor).child.emit("error", new Error("gone"));
    expect(supervisor.getClient()).toBeNull();
    client.sendHeartbeat.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.sendHeartbeat).not.toHaveBeenCalled();
  });

  it("健康检查发现断开或查询失败时触发重启", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      healthCheckIntervalMilliseconds: 50,
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 1,
    });
    await supervisor.start();
    const client = latestClient();
    client.isDisconnected.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(supervisor.getRestartAttemptCount()).toBe(1);

    // 允许一次重启后，改为查询失败路径
    await vi.advanceTimersByTimeAsync(10);
    const restarted = latestClient();
    restarted.queryHealth.mockRejectedValue(new Error("timeout"));
    await vi.advanceTimersByTimeAsync(50);
    expect(supervisor.getRestartAttemptCount()).toBeGreaterThan(1);
  });

  it("异常子进程尚未退出时被强制终止，且在宽限期后清理", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      shutdownGracePeriodMilliseconds: 30,
    });
    await supervisor.start();
    const child = spawnSequence(supervisor).child;
    const stopPromise = supervisor.stop();
    await vi.advanceTimersByTimeAsync(1);
    // 未收到 exit → 宽限期超时后 SIGKILL
    await vi.advanceTimersByTimeAsync(30);
    await stopPromise;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("waitForProcessExit 在子进程已退出时直接返回", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
    });
    await supervisor.start();
    const child = spawnSequence(supervisor).child;
    child.exitCode = 0;
    await supervisor.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("过期子进程的 error/exit 事件被忽略", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    const firstChild = spawnSequence(supervisor).child;
    firstChild.emit("error", new Error("first failure"));
    await vi.advanceTimersByTimeAsync(10);
    const secondChild = spawnSequence(supervisor).child;
    expect(secondChild).not.toBe(firstChild);

    firstChild.emit("error", new Error("stale error"));
    firstChild.emit("exit", 0, null);
    expect(supervisor.getRestartAttemptCount()).toBe(1);
  });

  it("已退出子进程的 error 不再触发 kill", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    const child = spawnSequence(supervisor).child;
    child.exitCode = 7;
    child.emit("error", new Error("post-exit error"));
    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.getRestartAttemptCount()).toBe(1);
  });

  it("退出码与信号均非空时按失败处理", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      restartBackoffMilliseconds: 10,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    spawnSequence(supervisor).child.emit("exit", 3, "SIGKILL");
    expect(supervisor.getRestartAttemptCount()).toBe(1);
  });

  it("心跳与健康检查在 client 为空时跳过", async () => {
    const supervisor = new FeedbackProcessSupervisor({
      modulePath: "entry.js",
      baseDirectory: "state",
      heartbeatIntervalMilliseconds: 10,
      healthCheckIntervalMilliseconds: 10,
      restartBackoffMilliseconds: 100_000,
      maximumRestartAttempts: 5,
    });
    await supervisor.start();
    const client = latestClient();
    spawnSequence(supervisor).child.emit("error", new Error("client gone"));
    expect(supervisor.getClient()).toBeNull();
    client.sendHeartbeat.mockClear();
    client.queryHealth.mockClear();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.sendHeartbeat).not.toHaveBeenCalled();
    expect(client.queryHealth).not.toHaveBeenCalled();
  });
});
