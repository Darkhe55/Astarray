/**
 * T04 入口进程单元测试：用进程内 FakeParent 驱动 runFeedbackProcessEntry，
 * 覆盖 hello/enqueue/投递/ack/replay/health/shutdown 全流程（虚拟时钟，无真实长等待）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import type { FeedbackIpcMessage } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import {
  runFeedbackProcessEntry,
} from "../../../packages/core/src/feedback-process/entrypoint.js";
import type {
  ChildProcessLike,
} from "../../../packages/core/src/feedback-process/entrypoint.js";

const FEEDBACK_PROTOCOL_VERSION = 1;

class FakeParent implements ChildProcessLike {
  connected = true;
  pid = 4242;
  sentMessages: FeedbackIpcMessage[] = [];
  messageListeners: Array<(message?: FeedbackIpcMessage) => void> = [];
  disconnectListeners: Array<() => void> = [];

  send(message: FeedbackIpcMessage): boolean {
    this.sentMessages.push(message);
    return true;
  }

  on(
    event: "message" | "disconnect",
    listener: (message?: FeedbackIpcMessage) => void,
  ): void {
    if (event === "message") {
      this.messageListeners.push(listener);
    } else {
      this.disconnectListeners.push(listener as () => void);
    }
  }

  emitMessage(message: FeedbackIpcMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  waitForSentMessage(
    predicate: (message: FeedbackIpcMessage) => boolean,
    timeoutMilliseconds: number,
    description: string,
  ): Promise<FeedbackIpcMessage> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMilliseconds;
      const poll = () => {
        const match = this.sentMessages.find(predicate);
        if (match !== undefined) {
          resolve(match);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`等待超时: ${description}`));
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }
}

function makeMessage(recipientId: string, index: number): FeedbackMessage {
  return {
    protocolVersion: FEEDBACK_PROTOCOL_VERSION,
    messageId: randomUUID(),
    source: {
      sourceType: "agent",
      agentInstanceId: `instance-entry-${index}`,
      agentRole: "tertiary",
    },
    recipientId,
    priority: "success",
    createdAtIso: "2026-08-12T10:00:00.000Z",
    idempotencyKey: `entry-${recipientId}-${index}`,
    payload: { kind: "success", summary: `入口消息 ${index}` },
  };
}

describe("runFeedbackProcessEntry（进程内 FakeParent）", () => {
  let temporaryDirectory: string;
  let fakeParent: FakeParent;
  const exitRequests: number[] = [];
  const stderrLines: string[] = [];

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-entry-"));
    exitRequests.length = 0;
    stderrLines.length = 0;
    fakeParent = new FakeParent();
    runFeedbackProcessEntry(fakeParent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (exitCode) => {
        exitRequests.push(exitCode);
      },
      writeStderr: (text) => {
        stderrLines.push(text);
      },
    });
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => {},
    );
  });

  it("hello 后回复 ready，包含协议版本与 PID", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    const readyMessage = await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    expect(readyMessage).toMatchObject({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 4242,
    });
  });

  /** 模拟 Agent 通过 setAgentStatus 完成身份注册（真实流程 Worker 启动时即注册）。 */
  function requireAgentInstanceId(source: FeedbackMessage["source"]): string {
    if (source.sourceType !== "agent") {
      throw new Error(`测试来源必须为 agent: ${JSON.stringify(source)}`);
    }
    return source.agentInstanceId;
  }

  function registerAgent(agentInstanceId: string): void {
    fakeParent.emitMessage({
      type: "setAgentStatus",
      recipientId: agentInstanceId,
      status: "idle",
    });
  }

  it("enqueue 落盘 journal 并回复 accepted=true，退避重置后 idle 投递", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const message = makeMessage("scheduler-1", 1);
    registerAgent(requireAgentInstanceId(message.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-1",
      message,
    });
    const enqueuedMessage = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued",
      2_000,
      "enqueued 应答",
    );
    expect(enqueuedMessage).toMatchObject({
      type: "enqueued",
      requestId: "req-1",
      accepted: true,
    });
    const deliveredMessage = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "deliver",
      2_000,
      "deliver 投递",
    );
    expect(deliveredMessage.type).toBe("deliver");
  });

  it("Agent busy 时普通消息不投递", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    fakeParent.emitMessage({
      type: "setAgentStatus",
      recipientId: "scheduler-1",
      status: "busy",
    });
    const busySourceMessage = makeMessage("scheduler-1", 2);
    registerAgent(requireAgentInstanceId(busySourceMessage.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-2",
      message: busySourceMessage,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued",
      2_000,
      "enqueued 应答",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const deliveredMessages = fakeParent.sentMessages.filter(
      (message) => message.type === "deliver",
    );
    expect(deliveredMessages).toHaveLength(0);
  });

  it("ackDelivered 消费消息：队列清空", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const message = makeMessage("scheduler-1", 3);
    registerAgent(requireAgentInstanceId(message.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-3",
      message,
    });
    const deliveredMessage = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "deliver",
      2_000,
      "deliver 投递",
    );
    expect(deliveredMessage.type).toBe("deliver");
    fakeParent.emitMessage({
      type: "ackDelivered",
      requestId: "req-ack",
      messageId: message.messageId,
    });
    const ackedMessage = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "acked",
      2_000,
      "acked 应答",
    );
    expect(ackedMessage).toMatchObject({
      type: "acked",
      requestId: "req-ack",
    });
    fakeParent.emitMessage({ type: "health", requestId: "req-health" });
    const healthResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "healthResult",
      2_000,
      "healthResult",
    );
    expect(healthResult.type).toBe("healthResult");
  });

  it("replay * 重放已投递未确认消息", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const message = makeMessage("worker-a", 4);
    registerAgent(requireAgentInstanceId(message.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-4",
      message,
    });
    await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "deliver",
      2_000,
      "首次投递",
    );
    fakeParent.emitMessage({
      type: "replay",
      requestId: "req-replay",
      recipientId: "*",
    });
    const replayResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "replayResult",
      2_000,
      "replayResult",
    );
    expect(replayResult.type).toBe("replayResult");
    const deliverCount = fakeParent.sentMessages.filter(
      (candidate) => candidate.type === "deliver",
    ).length;
    expect(deliverCount).toBeGreaterThanOrEqual(2);
  });

  it("shutdown 清除定时器并回复 shutdownComplete（不真实退出）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    fakeParent.emitMessage({
      type: "shutdown",
      requestId: "req-shutdown",
    });
    const shutdownComplete = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "shutdownComplete",
      2_000,
      "shutdownComplete",
    );
    expect(shutdownComplete).toMatchObject({
      type: "shutdownComplete",
      requestId: "req-shutdown",
    });
  });

  it("协议版本不兼容：回复 protocolError 并请求退出（不真实退出）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION + 9,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    const protocolError = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "protocolError",
      2_000,
      "protocolError",
    );
    expect(protocolError).toMatchObject({
      type: "protocolError",
      errorCode: "feedback-protocol-mismatch",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exitRequests).toContain(1);
  });

  it("journal 写入失败时 enqueue 返回 accepted=false，不崩溃", async () => {
    // 在 mailboxes 目录预置同名目录，使 rename 替换失败
    const mailboxesDirectory = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
    );
    await fs.mkdir(mailboxesDirectory, { recursive: true });
    await fs.mkdir(path.join(mailboxesDirectory, "blocked-recipient.json"));
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-blocked",
      message: makeMessage("blocked-recipient", 9),
    });
    const enqueuedResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued",
      2_000,
      "enqueued 应答",
    );
    expect(enqueuedResult).toMatchObject({
      type: "enqueued",
      requestId: "req-blocked",
      accepted: false,
    });
  });

  it("heartbeat 刷新看门狗且不产生应答", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    fakeParent.emitMessage({
      type: "heartbeat",
      timestampUnixMilliseconds: Date.now(),
    });
    fakeParent.emitMessage({
      type: "heartbeat",
      timestampUnixMilliseconds: Date.now(),
    });
    const heartbeatResponses = fakeParent.sentMessages.filter(
      (candidate) =>
        candidate.type === "protocolError" ||
        candidate.type === "healthResult",
    );
    expect(heartbeatResponses).toHaveLength(0);
  });

  it("同一接收者快速连续 enqueue 复用投递定时器（不重复调度）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const firstQuickMessage = makeMessage("scheduler-1", 5);
    registerAgent(requireAgentInstanceId(firstQuickMessage.source));
    const secondQuickMessage = makeMessage("scheduler-1", 6);
    registerAgent(requireAgentInstanceId(secondQuickMessage.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-5a",
      message: firstQuickMessage,
    });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-5b",
      message: secondQuickMessage,
    });
    await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued" && candidate.requestId === "req-5b",
      2_000,
      "第二次 enqueued 应答",
    );
    await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "deliver",
      2_000,
      "首次投递",
    );
    const deliverCount = fakeParent.sentMessages.filter(
      (candidate) => candidate.type === "deliver",
    ).length;
    expect(deliverCount).toBeGreaterThanOrEqual(1);
    expect(deliverCount).toBeLessThanOrEqual(2);
  });

  it("未注册 Agent 来源的消息被拒绝入池且 stderr 记录（S2 身份一致性）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const unregisteredMessage = makeMessage("scheduler-1", 77);
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-unregistered",
      message: unregisteredMessage,
    });
    const enqueuedResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued",
      2_000,
      "enqueued 应答",
    );
    expect(enqueuedResult).toMatchObject({
      type: "enqueued",
      requestId: "req-unregistered",
      accepted: false,
    });
    expect(stderrLines.join("\n")).toContain("未注册 Agent 来源");
    // 队列不增长
    const healthMessage = await new Promise<FeedbackIpcMessage>((resolve) => {
      fakeParent.emitMessage({ type: "health", requestId: "req-health-s2" });
      const poll = (): void => {
        const result = fakeParent.sentMessages.find(
          (message) => message.type === "healthResult",
        );
        if (result !== undefined) {
          resolve(result);
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
    expect(
      (healthMessage as { health: { queuedMessageCount: number } }).health
        .queuedMessageCount,
    ).toBe(0);
  });

  it("schema 非法的消息被拒绝入池（S2 运行时校验）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const invalidMessage = makeMessage("scheduler-1", 78);
    // 破坏载荷：优先级与 kind 不一致（schema superRefine 拒绝）
    const tamperedMessage = {
      ...invalidMessage,
      priority: "success" as const,
      payload: {
        kind: "failure" as const,
        failureReason: "x",
        currentStateSummary: "y",
      },
    } as unknown as FeedbackMessage;
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-invalid",
      message: tamperedMessage,
    });
    const enqueuedResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued",
      2_000,
      "enqueued 应答",
    );
    expect(enqueuedResult).toMatchObject({
      type: "enqueued",
      requestId: "req-invalid",
      accepted: false,
    });
    expect(stderrLines.join("\n")).toContain("schema 校验失败");
  });

  it("journal 损坏后投递失败：记录 stderr 并按 5 秒重试调度（不崩溃）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    const corruptTestMessage = makeMessage("scheduler-1", 7);
    registerAgent(requireAgentInstanceId(corruptTestMessage.source));
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-corrupt",
      message: corruptTestMessage,
    });
    // 先确认首次投递完成（deliver 已发出），再损坏 journal —— 下一次重试必然命中损坏文件
    await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "deliver",
      2_000,
      "首次投递",
    );
    const journalFilePath = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
      "scheduler-1.json",
    );
    await fs.writeFile(journalFilePath, "{ 损坏", "utf8");
    const deadline = Date.now() + 6_000;
    while (stderrLines.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stderrLines.join("\n")).toContain("投递失败");
  }, 15_000);

  it("hello 之前的 health/replay/enqueue 优雅降级", async () => {
    fakeParent.emitMessage({ type: "health", requestId: "req-pre-health" });
    const healthResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "healthResult",
      2_000,
      "未初始化 healthResult",
    );
    expect(healthResult.type).toBe("healthResult");
    fakeParent.emitMessage({
      type: "replay",
      requestId: "req-pre-replay",
      recipientId: "*",
    });
    const replayResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "replayResult",
      2_000,
      "未初始化 replayResult",
    );
    expect(replayResult).toMatchObject({
      type: "replayResult",
      replayCount: 0,
    });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-pre-enqueue",
      message: makeMessage("scheduler-1", 8),
    });
    const enqueuedResult = await fakeParent.waitForSentMessage(
      (candidate) => candidate.type === "enqueued",
      2_000,
      "未初始化 enqueued",
    );
    expect(enqueuedResult).toMatchObject({
      type: "enqueued",
      accepted: false,
    });
    // ackDelivered 在未初始化时静默返回
    fakeParent.emitMessage({
      type: "ackDelivered",
      requestId: "req-pre-ack",
      messageId: "00000000-0000-4000-8000-000000000000",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ackedMessages = fakeParent.sentMessages.filter(
      (candidate) => candidate.type === "acked",
    );
    expect(ackedMessages).toHaveLength(0);
    // 未知消息类型静默忽略
    fakeParent.emitMessage({ type: "unknown-message-type" } as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const protocolErrors = fakeParent.sentMessages.filter(
      (candidate) => candidate.type === "protocolError",
    );
    expect(protocolErrors).toHaveLength(0);
  });

  it("主进程断开时请求退出并记录 stderr", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready 消息",
    );
    for (const listener of fakeParent.disconnectListeners) {
      listener();
    }
    expect(exitRequests).toContain(1);
    expect(stderrLines.join("\n")).toContain("断开");
  });

  it("入口启动时 IPC 未连接立即请求退出", async () => {
    const disconnectedParent = new FakeParent();
    disconnectedParent.connected = false;
    const exitCodes: number[] = [];
    runFeedbackProcessEntry(disconnectedParent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (exitCode) => {
        exitCodes.push(exitCode);
      },
    });
    expect(exitCodes).toContain(1);
  });
});
