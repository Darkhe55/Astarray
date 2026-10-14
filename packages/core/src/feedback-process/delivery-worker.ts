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
  /**
   * COMM-01-02：收件人**不是一个已登记的主体**（无绑定记录）⇒ 不投递。
   * 语义是**地址完整性**，不是"通信授权"（见下方钩子说明）。
   */
  | { outcome: "recipient-not-a-known-agent"; waitSeconds: number; messageId: string; reason: string }
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
   * COMM-01-02（2026-10-20 加入；**2026-10-22 订正语义**）：按地址投递的
   * **地址完整性**钩子（可选）。
   *
   * **订正说明**：首版把该钩子描述为"按地址投递**授权**（唯一上级出口，
   * 须为已绑定的直属下级）" —— **那是错的**。依 `docs/AGENT_COMMUNICATION_OVERVIEW.md`
   * §35–54 与用户澄清：
   *  - 同项目**主层与次级层默认全连接**，不逐边申请通信授权；
   *  - **反馈不按上下级关系走**，默认走**任务发布者的反向通道**；
   *  - **绑定记录**是创建时由**创建工具自动登记**的来源事实，**不是通信授权**。
   *
   * ⇒ 本钩子只回答"**收件人是不是一个已登记的主体**"：
   *  - 返回 `true` ⇒ 允许投递；
   *  - 返回 `false` ⇒ **拒绝投递**，消息**保留在池中**（不删除、不标已投递），
   *    如实回报 `recipient-not-a-known-agent`；
   *  - **不得**用它去做"发送者是否为直属上级"之类的判定 —— 那会**阻断**
   *    同项目主↔次级的默认可达（功能性破坏）。
   *
   * **未注入时行为完全不变**（向后兼容）。
   */
  isRecipientAddressKnown?(message: JournaledMessage): Promise<boolean>;
}

/** 钩子拒绝时的可读理由（不含消息正文，避免把内容写进投递状态）。 */
const RECIPIENT_NOT_KNOWN_REASON =
  "收件人不是已登记的 Agent 主体（无绑定记录 ⇒ 直接拒绝；属地址完整性，非通信授权）";

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
     * COMM-01-02（2026-10-22 订正）：投递前先做**地址完整性**检查（仅在注入钩子时）
     * —— 收件人必须是**已登记的主体**（有绑定记录）。
     * 拒绝时**不调用 `deliverToAgent`、不标记已投递** ⇒ 消息留在池中，
     * 由上层决定后续处置；绝不以"投递失败"名义把消息丢掉。
     *
     * **刻意不做**"发送者是否为直属上级"判定：同项目主层与次级层默认可达、
     * 反馈走任务发布者反向通道，用创建来源去卡通信会阻断正常路径。
     */
    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {
        return {
          outcome: "recipient-not-a-known-agent",
          waitSeconds: DEFAULT_BACKOFF_RESET_SECONDS,
          messageId: nextMessage.messageId,
          reason: RECIPIENT_NOT_KNOWN_REASON,
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
