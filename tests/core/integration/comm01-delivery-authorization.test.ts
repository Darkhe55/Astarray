/**
 * COMM-01-02（2026-10-20）：按地址投递授权必须接在**真实投递路径**上。
 *
 * 上一轮只做到"入口可达"（`dist` 里能 import），本轮把它接到
 * `DeliveryWorker` —— 即独立反馈进程真正用来投递消息的那个步骤
 * （`entrypoint.ts` 构造它并调用 `runDeliveryStep`）。
 *
 * 钉住的语义：
 *  ① 未注入钩子 ⇒ 行为**完全不变**（向后兼容，避免接线意外拦截存量消息）；
 *  ② 钩子拒绝 ⇒ **不调用 deliverToAgent、不标记已投递**，消息**留在池中**（不丢）；
 *     并如实回报 `source-not-authorized`，理由**不含消息正文**；
 *  ③ 钩子放行 ⇒ 正常投递；
 *  ④ 用**真实 `ParentBindingController`** 做端到端：
 *     唯一上级规则在真实投递步骤上生效 —— 非直属下级的消息不得投递；
 *  ⑤ 上级被回收后，其下级消息同样不得投递（回收后不再放行新投递）。
 *
 * 虚拟时钟，无真实 sleep；不联网、不用凭据。
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
  ParentBindingController,
  ParentBindingStore,
} from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";

const MAXIMUM_BACKOFF_SECONDS = 10_800;
const RECIPIENT = "secondary-agent-a";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-deliver-"));
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

function buildMessage(sourceAgentInstanceId: string, messageId: string): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId,
    source: {
      sourceType: "agent",
      agentInstanceId: sourceAgentInstanceId,
      agentRole: "tertiary",
    },
    recipientId: RECIPIENT,
    priority: "success",
    createdAtIso: "2026-10-20T00:00:00.000Z",
    idempotencyKey: "key-" + messageId,
    payload: { kind: "success", summary: "正文不应出现在拒绝理由里" },
  };
}

function buildWorker(options: {
  journal: FakeJournal;
  status?: AgentStatus;
  isDeliverySourceAuthorized?: (message: JournaledMessage) => Promise<boolean>;
}): { worker: DeliveryWorker; deliverCalls: JournaledMessage[] } {
  const deliverCalls: JournaledMessage[] = [];
  const dependencies: DeliveryWorkerDependencies = {
    journal: options.journal as unknown as MailboxJournal,
    deliverToAgent: async (message: JournaledMessage) => {
      deliverCalls.push(message);
      await options.journal.markDelivered(RECIPIENT, message.messageId, "now");
    },
    getRecipientStatus: () => options.status ?? "idle",
    ...(options.isDeliverySourceAuthorized === undefined
      ? {}
      : { isDeliverySourceAuthorized: options.isDeliverySourceAuthorized }),
  };
  return { worker: new DeliveryWorker(dependencies, MAXIMUM_BACKOFF_SECONDS), deliverCalls };
}

describe("COMM-01-02：投递步骤的按地址授权钩子", () => {
  it("① 未注入钩子 ⇒ 行为完全不变（向后兼容）", async () => {
    const journal = new FakeJournal();
    await journal.enqueue(buildMessage("child-1", "m-1"));
    const { worker, deliverCalls } = buildWorker({ journal });

    const stepResult = await worker.runDeliveryStep(RECIPIENT);

    expect(stepResult.outcome).toBe("delivered");
    expect(deliverCalls).toHaveLength(1);
    expect(journal.messages[0]!.delivered).toBe(true);
  });

  it("② 钩子拒绝 ⇒ 不投递、不标记已投递，消息**留在池中**且理由不含正文", async () => {
    const journal = new FakeJournal();
    await journal.enqueue(buildMessage("intruder", "m-2"));
    const { worker, deliverCalls } = buildWorker({
      journal,
      isDeliverySourceAuthorized: async () => false,
    });

    const stepResult = await worker.runDeliveryStep(RECIPIENT);

    expect(stepResult.outcome).toBe("source-not-authorized");
    // 关键：没有投递、也没有被标记成"已投递"（否则消息会被当成处理完而丢失）
    expect(deliverCalls).toHaveLength(0);
    expect(journal.messages[0]!.delivered).toBe(false);
    expect(journal.messages[0]!.deliveredAtIso).toBeNull();
    // 消息仍在池中
    expect(journal.messages).toHaveLength(1);
    // 理由不得泄露消息正文
    const reason = stepResult.outcome === "source-not-authorized" ? stepResult.reason : "";
    expect(reason).not.toContain("正文不应出现");
  });

  it("③ 钩子放行 ⇒ 正常投递", async () => {
    const journal = new FakeJournal();
    await journal.enqueue(buildMessage("child-1", "m-3"));
    const { worker, deliverCalls } = buildWorker({
      journal,
      isDeliverySourceAuthorized: async () => true,
    });

    const stepResult = await worker.runDeliveryStep(RECIPIENT);

    expect(stepResult.outcome).toBe("delivered");
    expect(deliverCalls).toHaveLength(1);
  });

  it("④ 真实 ParentBindingController 端到端：非直属下级不得投递", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    // 把 child-1 绑给 RECIPIENT；child-2 绑给别的上级
    await controller.bindChildToParent({
      childAgentInstanceId: "child-1",
      parentAgentInstanceId: RECIPIENT,
    });
    await controller.bindChildToParent({
      childAgentInstanceId: "child-2",
      parentAgentInstanceId: "secondary-agent-other",
    });

    const authorizeUsingBindings = async (message: JournaledMessage): Promise<boolean> => {
      if (message.source.sourceType !== "agent") {
        return false;
      }
      const parentOfSource = await controller.resolveParentOf(message.source.agentInstanceId);
      return parentOfSource === message.recipientId;
    };

    // 直属下级 ⇒ 投递
    const journalAllowed = new FakeJournal();
    await journalAllowed.enqueue(buildMessage("child-1", "m-4"));
    const allowed = buildWorker({
      journal: journalAllowed,
      isDeliverySourceAuthorized: authorizeUsingBindings,
    });
    const allowedStep = await allowed.worker.runDeliveryStep(RECIPIENT);
    expect(allowedStep.outcome).toBe("delivered");
    expect(allowed.deliverCalls).toHaveLength(1);

    // 别人的下级 ⇒ 拒绝
    const journalRejected = new FakeJournal();
    await journalRejected.enqueue(buildMessage("child-2", "m-5"));
    const rejected = buildWorker({
      journal: journalRejected,
      isDeliverySourceAuthorized: authorizeUsingBindings,
    });
    const rejectedStep = await rejected.worker.runDeliveryStep(RECIPIENT);
    expect(rejectedStep.outcome).toBe("source-not-authorized");
    expect(rejected.deliverCalls).toHaveLength(0);
    expect(journalRejected.messages[0]!.delivered).toBe(false);
  });

  it("⑤ 上级被回收 ⇒ 其下级消息同样不得投递", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.bindChildToParent({
      childAgentInstanceId: "child-1",
      parentAgentInstanceId: RECIPIENT,
    });
    const authorizeUsingDelivery = async (message: JournaledMessage): Promise<boolean> => {
      if (message.source.sourceType !== "agent") {
        return false;
      }
      // 用"子→上级"方向的投递判定：来源为子，接收者为该子的唯一上级
      return await controller.isDeliveryAllowed({
        childAgentInstanceId: message.source.agentInstanceId,
        claimedParentAgentInstanceId: message.recipientId,
      });
    };

    const before = buildWorker({
      journal: (() => {
        const journal = new FakeJournal();
        void journal.enqueue(buildMessage("child-1", "m-6"));
        return journal;
      })(),
      isDeliverySourceAuthorized: authorizeUsingDelivery,
    });
    // 回收前可投递（这里只验证判定函数，不重复建 worker）
    await expect(
      authorizeUsingDelivery({
        source: {
          sourceType: "agent",
          agentInstanceId: "child-1",
          agentRole: "tertiary",
        },
        recipientId: RECIPIENT,
      } as JournaledMessage),
    ).resolves.toBe(true);
    void before;

    await controller.markParentRecycled({ parentAgentInstanceId: RECIPIENT });

    const journalAfter = new FakeJournal();
    await journalAfter.enqueue(buildMessage("child-1", "m-7"));
    const after = buildWorker({
      journal: journalAfter,
      isDeliverySourceAuthorized: authorizeUsingDelivery,
    });
    const afterStep = await after.worker.runDeliveryStep(RECIPIENT);
    expect(afterStep.outcome).toBe("source-not-authorized");
    expect(after.deliverCalls).toHaveLength(0);
  });
});
