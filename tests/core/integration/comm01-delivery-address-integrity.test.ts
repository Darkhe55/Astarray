/**
 * COMM-01-02（**2026-10-22 订正**）：投递步骤的**地址完整性**检查。
 *
 * ## 订正说明
 *
 * 首版本文件名为 `comm01-delivery-authorization.test.ts`，断言的是
 * "**非直属上级的下级不得投递**" 与 "上级回收后其下级不得投递"。
 * **那是错误模型下的断言，已整份删除**：
 *
 * - `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54：同项目**主层与次级层默认全连接**；
 * - **反馈不按上下级关系走**，默认走**任务发布者的反向通道**；
 * - 因此"发送者是谁"**不得**成为拒收理由（那会阻断正常路径）。
 *
 * 正确的检查只有一条：**收件人是不是一个已登记的主体**（无绑定记录 ⇒ 直接拒绝）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeliveryWorker } from "../../../packages/core/src/feedback-process/delivery-worker.js";
import type { DeliveryWorkerDependencies } from "../../../packages/core/src/feedback-process/delivery-worker.js";
import type { JournaledMessage } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import type { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import type { AgentStatus, FeedbackMessage } from "../../../packages/core/src/core/types.js";
import {
  AgentAddressGuard,
  AgentCreationRegistry,
} from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";

const MAXIMUM_BACKOFF_SECONDS = 10_800;
const RECIPIENT = "secondary-agent-a";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-address-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

class FakeJournal {
  readonly messages: JournaledMessage[] = [];

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
    const target = this.messages.find((message) => message.messageId === messageId);
    if (target !== undefined) {
      target.delivered = true;
      target.deliveredAtIso = deliveredAtIso;
    }
  }
}

function buildMessage(recipientId: string, messageId: string): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId,
    source: {
      sourceType: "agent",
      agentInstanceId: "child-1",
      agentRole: "tertiary",
    },
    recipientId,
    priority: "success",
    createdAtIso: "2026-10-22T00:00:00.000Z",
    idempotencyKey: "key-" + messageId,
    payload: { kind: "success", summary: "正文不应出现在拒绝理由里" },
  };
}

function buildWorker(options: {
  journal: FakeJournal;
  status?: AgentStatus;
  isRecipientAddressKnown?: (message: JournaledMessage) => Promise<boolean>;
}): { worker: DeliveryWorker; deliverCalls: JournaledMessage[] } {
  const deliverCalls: JournaledMessage[] = [];
  const dependencies: DeliveryWorkerDependencies = {
    journal: options.journal as unknown as MailboxJournal,
    deliverToAgent: async (message: JournaledMessage) => {
      deliverCalls.push(message);
      await options.journal.markDelivered(message.recipientId, message.messageId, "now");
    },
    getRecipientStatus: () => options.status ?? "idle",
    ...(options.isRecipientAddressKnown === undefined
      ? {}
      : { isRecipientAddressKnown: options.isRecipientAddressKnown }),
  };
  return { worker: new DeliveryWorker(dependencies, MAXIMUM_BACKOFF_SECONDS), deliverCalls };
}

describe("COMM-01-02：投递步骤的地址完整性钩子", () => {
  it("① 未注入钩子 ⇒ 行为完全不变（向后兼容）", async () => {
    const journal = new FakeJournal();
    await journal.enqueue(buildMessage(RECIPIENT, "m-1"));
    const { worker, deliverCalls } = buildWorker({ journal });

    const stepResult = await worker.runDeliveryStep(RECIPIENT);

    expect(stepResult.outcome).toBe("delivered");
    expect(deliverCalls).toHaveLength(1);
    expect(journal.messages[0]!.delivered).toBe(true);
  });

  it("② 收件人**无绑定记录** ⇒ 不投递、不标记已投递，消息留在池中且理由不含正文", async () => {
    const journal = new FakeJournal();
    await journal.enqueue(buildMessage("never-created", "m-2"));
    const { worker, deliverCalls } = buildWorker({
      journal,
      isRecipientAddressKnown: async () => false,
    });

    const stepResult = await worker.runDeliveryStep("never-created");

    expect(stepResult.outcome).toBe("recipient-not-a-known-agent");
    expect(deliverCalls).toHaveLength(0);
    expect(journal.messages[0]!.delivered).toBe(false);
    expect(journal.messages[0]!.deliveredAtIso).toBeNull();
    expect(journal.messages).toHaveLength(1);
    const reason =
      stepResult.outcome === "recipient-not-a-known-agent" ? stepResult.reason : "";
    expect(reason).not.toContain("正文不应出现");
  });

  it("③ 真实 AgentCreationRegistry 端到端：已登记可投、未登记被拒", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });
    await registry.registerCreatedAgent({
      agentInstanceId: RECIPIENT,
      createdByAgentInstanceId: "main-agent-1",
    });
    const hook = async (message: JournaledMessage): Promise<boolean> =>
      await guard.isDeliverableRecipient(message.recipientId);

    // 已登记 ⇒ 投递
    const knownJournal = new FakeJournal();
    await knownJournal.enqueue(buildMessage(RECIPIENT, "m-3"));
    const known = buildWorker({
      journal: knownJournal,
      isRecipientAddressKnown: hook,
    });
    await expect(known.worker.runDeliveryStep(RECIPIENT)).resolves.toMatchObject({
      outcome: "delivered",
    });
    expect(known.deliverCalls).toHaveLength(1);

    // 未登记 ⇒ 拒收
    const unknownJournal = new FakeJournal();
    await unknownJournal.enqueue(buildMessage("never-created", "m-4"));
    const unknown = buildWorker({
      journal: unknownJournal,
      isRecipientAddressKnown: hook,
    });
    await expect(unknown.worker.runDeliveryStep("never-created")).resolves.toMatchObject({
      outcome: "recipient-not-a-known-agent",
    });
    expect(unknown.deliverCalls).toHaveLength(0);
    expect(unknownJournal.messages[0]!.delivered).toBe(false);
  });

  it("④ **同级/非直属来源不构成拒收理由**（首版错误模型的直接回归）", async () => {
    /**
     * 首版会因"发送者不是该收件人的直属下级"而拒收。按设计清单，
     * 同项目主层与次级层默认全连接、反馈走任务发布者反向通道 ⇒
     * **只要收件人是已登记主体就必须投递**，与发送者是谁无关。
     */
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });
    await registry.registerCreatedAgent({
      agentInstanceId: RECIPIENT,
      createdByAgentInstanceId: "main-agent-1",
    });
    const hook = async (message: JournaledMessage): Promise<boolean> =>
      await guard.isDeliverableRecipient(message.recipientId);

    // 发送者是一个"另一个上级"建出来的三级 Agent —— 与收件人无直属关系
    const journal = new FakeJournal();
    await journal.enqueue({
      ...buildMessage(RECIPIENT, "m-5"),
      source: {
        sourceType: "agent",
        agentInstanceId: "tertiary-of-another-secondary",
        agentRole: "tertiary",
      },
    });
    const { worker, deliverCalls } = buildWorker({
      journal,
      isRecipientAddressKnown: hook,
    });

    await expect(worker.runDeliveryStep(RECIPIENT)).resolves.toMatchObject({
      outcome: "delivered",
    });
    expect(deliverCalls).toHaveLength(1);
  });

  it("⑤ 已回收的收件人 ⇒ 拒收（不再是活跃主体）", async () => {
    const registry = new AgentCreationRegistry({ stateDirectory });
    const guard = new AgentAddressGuard({ registry });
    await registry.registerCreatedAgent({
      agentInstanceId: RECIPIENT,
      createdByAgentInstanceId: "main-agent-1",
    });
    await registry.markRecycled(RECIPIENT);

    const journal = new FakeJournal();
    await journal.enqueue(buildMessage(RECIPIENT, "m-6"));
    const { worker, deliverCalls } = buildWorker({
      journal,
      isRecipientAddressKnown: async (message) =>
        await guard.isDeliverableRecipient(message.recipientId),
    });

    await expect(worker.runDeliveryStep(RECIPIENT)).resolves.toMatchObject({
      outcome: "recipient-not-a-known-agent",
    });
    expect(deliverCalls).toHaveLength(0);
  });
});
