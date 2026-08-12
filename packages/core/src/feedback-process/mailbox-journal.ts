/**
 * 持久化 mailbox journal（T04）。
 * 每个接收者一个 journal 文件；投递成功并收到 ack 后才从未投递集合消费。
 * 写入使用原子替换；损坏时走备份恢复，绝不静默覆盖。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import {
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import type { FeedbackMessage } from "../core/types.js";
import { MESSAGE_PRIORITY_ORDER } from "../core/types.js";

export interface JournaledMessage extends FeedbackMessage {
  /** 入池序号：同优先级 FIFO 的依据。 */
  enqueuedSequence: number;
  delivered: boolean;
  deliveredAtIso: string | null;
}

export interface MailboxJournalDocument {
  schemaVersion: 1;
  recipientId: string;
  nextSequence: number;
  messages: JournaledMessage[];
}

export const MAILBOX_JOURNAL_SCHEMA_VERSION = 1;

function priorityRank(priority: FeedbackMessage["priority"]): number {
  return MESSAGE_PRIORITY_ORDER.indexOf(priority);
}

export class MailboxJournal {
  private readonly journalDirectoryPath: string;

  constructor(baseDirectory: string) {
    this.journalDirectoryPath = path.join(baseDirectory, "feedback", "mailboxes");
  }

  private journalFilePath(recipientId: string): string {
    return path.join(this.journalDirectoryPath, `${recipientId}.json`);
  }

  private backupFilePath(recipientId: string): string {
    return path.join(
      this.journalDirectoryPath,
      `${recipientId}.json.bak`,
    );
  }

  async loadDocument(
    recipientId: string,
  ): Promise<MailboxJournalDocument | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.journalFilePath(recipientId),
      this.backupFilePath(recipientId),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = parseJournalDocument(readResult.content);
    if (parsed === null) {
      throw new DomainError(
        "journal-corrupted",
        `mailbox journal 内容非法: ${recipientId}`,
      );
    }
    return parsed;
  }

  async enqueue(message: FeedbackMessage): Promise<number> {
    const recipientId = message.recipientId;
    const document = (await this.loadDocument(recipientId)) ?? {
      schemaVersion: MAILBOX_JOURNAL_SCHEMA_VERSION,
      recipientId,
      nextSequence: 1,
      messages: [],
    };
    const journaledMessage: JournaledMessage = {
      ...message,
      enqueuedSequence: document.nextSequence,
      delivered: false,
      deliveredAtIso: null,
    };
    document.messages.push(journaledMessage);
    document.nextSequence += 1;
    await this.saveDocument(document);
    return journaledMessage.enqueuedSequence;
  }

  /**
   * 下一条待投递/待重放消息：
   * 1) 已投递未确认（重放优先，保证重启后 ack 前崩溃的消息先恢复）；
   * 2) 从未投递的消息。
   * 各自内部按（优先级, 入池序号）排序：优先级高者在前，同优先级 FIFO。
   */
  async peekNext(recipientId: string): Promise<JournaledMessage | null> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return null;
    }
    const undeliveredMessages = document.messages
      .filter((message) => !message.delivered)
      .sort(compareByPriorityThenSequence);
    const unackedMessages = document.messages
      .filter((message) => message.delivered)
      .sort(compareByPriorityThenSequence);
    return unackedMessages[0] ?? undeliveredMessages[0] ?? null;
  }

  async markDelivered(
    recipientId: string,
    messageId: string,
    deliveredAtIso: string,
  ): Promise<void> {
    await this.mutateRecipient(recipientId, (message) => {
      message.delivered = true;
      message.deliveredAtIso = deliveredAtIso;
    }, messageId);
  }

  async ack(recipientId: string, messageId: string): Promise<void> {
    const document = (await this.loadDocument(recipientId)) ?? null;
    if (document === null) {
      return;
    }
    const remainingMessages = document.messages.filter(
      (message) => message.messageId !== messageId,
    );
    if (remainingMessages.length === document.messages.length) {
      return;
    }
    document.messages = remainingMessages;
    await this.saveDocument(document);
  }

  async countPending(recipientId: string): Promise<number> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return 0;
    }
    return document.messages.length;
  }

  async listRecipientIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.journalDirectoryPath);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".json.bak"))
      .map((entry) => entry.slice(0, -".json".length));
  }

  private async mutateRecipient(
    recipientId: string,
    mutation: (message: JournaledMessage) => void,
    messageId: string,
  ): Promise<void> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return;
    }
    const targetMessage = document.messages.find(
      (message) => message.messageId === messageId,
    );
    if (targetMessage === undefined) {
      return;
    }
    mutation(targetMessage);
    await this.saveDocument(document);
  }

  private async saveDocument(document: MailboxJournalDocument): Promise<void> {
    const filePath = this.journalFilePath(document.recipientId);
    await writeAtomicJson(filePath, document);
  }
}

function compareByPriorityThenSequence(
  left: JournaledMessage,
  right: JournaledMessage,
): number {
  const priorityDifference =
    priorityRank(left.priority) - priorityRank(right.priority);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  return left.enqueuedSequence - right.enqueuedSequence;
}

function parseJournalDocument(content: unknown): MailboxJournalDocument | null {
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const candidate = content as Partial<MailboxJournalDocument>;
  if (
    candidate.schemaVersion !== MAILBOX_JOURNAL_SCHEMA_VERSION ||
    typeof candidate.recipientId !== "string" ||
    typeof candidate.nextSequence !== "number" ||
    !Array.isArray(candidate.messages)
  ) {
    return null;
  }
  const isValidMessageList = candidate.messages.every(isValidJournaledMessage);
  if (!isValidMessageList) {
    return null;
  }
  return {
    schemaVersion: MAILBOX_JOURNAL_SCHEMA_VERSION,
    recipientId: candidate.recipientId,
    nextSequence: candidate.nextSequence,
    messages: candidate.messages,
  };
}

function isValidJournaledMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<JournaledMessage>;
  return (
    typeof candidate.messageId === "string" &&
    typeof candidate.recipientId === "string" &&
    typeof candidate.enqueuedSequence === "number" &&
    typeof candidate.delivered === "boolean" &&
    (candidate.deliveredAtIso === null ||
      typeof candidate.deliveredAtIso === "string")
  );
}
