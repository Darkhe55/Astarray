/**
 * 投递调度器（T04，ADR-0002/ADR-0003）。
 * 以单步（runDeliveryStep）为粒度设计，便于虚拟时钟与确定性测试；
 * 无限循环由入口进程持有真实定时器驱动。
 */
import {
  DEFAULT_BACKOFF_RESET_SECONDS,
} from "../core/types.js";
import type { AgentStatus } from "../core/types.js";
import type { JournaledMessage } from "./mailbox-journal.js";
import type { MailboxJournal } from "./mailbox-journal.js";
import { calculatePrimeBackoffSeconds } from "./prime-backoff.js";

export type DeliveryStepOutcome =
  | { outcome: "nothing-to-deliver"; waitSeconds: number }
  | { outcome: "recipient-busy"; waitSeconds: number; busyAttemptNumber: number }
  | {
      outcome: "delivered";
      waitSeconds: number;
      messageId: string;
    };

export interface DeliveryWorkerDependencies {
  journal: MailboxJournal;
  /** 将消息投递给接收者（IPC deliver 通知）。resolve 后由 ack 机制最终消费。 */
  deliverToAgent(message: JournaledMessage): Promise<void>;
  getRecipientStatus(recipientId: string): AgentStatus;
}

export class DeliveryWorker {
  private readonly busyAttemptCounters = new Map<string, number>();

  constructor(
    private readonly dependencies: DeliveryWorkerDependencies,
    private readonly maximumBackoffSeconds: number,
  ) {}

  /** 重置退避到首轮（新消息入池 / 接收者变空闲 / 重连成功时调用）。 */
  resetBackoff(recipientId: string): void {
    this.busyAttemptCounters.delete(recipientId);
  }

  getBusyAttemptNumber(recipientId: string): number {
    return this.busyAttemptCounters.get(recipientId) ?? 0;
  }

  async runDeliveryStep(recipientId: string): Promise<DeliveryStepOutcome> {
    const nextMessage = await this.dependencies.journal.peekNext(recipientId);
    if (nextMessage === null) {
      return {
        outcome: "nothing-to-deliver",
        waitSeconds: DEFAULT_BACKOFF_RESET_SECONDS,
      };
    }
    const recipientStatus = this.dependencies.getRecipientStatus(recipientId);
    if (recipientStatus !== "idle") {
      const busyAttemptNumber = this.getBusyAttemptNumber(recipientId) + 1;
      this.busyAttemptCounters.set(recipientId, busyAttemptNumber);
      return {
        outcome: "recipient-busy",
        waitSeconds: calculatePrimeBackoffSeconds(
          busyAttemptNumber,
          this.maximumBackoffSeconds,
        ),
        busyAttemptNumber,
      };
    }
    this.busyAttemptCounters.delete(recipientId);
    await this.dependencies.deliverToAgent(nextMessage);
    return {
      outcome: "delivered",
      waitSeconds: DEFAULT_BACKOFF_RESET_SECONDS,
      messageId: nextMessage.messageId,
    };
  }
}
