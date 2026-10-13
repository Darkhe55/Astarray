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
  /** COMM-01-02：来源不是该接收者的合法通信对象 ⇒ 不投递（消息保留在池中，不丢）。 */
  | { outcome: "source-not-authorized"; waitSeconds: number; messageId: string; reason: string }
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
  /**
   * COMM-01-02（2026-10-20）：按地址投递授权**钩子**（可选）。
   *
   * 卡内要求"唯一上级出口"且"**不得要求叶子模型自行判断对象**" ——
   * 故判定必须落在**本地控制面**，本钩子就是把它接到真实投递路径上的缝。
   *
   * 语义约定（由调用方提供实现，通常是 `ParentBindingController` 适配）：
   *  - 返回 `true` ⇒ 允许投递；
   *  - 返回 `false` ⇒ **拒绝投递**，消息**保留在池中**（不删除、不标已投递），
   *    并如实回报 `source-not-authorized`。
   *
   * **未注入时行为完全不变**（向后兼容）—— 这样"接线"可以独立于"改判定"落地，
   * 也避免在尚未接线的路径上意外拦截存量消息。
   */
  isDeliverySourceAuthorized?(message: JournaledMessage): Promise<boolean>;
}

/** 钩子拒绝时的可读理由（不含消息正文，避免把内容写进投递状态）。 */
const SOURCE_NOT_AUTHORIZED_REASON =
  "投递来源不是该接收者的合法通信对象（唯一上级出口：须为已绑定的直属下级）";

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
    /**
     * COMM-01-02：投递前先做**按地址授权**（仅在调用方注入钩子时）。
     * 拒绝时**不调用 `deliverToAgent`、不标记已投递** —— 消息留在池中，
     * 由上层决定是补充授权还是清理；绝不以"投递失败"名义把消息丢掉。
     */
    const isSourceAuthorized = this.dependencies.isDeliverySourceAuthorized;
    if (isSourceAuthorized !== undefined) {
      const isAuthorized = await isSourceAuthorized(nextMessage);
      if (!isAuthorized) {
        return {
          outcome: "source-not-authorized",
          waitSeconds: DEFAULT_BACKOFF_RESET_SECONDS,
          messageId: nextMessage.messageId,
          reason: SOURCE_NOT_AUTHORIZED_REASON,
        };
      }
    }
    await this.dependencies.deliverToAgent(nextMessage);
    return {
      outcome: "delivered",
      waitSeconds: DEFAULT_BACKOFF_RESET_SECONDS,
      messageId: nextMessage.messageId,
    };
  }
}
