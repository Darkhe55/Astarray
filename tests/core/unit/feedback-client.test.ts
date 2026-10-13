/**
 * T04 ForkFeedbackClient 单元测试：使用伪造 ChildProcess 驱动，
 * 覆盖超时、断开、协议不匹配、幂等去重等客户端路径。
 */
import { describe, expect, it, vi } from "vitest";
/*
 * 超时预算（2026-10-13，纵深防御）：本文件使用**子进程**，此前**未设置** `testTimeout`
 * ⇒ 沿用 vitest 默认 **5_000ms**。本批文件隔离实测均远低于该值（本文件最慢单例见
 * docs/reports/FEEDBACK_SHUTDOWN_DUPLICATE_5S_2026-10-13.md §12 的实测表），
 * 但满载争用系数实测约 1.4-3x —— 同类文件已因此出现过 `Test timed out in 5000ms`。
 * 故按仓库既有约定显式给预算（另有 30+ 文件同样用 60_000）；**断言一律不放宽**。
 */
vi.setConfig({ testTimeout: 60_000 });


import type { ChildProcess } from "node:child_process";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import { FEEDBACK_PROTOCOL_VERSION } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import type { FeedbackIpcMessage } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import { ForkFeedbackClient } from "../../../packages/core/src/feedback-process/transport.js";

class FakeChildProcess {
  connected = true;
  sentMessages: FeedbackIpcMessage[] = [];
  messageListeners: Array<(message: FeedbackIpcMessage) => void> = [];
  exitCode: number | null = null;
  signalCode: string | null = null;

  send(message: FeedbackIpcMessage): boolean {
    this.sentMessages.push(message);
    return true;
  }

  on(event: string, listener: (message?: FeedbackIpcMessage) => void): this {
    if (event === "message") {
      this.messageListeners.push(listener);
    }
    return this;
  }

  /** 模拟子进程向父进程发送入站消息。 */
  emitInbound(message: FeedbackIpcMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }
}

/** 模拟 supervisor 的接线：child.on("message") → client.handleInboundMessage。 */
function createWiredClient(
  fakeChild: FakeChildProcess,
  options?: { requestTimeoutMilliseconds?: number },
): ForkFeedbackClient {
  const client = new ForkFeedbackClient(
    fakeChild as unknown as ChildProcess,
    options,
  );
  fakeChild.on("message", (message) => {
    if (message !== undefined) {
      client.handleInboundMessage(message as FeedbackIpcMessage);
    }
  });
  return client;
}

function makeMessage(recipientId: string, key: string): FeedbackMessage {
  return {
    protocolVersion: FEEDBACK_PROTOCOL_VERSION,
    messageId: `a3f7e2c1-9f0b-4a1c-8d2e-6b5a4c3d2e1${key.length}`,
    source: {
      sourceType: "agent",
      agentInstanceId: `instance-client-${key}`,
      agentRole: "tertiary",
    },
    recipientId,
    priority: "success",
    createdAtIso: "2026-08-12T10:00:00.000Z",
    idempotencyKey: key,
    payload: { kind: "success", summary: `消息 ${key}` },
  };
}

