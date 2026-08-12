import { describe, expect, it } from "vitest";

import { DeliveryWorker } from "../../../packages/core/src/feedback-process/delivery-worker.js";
import type { DeliveryWorkerDependencies } from "../../../packages/core/src/feedback-process/delivery-worker.js";
import type { JournaledMessage } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import type { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import type { AgentStatus, FeedbackMessage } from "../../../packages/core/src/core/types.js";

const MAXIMUM_BACKOFF_SECONDS = 10_800;

class FakeJournal {
  private readonly messages: JournaledMessage[] = [];

  async enqueue(message: FeedbackMessage): Promise<void> {
    this.messages.push({
      ...message,
      enqueuedSequence: this.messages.length + 1,
      delivered: false,
      deliveredAtIso: null,
    });
  }

  async peekNext(_recipientId: string): Promise<JournaledMessage | null> {
    return this.messages[0] ?? null;
  }

  async markDelivered(
    _recipientId: string,
    messageId: string,
    deliveredAtIso: string,
  ): Promise<void> {
    const targetMessage = this.messages.find(
      (message) => message.messageId === messageId,
    );
    if (targetMessage !== undefined) {
      targetMessage.delivered = true;
      targetMessage.deliveredAtIso = deliveredAtIso;
    }
  }

  async ack(_recipientId: string, messageId: string): Promise<void> {
    const messageIndex = this.messages.findIndex(
      (message) => message.messageId === messageId,
    );
    if (messageIndex >= 0) {
      this.messages.splice(messageIndex, 1);
    }
  }
}

function buildWorker(
  status: AgentStatus,
  deliveredMessageIds: string[] = [],
  journal: MailboxJournal = new FakeJournal() as unknown as MailboxJournal,
): { worker: DeliveryWorker; deliverCalls: JournaledMessage[] } {
  const deliverCalls: JournaledMessage[] = [];
  const dependencies: DeliveryWorkerDependencies = {
    journal,
    deliverToAgent: async (message: JournaledMessage) => {
      deliverCalls.push(message);
      deliveredMessageIds.push(message.messageId);
    },
    getRecipientStatus: () => status,
  };
  return { worker: new DeliveryWorker(dependencies, MAXIMUM_BACKOFF_SECONDS), deliverCalls };
}

function buildJournalWithOneMessage(): FakeJournal {
  const journal = new FakeJournal();
  void journal.enqueue({
    protocolVersion: 1,
    messageId: "00000000-0000-4000-8000-000000000001",
    source: {
      sourceType: "agent",
      agentInstanceId: "instance-worker-a",
      agentRole: "tertiary",
    },
    recipientId: "scheduler-1",
    priority: "success",
    createdAtIso: "2026-08-12T10:00:00.000Z",
    idempotencyKey: "key-1",
    payload: { kind: "success", summary: "第一条" },
  });
  return journal;
}

describe("DeliveryWorker（虚拟时钟，无真实 sleep）", () => {
  it("空池：无投递，等待基础间隔 2 秒", async () => {
    const { worker } = buildWorker("idle");
    const stepResult = await worker.runDeliveryStep("scheduler-1");
    expect(stepResult).toEqual({
      outcome: "nothing-to-deliver",
      waitSeconds: 2,
    });
  });

  it("空闲时投递最旧消息，投递后退避重置", async () => {
    const journal = new FakeJournal();
    await journal.enqueue({
      protocolVersion: 1,
      messageId: "00000000-0000-4000-8000-000000000001",
      source: {
        sourceType: "agent",
        agentInstanceId: "instance-worker-a",
        agentRole: "tertiary",
      },
      recipientId: "scheduler-1",
      priority: "success",
      createdAtIso: "2026-08-12T10:00:00.000Z",
      idempotencyKey: "key-1",
      payload: { kind: "success", summary: "第一条" },
    });
    const { worker, deliverCalls } = buildWorker("idle", [], journal as unknown as MailboxJournal);
    const stepResult = await worker.runDeliveryStep("scheduler-1");
    expect(stepResult.outcome).toBe("delivered");
    expect(deliverCalls).toHaveLength(1);
    expect(worker.getBusyAttemptNumber("scheduler-1")).toBe(0);
  });

  it("忙碌时按质数序列递增等待：2 → 3 → 5 → 7 → 11", async () => {
    const { worker } = buildWorker("busy", [], buildJournalWithOneMessage() as unknown as MailboxJournal);
    const waitSeconds: number[] = [];
    for (let round = 0; round < 5; round++) {
      const stepResult = await worker.runDeliveryStep("scheduler-1");
      expect(stepResult.outcome).toBe("recipient-busy");
      waitSeconds.push((stepResult as { waitSeconds: number }).waitSeconds);
    }
    expect(waitSeconds).toEqual([2, 3, 5, 7, 11]);
  });

  it("忙碌达到上限后等待值稳定在 10,800 秒", async () => {
    const { worker } = buildWorker("busy", [], buildJournalWithOneMessage() as unknown as MailboxJournal);
    let lastWaitSeconds = 0;
    for (let round = 0; round < 2000; round++) {
      const stepResult = await worker.runDeliveryStep("scheduler-1");
      lastWaitSeconds = (stepResult as { waitSeconds: number }).waitSeconds;
    }
    expect(lastWaitSeconds).toBe(10_800);
  });

  it("新消息入池后重置退避到首轮（resetBackoff）", async () => {
    const { worker } = buildWorker("busy", [], buildJournalWithOneMessage() as unknown as MailboxJournal);
    for (let round = 0; round < 3; round++) {
      await worker.runDeliveryStep("scheduler-1");
    }
    expect(worker.getBusyAttemptNumber("scheduler-1")).toBe(3);
    worker.resetBackoff("scheduler-1");
    expect(worker.getBusyAttemptNumber("scheduler-1")).toBe(0);
    const resetStep = await worker.runDeliveryStep("scheduler-1");
    expect((resetStep as { waitSeconds: number }).waitSeconds).toBe(2);
  });

  it("接收者由忙碌转空闲后投递成功且退避清零", async () => {
    const journal = new FakeJournal();
    await journal.enqueue({
      protocolVersion: 1,
      messageId: "00000000-0000-4000-8000-000000000001",
      source: {
        sourceType: "agent",
        agentInstanceId: "instance-worker-a",
        agentRole: "tertiary",
      },
      recipientId: "scheduler-1",
      priority: "success",
      createdAtIso: "2026-08-12T10:00:00.000Z",
      idempotencyKey: "key-1",
      payload: { kind: "success", summary: "第一条" },
    });
    let currentStatus: AgentStatus = "busy";
    const deliverCalls: JournaledMessage[] = [];
    const worker = new DeliveryWorker(
      {
        journal: journal as unknown as MailboxJournal,
        deliverToAgent: async (message) => {
          deliverCalls.push(message);
        },
        getRecipientStatus: () => currentStatus,
      },
      MAXIMUM_BACKOFF_SECONDS,
    );
    await worker.runDeliveryStep("scheduler-1");
    expect(worker.getBusyAttemptNumber("scheduler-1")).toBe(1);

    currentStatus = "idle";
    const stepResult = await worker.runDeliveryStep("scheduler-1");
    expect(stepResult.outcome).toBe("delivered");
    expect(deliverCalls).toHaveLength(1);
    expect(worker.getBusyAttemptNumber("scheduler-1")).toBe(0);
  });

  it("blocked 状态同样视为忙碌，不投递", async () => {
    const { worker, deliverCalls } = buildWorker("blocked", [], buildJournalWithOneMessage() as unknown as MailboxJournal);
    const stepResult = await worker.runDeliveryStep("scheduler-1");
    expect(stepResult.outcome).toBe("recipient-busy");
    expect(deliverCalls).toHaveLength(0);
  });
});
