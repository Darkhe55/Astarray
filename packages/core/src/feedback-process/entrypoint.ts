/**
 * 独立反馈进程入口（T04，ADR-0001）。
 * 与主进程脱离运行；通过 fork IPC 通信；stdout/stderr 仅诊断日志。
 * 职责：journal 持久化、投递调度（质数退避）、ack 消费、健康检查、优雅关闭、心跳看门狗。
 */
import { DomainError } from "../core/errors.js";
import {
  DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
} from "../core/types.js";
import type { AgentStatus, FeedbackMessage, TransportHealth } from "../core/types.js";
import { feedbackMessageSchema } from "../core/schemas.js";
import { DeliveryWorker } from "./delivery-worker.js";
import type { FeedbackIpcMessage } from "./ipc-protocol.js";
import {
  FEEDBACK_PROTOCOL_VERSION,
  isProtocolVersionSupported,
} from "./ipc-protocol.js";
import { MailboxJournal } from "./mailbox-journal.js";
import type { JournaledMessage } from "./mailbox-journal.js";

export interface ChildProcessLike {
  connected: boolean;
  pid: number | undefined;
  send(
    message: FeedbackIpcMessage,
    sendHandle?: unknown,
    options?: unknown,
    callback?: (error: Error | null) => void,
  ): boolean | undefined;
  on(event: "message" | "disconnect", listener: (message?: FeedbackIpcMessage) => void): void;
}

export interface FeedbackProcessEntryOptions {
  defaultBaseDirectory: string;
  /** 可注入以便测试（默认 process.exit）。 */
  processExit?: (exitCode: number) => void;
  /** 可注入以便测试（默认 process.stderr.write）。 */
  writeStderr?: (text: string) => void;
}

