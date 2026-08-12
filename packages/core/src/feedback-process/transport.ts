/**
 * 反馈进程客户端（主进程侧，T04）。
 * 通过 fork IPC 与独立反馈进程通信；实现 FeedbackTransportPort。
 * 投递消息按 idempotencyKey 去重（同一客户端生命周期内）。
 */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import { DomainError } from "../core/errors.js";
import { isProtocolVersionSupported } from "./ipc-protocol.js";
import type { FeedbackIpcMessage } from "./ipc-protocol.js";
import type {
  AgentStatus,
  FeedbackMessage,
  FeedbackTransportPort,
  TransportHealth,
} from "../core/types.js";
import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";

export interface ForkFeedbackClientOptions {
  protocolVersion?: number;
  requestTimeoutMilliseconds?: number;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
};

export class ForkFeedbackClient implements FeedbackTransportPort {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly deliveredIdempotencyKeys = new Set<string>();
  private readonly messageHandlerCallbacks: Array<
    (message: FeedbackMessage) => Promise<void> | void
  > = [];
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private disconnected = false;
  private protocolVersion: number;

  constructor(
    private readonly childProcess: ChildProcess,
    private readonly options: ForkFeedbackClientOptions = {},
  ) {
    this.protocolVersion = options.protocolVersion ?? FEEDBACK_PROTOCOL_VERSION;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** 就绪（收到子进程 ready 且协议版本一致）。 */
  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /** 发送握手消息（由 supervisor 在 fork 后立即调用）。 */
  sendHello(baseDirectory: string, heartbeatTimeoutMilliseconds: number): void {
    this.safeSend({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory,
      heartbeatTimeoutMilliseconds,
    });
  }

  onMessage(
    handler: (message: FeedbackMessage) => Promise<void> | void,
  ): void {
    this.messageHandlerCallbacks.push(handler);
  }

  async enqueue(message: FeedbackMessage): Promise<void> {
    await this.waitUntilReady();
    const requestId = randomUUID();
    await this.requestResponse(
      { type: "enqueue", requestId, message },
      requestId,
    );
  }

  setAgentStatus(recipientId: string, status: AgentStatus): void {
    this.safeSend({
      type: "setAgentStatus",
      recipientId,
      status,
    });
  }

  async queryHealth(): Promise<TransportHealth> {
    const requestId = randomUUID();
    const result = await this.requestResponse(
      { type: "health", requestId },
      requestId,
    );
    const healthResult = result as {
      type: "healthResult";
      health: TransportHealth;
    };
    return healthResult.health;
  }

  async requestReplay(recipientId: string): Promise<number> {
    await this.waitUntilReady();
    const requestId = randomUUID();
    const result = await this.requestResponse(
      { type: "replay", requestId, recipientId },
      requestId,
    );
    const replayResult = result as { type: "replayResult"; replayCount: number };
    return replayResult.replayCount;
  }

  async shutdown(): Promise<void> {
    const requestId = randomUUID();
    try {
      await this.requestResponse(
        { type: "shutdown", requestId },
        requestId,
      );
    } catch {
      // 进程已不可达时视为已关闭
    }
  }

  /** 处理来自子进程的入站消息（由 supervisor 注册）。 */
  handleInboundMessage(message: FeedbackIpcMessage): void {
    switch (message.type) {
      case "ready":
        if (!isProtocolVersionSupported(message.protocolVersion)) {
          this.disconnected = true;
          this.rejectReady?.(
            new DomainError(
              "feedback-protocol-mismatch",
              `协议版本不兼容: 子进程 ${message.protocolVersion}，期望 ${FEEDBACK_PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        this.protocolVersion = message.protocolVersion;
        this.disconnected = false;
        this.resolveReady?.();
        break;
      case "deliver":
        this.handleDelivery(message.message);
        break;
      default:
        this.completeRequest(message);
    }
  }

  isDisconnected(): boolean {
    return this.disconnected;
  }

  getProtocolVersion(): number {
    return this.protocolVersion;
  }

  /** 供测试检查去重键数量。 */
  getDeliveredIdempotencyKeyCount(): number {
    return this.deliveredIdempotencyKeys.size;
  }

  private handleDelivery(message: FeedbackMessage): void {
    if (this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {
      this.safeSend({
        type: "ackDelivered",
        requestId: randomUUID(),
        messageId: message.messageId,
      });
      return;
    }
    this.deliveredIdempotencyKeys.add(message.idempotencyKey);
    const handlerResults = this.messageHandlerCallbacks.map((handler) => {
      try {
        return handler(message);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    void Promise.allSettled(handlerResults).then(() => {
      this.safeSend({
        type: "ackDelivered",
        requestId: randomUUID(),
        messageId: message.messageId,
      });
    });
  }

  private completeRequest(message: FeedbackIpcMessage): void {
    if (!("requestId" in message) || message.requestId === null) {
      return;
    }
    const pending = this.pendingRequests.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeoutHandle);
    if (message.type === "protocolError") {
      pending.reject(
        new DomainError(
          message.errorCode as never,
          message.errorMessage,
        ),
      );
      return;
    }
    pending.resolve(message);
  }

  private requestResponse(
    outboundMessage: FeedbackIpcMessage,
    requestId: string,
  ): Promise<unknown> {
    if (this.disconnected || !this.childProcess.connected) {
      return Promise.reject(
        new DomainError(
          "feedback-process-unavailable",
          "反馈进程 IPC 已断开，无法发送请求",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timeoutMilliseconds =
        this.options.requestTimeoutMilliseconds ?? 5_000;
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new DomainError(
            "feedback-process-unavailable",
            `反馈进程请求超时（${timeoutMilliseconds}ms）`,
          ),
        );
      }, timeoutMilliseconds);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });
      this.safeSend(outboundMessage);
    });
  }

  private safeSend(message: FeedbackIpcMessage): void {
    if (this.childProcess.connected) {
      this.childProcess.send(message);
    } else {
      this.disconnected = true;
    }
  }
}
