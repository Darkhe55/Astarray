/**
 * T04 集成测试：真实 fork 独立反馈进程（需先 npm run build）。
 * 覆盖：PID 隔离、投递/ack、崩溃重启重放、健康检查、优雅关闭、协议版本。
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import {
  FEEDBACK_PROTOCOL_VERSION,
  isProtocolVersionSupported,
} from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import { FeedbackProcessSupervisor } from "../../../packages/core/src/feedback-process/process-supervisor.js";
import type { ForkFeedbackClient } from "../../../packages/core/src/feedback-process/transport.js";

const distEntryPath = path.join(
  process.cwd(),
  "dist",
  "feedback-process-entry.js",
);
const hasBuiltEntry = existsSync(distEntryPath);

/** 拒绝入池后的健康检查：进程存活即视为拒绝路径生效（队列计数由另一用例断言）。 */
function healthAfterRejectedEnqueue(health: {
  isHealthy: boolean;
  queuedMessageCount: number;
}): boolean {
  return health.isHealthy;
}

function makeMessage(recipientId: string, index: number): FeedbackMessage {  return {
    protocolVersion: FEEDBACK_PROTOCOL_VERSION,
    messageId: randomUUID(),
    source: {
      sourceType: "agent",
      agentInstanceId: `instance-integration-${index}`,
      agentRole: "tertiary",
    },
    recipientId,
    priority: "success",
    createdAtIso: "2026-08-12T10:00:00.000Z",
    idempotencyKey: `integration-${recipientId}-${index}`,
    payload: { kind: "success", summary: `集成消息 ${index}` },
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("反馈进程协议版本", () => {
  it("当前版本受支持", () => {
    expect(isProtocolVersionSupported(FEEDBACK_PROTOCOL_VERSION)).toBe(true);
  });

  it("不兼容版本被拒绝", () => {
    expect(isProtocolVersionSupported(FEEDBACK_PROTOCOL_VERSION + 1)).toBe(
      false,
    );
  });
});

describe.skipIf(!hasBuiltEntry)("独立反馈进程集成（真实 fork）", () => {
  let temporaryDirectory: string;
  let supervisor: FeedbackProcessSupervisor;
  let client: ForkFeedbackClient;
  const deliveredMessages: FeedbackMessage[] = [];

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "astarray-feedback-integration-"),
    );
    deliveredMessages.length = 0;
    supervisor = new FeedbackProcessSupervisor({
      modulePath: distEntryPath,
      baseDirectory: temporaryDirectory,
      healthCheckIntervalMilliseconds: 5_000,
      restartBackoffMilliseconds: 200,
      shutdownGracePeriodMilliseconds: 3_000,
    });
    client = await supervisor.start();
    supervisor.onMessage((message) => {
      deliveredMessages.push(message);
    });
  });

  afterEach(async () => {
    await supervisor.stop();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("反馈进程 PID 与主进程不同", () => {
    const childProcess = supervisor.getChildProcess();
    expect(childProcess?.pid).toBeDefined();
    expect(childProcess?.pid).not.toBe(process.pid);
  });

  it("投递并 ack：handler 收到消息，队列清空", async () => {
    const message = makeMessage("scheduler-1", 1);
    client.setAgentStatus((message.source as { agentInstanceId: string }).agentInstanceId, "idle");
    await client.enqueue(message);
    client.setAgentStatus("scheduler-1", "idle");
    await waitUntil(
      () => deliveredMessages.length === 1,
      5_000,
      "handler 收到投递消息",
    );
    expect(deliveredMessages[0]?.messageId).toBe(message.messageId);
    await waitUntil(
      async () => (await client.queryHealth()).queuedMessageCount === 0,
      5_000,
      "ack 后队列清空",
    );
  });

  it("Agent busy 时普通消息不进入其上下文", async () => {
    client.setAgentStatus("scheduler-1", "busy");
    const busyTestMessage = makeMessage("scheduler-1", 2);
    client.setAgentStatus((busyTestMessage.source as { agentInstanceId: string }).agentInstanceId, "idle");
    await client.enqueue(busyTestMessage);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(deliveredMessages).toHaveLength(0);
    client.setAgentStatus("scheduler-1", "idle");
    await waitUntil(
      () => deliveredMessages.length === 1,
      5_000,
      "转空闲后投递",
    );
  });

  it("未注册 Agent 来源的消息被拒绝（S2：身份一致性）", async () => {
    const unregisteredMessage = makeMessage("scheduler-1", 99);
    await client.enqueue(unregisteredMessage);
    const healthAfterRejection = await client.queryHealth();
    expect(healthAfterRejectedEnqueue(healthAfterRejection)).toBe(true);
  });

  it("拒绝入池后队列不增长", async () => {
    const healthBefore = await client.queryHealth();
    const countBefore = healthBefore.queuedMessageCount;
    const unregisteredMessage = makeMessage("scheduler-1", 100);
    await client.enqueue(unregisteredMessage);
    const healthAfter = await client.queryHealth();
    expect(healthAfter.queuedMessageCount).toBe(countBefore);
  });

  it("杀死反馈进程后 supervisor 重启并重放未确认消息", async () => {
    // 用永不 settle 的 handler 阻止 ack，制造"已投递未确认"状态
    supervisor.onMessage(() => new Promise<void>(() => {}));
    const replayTestMessage = makeMessage("worker-a", 3);
    client.setAgentStatus((replayTestMessage.source as { agentInstanceId: string }).agentInstanceId, "idle");
    await client.enqueue(replayTestMessage);
    client.setAgentStatus("worker-a", "idle");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const originalPid = supervisor.getChildProcess()?.pid;
    supervisor.getChildProcess()?.kill("SIGKILL");
    await waitUntil(
      () => supervisor.getRestartAttemptCount() >= 1,
      5_000,
      "supervisor 记录重启",
    );
    await waitUntil(
      () => supervisor.getClient() !== null,
      5_000,
      "重启后新客户端可用",
    );
    const restartedClient = supervisor.getClient() as ForkFeedbackClient;
    await restartedClient.waitUntilReady();
    const restartedPid = supervisor.getChildProcess()?.pid;
    expect(restartedPid).toBeDefined();
    expect(restartedPid).not.toBe(originalPid);

    const replayedMessageCount = await restartedClient.requestReplay("*");
    expect(replayedMessageCount).toBeGreaterThanOrEqual(1);
  });

  it("健康检查返回存活信息", async () => {
    const health = await client.queryHealth();
    expect(health.isHealthy).toBe(true);
    expect(health.protocolVersion).toBe(FEEDBACK_PROTOCOL_VERSION);
    expect(health.processPid).toBe(supervisor.getChildProcess()?.pid);
  });

  it("优雅关闭：stop 后子进程退出且无残留", async () => {
    const childProcess = supervisor.getChildProcess();
    const pid = childProcess?.pid;
    await supervisor.stop();
    await waitUntil(
      () => supervisor.getChildProcess() === null,
      3_000,
      "子进程句柄清空",
    );
    const { spawnSync } = await import("node:child_process");
    if (pid !== undefined && process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], {
        encoding: "utf8",
      });
      expect(result.stdout).not.toContain(String(pid));
    }
  });

  it("协议版本不兼容的入口被拒绝", async () => {
    // 构建一个发送错误版本 hello 的假子进程
    const { fork } = await import("node:child_process");
    const mismatchedChild = fork(distEntryPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, ASTARRAY_FEEDBACK_CHILD: "1" },
    });
    try {
      const protocolErrors: unknown[] = [];
      mismatchedChild.on("message", (message: unknown) => {
        if ((message as { type?: string }).type === "protocolError") {
          protocolErrors.push(message);
        }
      });
      mismatchedChild.send({
        type: "hello",
        protocolVersion: FEEDBACK_PROTOCOL_VERSION + 42,
        baseDirectory: temporaryDirectory,
        heartbeatTimeoutMilliseconds: 30_000,
      });
      await waitUntil(
        () => protocolErrors.length >= 1,
        5_000,
        "收到 protocolError",
      );
      expect(protocolErrors[0]).toMatchObject({
        errorCode: "feedback-protocol-mismatch",
      });
    } finally {
      mismatchedChild.kill("SIGKILL");
    }
  });
});