export function runFeedbackProcessEntry(
  parent: ChildProcessLike,
  options: FeedbackProcessEntryOptions,
): void {
  const processExit = options.processExit ?? ((exitCode: number) => process.exit(exitCode));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const statuses = new Map<string, AgentStatus>();
  let journal: MailboxJournal | null = null;
  let deliveryWorker: DeliveryWorker | null = null;
  let heartbeatWatchdog: NodeJS.Timeout | null = null;
  const recipientDeliveryTimers = new Map<string, NodeJS.Timeout>();
  let baseDirectory = options.defaultBaseDirectory;
  let heartbeatTimeoutMilliseconds = 30_000;

  function sendToParent(message: FeedbackIpcMessage): void {
    if (parent.connected) {
      parent.send(message);
    }
  }

  function refreshHeartbeatWatchdog(): void {
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }
    heartbeatWatchdog = setTimeout(() => {
      writeStderr(
        "astarray: 反馈进程未收到主进程心跳，判定主进程失联，自行退出\n",
      );
      processExit(1);
    }, heartbeatTimeoutMilliseconds * 2);
  }

  async function buildHealth(): Promise<TransportHealth> {
    let queuedMessageCount = 0;
    if (journal !== null) {
      for (const recipientId of await journal.listRecipientIds()) {
        queuedMessageCount += await journal.countPending(recipientId);
      }
    }
    return {
      isHealthy: journal !== null,
      processPid: parent.pid ?? process.pid,
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      queuedMessageCount,
    };
  }

  /**
   * 入池前运行时校验（审计 S2）：
   * 1) feedbackMessageSchema 严格校验（来源/优先级/幂等键/载荷一致性）；
   * 2) 身份一致性：Agent 来源的 agentInstanceId 必须已在本进程注册（setAgentStatus 或注册表），
   *    未注册来源一律拒绝入池，防止伪造来源/非法层级/缺失来源进入 journal。
   */
  const registeredAgentInstanceIds = new Set<string>();

  function registerAgentInstanceId(agentInstanceId: string): void {
    registeredAgentInstanceIds.add(agentInstanceId);
  }

  async function handleEnqueue(message: FeedbackMessage): Promise<boolean> {
    if (journal === null || deliveryWorker === null) {
      return false;
    }
    const parsed = feedbackMessageSchema.safeParse(message);
    if (!parsed.success) {
      writeStderr(
        `astarray: 反馈进程拒绝非法消息（schema 校验失败）: ${parsed.error.message}\n`,
      );
      return false;
    }
    const validatedMessage = parsed.data;
    if (
      validatedMessage.source.sourceType === "agent" &&
      !registeredAgentInstanceIds.has(validatedMessage.source.agentInstanceId)
    ) {
      writeStderr(
        `astarray: 反馈进程拒绝未注册 Agent 来源的消息: ${validatedMessage.source.agentInstanceId}\n`,
      );
      return false;
    }
    await journal.enqueue(validatedMessage);
    deliveryWorker.resetBackoff(validatedMessage.recipientId);
    scheduleDeliveryAttempt(validatedMessage.recipientId, 0);
    return true;
  }

  function scheduleDeliveryAttempt(
    recipientId: string,
    delayMilliseconds: number,
  ): void {
    const existingTimer = recipientDeliveryTimers.get(recipientId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      recipientDeliveryTimers.delete(recipientId);
      void runDeliveryStep(recipientId);
    }, delayMilliseconds);
    recipientDeliveryTimers.set(recipientId, timer);
  }

  async function runDeliveryStep(recipientId: string): Promise<void> {
    if (journal === null || deliveryWorker === null) {
      return;
    }
    try {
      const stepResult = await deliveryWorker.runDeliveryStep(recipientId);
      scheduleDeliveryAttempt(recipientId, stepResult.waitSeconds * 1000);
    } catch (error) {
      writeStderr(
        `astarray: 反馈进程投递失败 - ${(error as Error).message}\n`,
      );
      scheduleDeliveryAttempt(recipientId, 5_000);
    }
  }

  async function handleAckDelivered(
    messageId: string,
    requestId: string,
  ): Promise<void> {
    if (journal === null) {
      return;
    }
    for (const recipientId of await journal.listRecipientIds()) {
      await journal.ack(recipientId, messageId);
    }
    sendToParent({ type: "acked", requestId });
  }

  async function handleReplay(
    requestId: string,
    recipientId: string,
  ): Promise<void> {
    if (journal === null) {
      sendToParent({ type: "replayResult", requestId, replayCount: 0 });
      return;
    }
    const recipientIds =
      recipientId === "*"
        ? await journal.listRecipientIds()
        : [recipientId];
    let replayCount = 0;
    for (const targetRecipientId of recipientIds) {
      const nextMessage = await journal.peekNext(targetRecipientId);
      if (nextMessage !== null && nextMessage.delivered) {
        sendToParent({ type: "deliver", message: nextMessage });
        replayCount += 1;
      }
      scheduleDeliveryAttempt(targetRecipientId, 0);
    }
    sendToParent({ type: "replayResult", requestId, replayCount });
  }

  function handleShutdown(requestId: string): void {
    for (const timer of recipientDeliveryTimers.values()) {
      clearTimeout(timer);
    }
    recipientDeliveryTimers.clear();
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }
    sendToParent({ type: "shutdownComplete", requestId });
    setImmediate(() => processExit(0));
  }

  function handleHello(
    message: Extract<FeedbackIpcMessage, { type: "hello" }>,
  ): void {
    if (!isProtocolVersionSupported(message.protocolVersion)) {
      sendToParent({
        type: "protocolError",
        requestId: null,
        errorCode: "feedback-protocol-mismatch",
        errorMessage: `协议版本不兼容: 期望 ${FEEDBACK_PROTOCOL_VERSION}，收到 ${message.protocolVersion}`,
      });
      setTimeout(() => processExit(1), 100);
      return;
    }
    baseDirectory = message.baseDirectory;
    heartbeatTimeoutMilliseconds = message.heartbeatTimeoutMilliseconds;
    try {
      journal = new MailboxJournal(baseDirectory);
      deliveryWorker = new DeliveryWorker(
        {
          journal,
          deliverToAgent: async (journaledMessage: JournaledMessage) => {
            await journal?.markDelivered(
              journaledMessage.recipientId,
              journaledMessage.messageId,
              new Date().toISOString(),
            );
            sendToParent({ type: "deliver", message: journaledMessage });
          },
          getRecipientStatus: (recipientId: string) =>
            statuses.get(recipientId) ?? "idle",
        },
        DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
      );
    } catch (error) {
      sendToParent({
        type: "protocolError",
        requestId: null,
        errorCode:
          error instanceof DomainError ? error.errorCode : "unknown",
        errorMessage: `反馈进程初始化失败: ${(error as Error).message}`,
      });
      processExit(1);
      return;
    }
    refreshHeartbeatWatchdog();
    sendToParent({
      type: "ready",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      processPid: parent.pid ?? process.pid,
    });
  }

  function onMessage(message: FeedbackIpcMessage): void {
    switch (message.type) {
      case "hello":
        handleHello(message);
        break;
      case "enqueue":
        void handleEnqueue(message.message)
          .then((accepted) => {
            sendToParent({
              type: "enqueued",
              requestId: message.requestId,
              accepted,
            });
          })
          .catch(() => {
            sendToParent({
              type: "enqueued",
              requestId: message.requestId,
              accepted: false,
            });
          });
        break;
      case "setAgentStatus":
        statuses.set(message.recipientId, message.status);
        registerAgentInstanceId(message.recipientId);
        break;
      case "ackDelivered":
        void handleAckDelivered(message.messageId, message.requestId);
        break;
      case "health":
        void buildHealth().then((health) => {
          sendToParent({
            type: "healthResult",
            requestId: message.requestId,
            health,
          });
        });
        break;
      case "replay":
        void handleReplay(message.requestId, message.recipientId);
        break;
      case "shutdown":
        handleShutdown(message.requestId);
        break;
      case "heartbeat":
        refreshHeartbeatWatchdog();
        break;
      default:
        break;
    }
  }

  parent.on("message", (message) => {
    if (message !== undefined) {
      onMessage(message as FeedbackIpcMessage);
    }
  });
  parent.on("disconnect", () => {
    writeStderr("astarray: 反馈进程与主进程断开，自行退出\n");
    processExit(1);
  });

  if (!parent.connected) {
    processExit(1);
  }
}

/** 供真实进程引导（child-bootstrap.ts）使用的窄化判断。 */
export function isNodeJsProcess(value: unknown): value is NodeJS.Process {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    "on" in value
  );
}