describe("ForkFeedbackClient", () => {
  it("ready 协议版本一致后 waitUntilReady 解析", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    const readyPromise = client.waitUntilReady();
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await expect(readyPromise).resolves.toBeUndefined();
    expect(client.isDisconnected()).toBe(false);
  });

  it("ready 协议版本不兼容时 waitUntilReady 拒绝", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    const readyPromise = client.waitUntilReady();
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION + 5,
      processPid: 99,
    });
    await expect(readyPromise).rejects.toMatchObject({
      errorCode: "feedback-protocol-mismatch",
    });
  });

  it("IPC 断开时 enqueue 直接拒绝且不发送", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    fakeChild.connected = false;
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();
    await expect(
      client.enqueue(makeMessage("scheduler-1", "key-disconnected")),
    ).rejects.toMatchObject({ errorCode: "feedback-process-unavailable" });
  });

  it("请求超时：无应答时拒绝 feedback-process-unavailable", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild, {
      requestTimeoutMilliseconds: 50,
    });
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();
    await expect(client.queryHealth()).rejects.toMatchObject({
      errorCode: "feedback-process-unavailable",
    });
  });

  it("重复 shutdown 不等于重复等待：第二次必须立即返回（子进程已退出，不会有第二次应答）", async () => {
    const fakeChild = new FakeChildProcess();
    const requestTimeoutMilliseconds = 200;
    const client = createWiredClient(fakeChild, { requestTimeoutMilliseconds });
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();

    // 第一次 shutdown：子进程正常应答 shutdownComplete。
    const firstShutdown = client.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const shutdownRequest = fakeChild.sentMessages.find(
      (message) => message.type === "shutdown",
    );
    expect(shutdownRequest?.type).toBe("shutdown");
    fakeChild.emitInbound({
      type: "shutdownComplete",
      requestId: (shutdownRequest as { requestId: string }).requestId,
    });
    await firstShutdown;

    // 子进程已 process.exit，第二次请求**不可能**再收到应答。
    // 若客户端仍发出新请求并等待，就会白等到请求超时（生产默认 5s）。
    const startedAtMilliseconds = Date.now();
    await client.shutdown();
    const elapsedMilliseconds = Date.now() - startedAtMilliseconds;
    expect(elapsedMilliseconds).toBeLessThan(requestTimeoutMilliseconds / 2);
    const shutdownRequestCount = fakeChild.sentMessages.filter(
      (message) => message.type === "shutdown",
    ).length;
    expect(shutdownRequestCount).toBe(1);
  });

  it("enqueue 请求收到 enqueued 应答后解析", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();
    const enqueuePromise = client.enqueue(makeMessage("scheduler-1", "key-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const enqueueRequest = fakeChild.sentMessages.find(
      (message) => message.type === "enqueue",
    );
    expect(enqueueRequest?.type).toBe("enqueue");
    fakeChild.emitInbound({
      type: "enqueued",
      requestId: (enqueueRequest as { requestId: string }).requestId,
      accepted: true,
    });
    await expect(enqueuePromise).resolves.toBeUndefined();
  });

  it("同 idempotencyKey 重复投递只调用 handler 一次并自动 ack", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    const handlerCalls: FeedbackMessage[] = [];
    client.onMessage((message) => {
      handlerCalls.push(message);
    });
    const message = makeMessage("scheduler-1", "key-duplicate");
    client.handleInboundMessage({ type: "deliver", message });
    client.handleInboundMessage({ type: "deliver", message });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlerCalls).toHaveLength(1);
    const ackMessages = fakeChild.sentMessages.filter(
      (candidate) => candidate.type === "ackDelivered",
    );
    expect(ackMessages.length).toBeGreaterThanOrEqual(2);
    expect(client.getDeliveredIdempotencyKeyCount()).toBe(1);
  });

  it("handler 抛错时仍自动 ack（投递已完成，错误由 Agent 侧上报）", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    client.onMessage(() => {
      throw new Error("handler 内部错误");
    });
    const message = makeMessage("scheduler-1", "key-throw");
    client.handleInboundMessage({ type: "deliver", message });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ackMessages = fakeChild.sentMessages.filter(
      (candidate) => candidate.type === "ackDelivered",
    );
    expect(ackMessages.length).toBe(1);
  });

  it("protocolError 应答使请求拒绝", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();
    const healthPromise = client.queryHealth();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const healthRequest = fakeChild.sentMessages.find(
      (message) => message.type === "health",
    );
    fakeChild.emitInbound({
      type: "protocolError",
      requestId: (healthRequest as { requestId: string }).requestId,
      errorCode: "journal-corrupted",
      errorMessage: "journal 损坏",
    });
    await expect(healthPromise).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("无 requestId 的应答被忽略（不崩溃）", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    fakeChild.emitInbound({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: 99,
    });
    await client.waitUntilReady();
    expect(() => {
      fakeChild.emitInbound({ type: "enqueued" } as never);
    }).not.toThrow();
  });

  it("IPC 断开后 safeSend 标记 disconnected（投递去重仍安全）", async () => {
    const fakeChild = new FakeChildProcess();
    const client = createWiredClient(fakeChild);
    fakeChild.connected = false;
    const message = makeMessage("scheduler-1", "key-offline");
    expect(() => {
      client.handleInboundMessage({ type: "deliver", message });
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.isDisconnected()).toBe(true);
  });
});
