import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-journal-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

let messageSequence = 0;

function makeMessage(
  recipientId: string,
  priority: FeedbackMessage["priority"],
  kind: FeedbackMessage["payload"]["kind"],
): FeedbackMessage {
  messageSequence += 1;
  return {
    protocolVersion: 1,
    messageId: `00000000-0000-4000-8000-${String(messageSequence).padStart(12, "0")}`,
    source: {
      sourceType: "agent",
      agentInstanceId: `instance-worker-${messageSequence}`,
      agentRole: "tertiary",
    },
    recipientId,
    priority,
    createdAtIso: "2026-08-12T10:00:00.000Z",
    idempotencyKey: `mission-001/${recipientId}/${messageSequence}`,
    payload: {
      kind,
      summary: `消息 ${messageSequence}`,
    } as FeedbackMessage["payload"],
  };
}

describe("MailboxJournal", () => {
  it("enqueue 后 peekNext 返回该消息，countPending 为 1", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "success", "success");
    const enqueuedSequence = await journal.enqueue(message);
    expect(enqueuedSequence).toBe(1);
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      message.messageId,
    );
    expect(await journal.countPending("scheduler-1")).toBe(1);
  });

  it("同优先级严格 FIFO：先入池先被 peek", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const firstMessage = makeMessage("scheduler-1", "success", "success");
    const secondMessage = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(firstMessage);
    await journal.enqueue(secondMessage);
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      firstMessage.messageId,
    );
  });

  it("高优先级可越过低优先级；已投递未确认者优先重放", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const successMessage = makeMessage("scheduler-1", "success", "success");
    const failureMessage = makeMessage("scheduler-1", "failure", "failure");
    const instructionMessage = makeMessage(
      "scheduler-1",
      "instruction",
      "instruction",
    );
    await journal.enqueue(successMessage);
    await journal.enqueue(failureMessage);
    await journal.enqueue(instructionMessage);
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      instructionMessage.messageId,
    );
    await journal.markDelivered(
      "scheduler-1",
      instructionMessage.messageId,
      "2026-08-12T10:01:00.000Z",
    );
    // 已投递未确认优先于未投递（ack 前崩溃重放语义）
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      instructionMessage.messageId,
    );
    await journal.ack("scheduler-1", instructionMessage.messageId);
    // ack 后高优先级 failure 越过 success
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      failureMessage.messageId,
    );
  });

  it("ack 后才消费：markDelivered 后仍待投递，ack 后消失", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(message);
    await journal.markDelivered(
      "scheduler-1",
      message.messageId,
      "2026-08-12T10:01:00.000Z",
    );
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      message.messageId,
    );
    expect(await journal.countPending("scheduler-1")).toBe(1);
    await journal.ack("scheduler-1", message.messageId);
    expect(await journal.peekNext("scheduler-1")).toBeNull();
    expect(await journal.countPending("scheduler-1")).toBe(0);
  });

  it("投递后 ack 前持久化：重开 journal 后仍可重放（重启恢复场景）", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "failure", "failure");
    await journal.enqueue(message);
    await journal.markDelivered(
      "scheduler-1",
      message.messageId,
      "2026-08-12T10:01:00.000Z",
    );

    const reopenedJournal = new MailboxJournal(temporaryDirectory);
    expect((await reopenedJournal.peekNext("scheduler-1"))?.messageId).toBe(
      message.messageId,
    );
  });

  it("已确认（acked）消息不会在重开后重现", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(message);
    await journal.markDelivered(
      "scheduler-1",
      message.messageId,
      "2026-08-12T10:01:00.000Z",
    );
    await journal.ack("scheduler-1", message.messageId);

    const reopenedJournal = new MailboxJournal(temporaryDirectory);
    expect(await reopenedJournal.peekNext("scheduler-1")).toBeNull();
  });

  it("重放优先于未投递消息：已投递未确认先于新消息", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const deliveredMessage = makeMessage("scheduler-1", "success", "success");
    const freshMessage = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(deliveredMessage);
    await journal.enqueue(freshMessage);
    await journal.markDelivered(
      "scheduler-1",
      deliveredMessage.messageId,
      "2026-08-12T10:01:00.000Z",
    );
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      deliveredMessage.messageId,
    );
  });

  it("不同接收者互不影响", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const schedulerMessage = makeMessage("scheduler-1", "failure", "failure");
    const workerMessage = makeMessage("worker-a", "success", "success");
    await journal.enqueue(schedulerMessage);
    await journal.enqueue(workerMessage);
    expect((await journal.peekNext("worker-a"))?.messageId).toBe(
      workerMessage.messageId,
    );
    expect(await journal.countPending("scheduler-1")).toBe(1);
  });

  it("journal 损坏时抛 DomainError journal-corrupted，不静默覆盖", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    await journal.enqueue(makeMessage("scheduler-1", "success", "success"));
    const journalFilePath = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
      "scheduler-1.json",
    );
    await fs.writeFile(journalFilePath, "损坏内容", "utf8");
    await expect(journal.peekNext("scheduler-1")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("主文件损坏但备份完好时恢复", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(message);
    const journalFilePath = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
      "scheduler-1.json",
    );
    await fs.copyFile(journalFilePath, `${journalFilePath}.bak`);
    await fs.writeFile(journalFilePath, "损坏内容", "utf8");
    expect((await journal.peekNext("scheduler-1"))?.messageId).toBe(
      message.messageId,
    );
  });

  it("不存在的接收者 peekNext 为 null", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    expect(await journal.peekNext("ghost-recipient")).toBeNull();
  });

  it("ack/markDelivered 不存在的消息为无操作", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    const message = makeMessage("scheduler-1", "success", "success");
    await journal.enqueue(message);
    await journal.markDelivered(
      "scheduler-1",
      "00000000-0000-4000-8000-00000000ffff",
      "2026-08-12T10:01:00.000Z",
    );
    await journal.ack(
      "scheduler-1",
      "00000000-0000-4000-8000-00000000ffff",
    );
    expect(await journal.countPending("scheduler-1")).toBe(1);
    await journal.ack("ghost-recipient", message.messageId);
    expect(await journal.countPending("scheduler-1")).toBe(1);
  });

  it("listRecipientIds 只列出存在 journal 的接收者", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    await journal.enqueue(makeMessage("scheduler-1", "success", "success"));
    await journal.enqueue(makeMessage("worker-a", "success", "success"));
    const recipientIds = await journal.listRecipientIds();
    expect(recipientIds.sort()).toEqual(["scheduler-1", "worker-a"]);
  });

  it("JSON 合法但结构非法的 journal 抛 journal-corrupted", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    await journal.enqueue(makeMessage("scheduler-1", "success", "success"));
    const journalFilePath = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
      "scheduler-1.json",
    );
    await fs.writeFile(
      journalFilePath,
      JSON.stringify({ schemaVersion: 1, messages: "不是数组" }),
      "utf8",
    );
    await expect(journal.peekNext("scheduler-1")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("条目结构非法的 journal 抛 journal-corrupted", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    await journal.enqueue(makeMessage("scheduler-1", "success", "success"));
    const journalFilePath = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
      "scheduler-1.json",
    );
    const validDocument = JSON.parse(
      await fs.readFile(journalFilePath, "utf8"),
    ) as { messages: unknown[] };
    validDocument.messages = [{ 垃圾条目: true }];
    await fs.writeFile(journalFilePath, JSON.stringify(validDocument), "utf8");
    await expect(journal.peekNext("scheduler-1")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("listRecipientIds 排除 .bak 备份文件", async () => {
    const journal = new MailboxJournal(temporaryDirectory);
    await journal.enqueue(makeMessage("scheduler-1", "success", "success"));
    const mailboxesDirectory = path.join(
      temporaryDirectory,
      "feedback",
      "mailboxes",
    );
    const journalFilePath = path.join(mailboxesDirectory, "scheduler-1.json");
    await fs.copyFile(journalFilePath, `${journalFilePath}.bak`);
    const recipientIds = await journal.listRecipientIds();
    expect(recipientIds).toEqual(["scheduler-1"]);
  });
});
