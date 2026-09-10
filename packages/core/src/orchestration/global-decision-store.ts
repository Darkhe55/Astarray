/**
 * 全局决策库存储（T09A-03 / ADR-0031 §11.2）。
 * 位置：
 * - <baseDirectory>/global-decisions/records/<globalDecisionIdentifier>.json（不可变记录）
 * - <baseDirectory>/global-decisions/status-events/<eventIdentifier>.json（只追加事件）
 *
 * 保证：
 * - 记录只追加、绝不覆盖；状态变化/替代关系用事件折叠出结论；
 * - schema 校验、内容哈希（sha256:hex）校验、来源校验；
 * - 同 scope 同哈希候选幂等去重；同 scope 不同结论标记 pending-human-review；
 * - supersedes 不删除旧记录，仅追加 superseded 事件；
 * - 损坏文件 fail-closed（journal-corrupted），不静默覆盖。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import {
  GLOBAL_DECISION_RECORD_SCHEMA_VERSION,
  type GlobalDecisionRecord,
  type GlobalDecisionStatus,
  globalDecisionRecordSchema,
} from "./context-closure-schemas.js";

export const GLOBAL_DECISION_STATUS_EVENT_SCHEMA_VERSION = 1;

export const GLOBAL_DECISION_STATUS_EVENT_TYPES = [
  "status-changed",
  "superseded",
] as const;
export type GlobalDecisionStatusEventType =
  (typeof GLOBAL_DECISION_STATUS_EVENT_TYPES)[number];

export const globalDecisionStatusEventSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_DECISION_STATUS_EVENT_SCHEMA_VERSION),
    eventIdentifier: z.string().min(1),
    globalDecisionIdentifier: z.string().min(1),
    eventType: z.enum(GLOBAL_DECISION_STATUS_EVENT_TYPES),
    nextStatus: z.enum([
      "active",
      "pending-human-review",
      "disputed",
      "stale",
      "superseded",
    ]),
    supersededByGlobalDecisionIdentifier: z.string().min(1).optional(),
    reason: z.string().min(1),
    createdAtIso: z.iso.datetime(),
  })
  .strict();
export type GlobalDecisionStatusEvent = z.infer<
  typeof globalDecisionStatusEventSchema
>;

export interface GlobalDecisionStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

export interface PromoteGlobalDecisionInput {
  decisionSummary: string;
  keyRationale: string;
  appliesToScope: string;
  relatedContextNodeIdentifiers?: string[];
  artifactOrCommitReferences?: string[];
  informationSource:
    | { sourceType: "agent"; agentInstanceId: string }
    | { sourceType: "user"; userId?: string };
  sourceRevision: number;
  globalDecisionIdentifier?: string;
  supersedesGlobalDecisionIdentifier?: string;
  rejectedAlternatives?: Array<{ proposal: string; reason: string }>;
  invalidationCondition?: string;
  globalContextRevision?: number;
}

export interface PromoteGlobalDecisionResult {
  record: GlobalDecisionRecord;
  outcome: "created" | "deduplicated";
  conflictWithGlobalDecisionIdentifiers: string[];
}

export const GLOBAL_DECISION_TOKEN_ESTIMATE_DIVISOR = 4;

export function estimateGlobalDecisionTokenCount(record: {
  decisionSummary: string;
  keyRationale: string;
}): number {
  const characterCount = record.decisionSummary.length + record.keyRationale.length;
  return Math.max(1, Math.ceil(characterCount / GLOBAL_DECISION_TOKEN_ESTIMATE_DIVISOR));
}

export class GlobalDecisionStore {
  private readonly recordsDirectoryPath: string;
  private readonly eventsDirectoryPath: string;
  private readonly nowMilliseconds: () => number;
  private readonly storeLock = new AsyncMutex();

  constructor(options: GlobalDecisionStoreOptions) {
    this.recordsDirectoryPath = path.join(options.baseDirectory, "global-decisions", "records");
    this.eventsDirectoryPath = path.join(options.baseDirectory, "global-decisions", "status-events");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  async promoteCandidate(
    input: PromoteGlobalDecisionInput,
  ): Promise<PromoteGlobalDecisionResult> {
    return this.storeLock.runExclusive(async () => {
      const existingRecords = await this.listRecordsInternal();
      const contentHash = computeGlobalDecisionContentHash(input);
      const scopeMatches = existingRecords.filter(
        (record) => record.appliesToScope === input.appliesToScope,
      );
      const identical = scopeMatches.find((record) => record.contentHash === contentHash);
      if (identical !== undefined) {
        return {
          record: identical,
          outcome: "deduplicated",
          conflictWithGlobalDecisionIdentifiers: [],
        };
      }
      const activeConflicts: GlobalDecisionRecord[] = [];
      for (const scopeMatch of scopeMatches) {
        const resolvedStatus = this.resolveStatus(
          scopeMatch,
          await this.readEventsFor(scopeMatch.globalDecisionIdentifier),
        );
        if (resolvedStatus === "active") {
          activeConflicts.push(scopeMatch);
        }
      }
      const isAgentSource = input.informationSource.sourceType === "agent";
      const nextStatus: GlobalDecisionStatus =
        isAgentSource || activeConflicts.length > 0 ? "pending-human-review" : "active";
      const record: GlobalDecisionRecord = {
        schemaVersion: GLOBAL_DECISION_RECORD_SCHEMA_VERSION,
        globalDecisionIdentifier:
          input.globalDecisionIdentifier ?? "gd-" + contentHash.slice(7, 23),
        globalContextRevision: input.globalContextRevision ?? 1,
        decisionSummary: input.decisionSummary,
        keyRationale: input.keyRationale,
        rejectedAlternatives: input.rejectedAlternatives ?? [],
        appliesToScope: input.appliesToScope,
        relatedContextNodeIdentifiers: input.relatedContextNodeIdentifiers ?? [],
        artifactOrCommitReferences: input.artifactOrCommitReferences ?? [],
        informationSource: input.informationSource,
        sourceRevision: input.sourceRevision,
        contentHash,
        createdAtIso: new Date(this.nowMilliseconds()).toISOString(),
        status: nextStatus,
        ...(input.invalidationCondition !== undefined
          ? { invalidationCondition: input.invalidationCondition }
          : {}),
        ...(input.supersedesGlobalDecisionIdentifier !== undefined
          ? {
              supersedesGlobalDecisionIdentifier:
                input.supersedesGlobalDecisionIdentifier,
            }
          : {}),
      };
      const parsed = globalDecisionRecordSchema.safeParse(record);
      if (!parsed.success) {
        throw new DomainError(
          "global-decision-invalid",
          "全局决策记录 schema 校验失败: " + parsed.error.message,
        );
      }
      await this.assertRecordDoesNotExist(record.globalDecisionIdentifier);
      await fs.mkdir(this.recordsDirectoryPath, { recursive: true });
      await writeAtomicJson(this.recordFilePath(record.globalDecisionIdentifier), parsed.data);
      if (record.supersedesGlobalDecisionIdentifier !== undefined) {
        await this.appendStatusEvent({
          globalDecisionIdentifier: record.supersedesGlobalDecisionIdentifier,
          eventType: "superseded",
          nextStatus: "superseded",
          supersededByGlobalDecisionIdentifier: record.globalDecisionIdentifier,
          reason: "被新记录替代（历史保留，不覆盖）",
        });
      }
      return {
        record: parsed.data,
        outcome: "created",
        conflictWithGlobalDecisionIdentifiers: activeConflicts.map(
          (conflict) => conflict.globalDecisionIdentifier,
        ),
      };
    });
  }

  async appendStatusEvent(input: {
    globalDecisionIdentifier: string;
    eventType: GlobalDecisionStatusEventType;
    nextStatus: GlobalDecisionStatus;
    reason: string;
    supersededByGlobalDecisionIdentifier?: string;
  }): Promise<GlobalDecisionStatusEvent> {
    await this.requireRecord(input.globalDecisionIdentifier);
    const eventIdentifier =
      "gde-" + input.globalDecisionIdentifier + "-" + (this.nowMilliseconds()).toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const event: GlobalDecisionStatusEvent = {
      schemaVersion: GLOBAL_DECISION_STATUS_EVENT_SCHEMA_VERSION,
      eventIdentifier,
      globalDecisionIdentifier: input.globalDecisionIdentifier,
      eventType: input.eventType,
      nextStatus: input.nextStatus,
      ...(input.supersededByGlobalDecisionIdentifier !== undefined
        ? {
            supersededByGlobalDecisionIdentifier:
              input.supersededByGlobalDecisionIdentifier,
          }
        : {}),
      reason: input.reason,
      createdAtIso: new Date(this.nowMilliseconds()).toISOString(),
    };
    const parsed = globalDecisionStatusEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new DomainError(
        "global-decision-invalid",
        "状态事件 schema 校验失败: " + parsed.error.message,
      );
    }
    await fs.mkdir(this.eventsDirectoryPath, { recursive: true });
    const eventFilePath = path.join(this.eventsDirectoryPath, event.eventIdentifier + ".json");
    await writeAtomicJson(eventFilePath, parsed.data);
    return parsed.data;
  }

  async resolveStatusById(globalDecisionIdentifier: string): Promise<GlobalDecisionStatus> {
    const record = await this.requireRecord(globalDecisionIdentifier);
    return this.resolveStatus(record, await this.readEventsFor(globalDecisionIdentifier));
  }

  async listRecords(): Promise<GlobalDecisionRecord[]> {
    return this.storeLock.runExclusive(() => this.listRecordsInternal());
  }

  async readRecord(globalDecisionIdentifier: string): Promise<GlobalDecisionRecord | null> {
    const filePath = this.recordFilePath(globalDecisionIdentifier);
    try {
      const rawContent = await fs.readFile(filePath, "utf8");
      const parsed = globalDecisionRecordSchema.safeParse(JSON.parse(rawContent));
      if (!parsed.success) {
        throw new DomainError(
          "global-decision-invalid",
          "全局决策记录非法: " + parsed.error.message,
        );
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "journal-corrupted",
        "全局决策记录损坏，拒绝读取: " + filePath,
      );
    }
  }

  private resolveStatus(
    record: GlobalDecisionRecord,
    events: GlobalDecisionStatusEvent[],
  ): GlobalDecisionStatus {
    const relatedEvents = events
      .filter((event) => event.globalDecisionIdentifier === record.globalDecisionIdentifier)
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
    const lastEvent = relatedEvents[relatedEvents.length - 1];
    return lastEvent?.nextStatus ?? record.status;
  }

  private async readEventsFor(
    globalDecisionIdentifier: string,
  ): Promise<GlobalDecisionStatusEvent[]> {
    const events = await this.listEventsInternal();
    return events.filter(
      (event) => event.globalDecisionIdentifier === globalDecisionIdentifier,
    );
  }

  private async listEventsInternal(): Promise<GlobalDecisionStatusEvent[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.eventsDirectoryPath);
    } catch {
      return [];
    }
    const events: GlobalDecisionStatusEvent[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const rawContent = await fs.readFile(path.join(this.eventsDirectoryPath, fileName), "utf8");
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(rawContent);
      } catch {
        throw new DomainError(
          "journal-corrupted",
          "全局决策状态事件损坏: " + fileName,
        );
      }
      const parsed = globalDecisionStatusEventSchema.safeParse(parsedContent);
      if (!parsed.success) {
        throw new DomainError(
          "global-decision-invalid",
          "全局决策状态事件非法: " + fileName,
        );
      }
      events.push(parsed.data);
    }
    return events;
  }

  private async listRecordsInternal(): Promise<GlobalDecisionRecord[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.recordsDirectoryPath);
    } catch {
      return [];
    }
    const records: GlobalDecisionRecord[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const recordIdentifier = fileName.slice(0, -".json".length);
      const record = await this.readRecord(recordIdentifier);
      if (record !== null) {
        records.push(record);
      }
    }
    return records.sort((left, right) =>
      left.globalDecisionIdentifier.localeCompare(right.globalDecisionIdentifier),
    );
  }

  private async assertRecordDoesNotExist(globalDecisionIdentifier: string): Promise<void> {
    const existing = await this.readRecord(globalDecisionIdentifier);
    if (existing !== null) {
      throw new DomainError(
        "global-decision-invalid",
        "全局决策记录已存在（只追加，禁止覆盖）: " + globalDecisionIdentifier,
      );
    }
  }

  private async requireRecord(globalDecisionIdentifier: string): Promise<GlobalDecisionRecord> {
    const record = await this.readRecord(globalDecisionIdentifier);
    if (record === null) {
      throw new DomainError(
        "global-decision-not-found",
        "全局决策记录不存在: " + globalDecisionIdentifier,
      );
    }
    return record;
  }

  private recordFilePath(globalDecisionIdentifier: string): string {
    return path.join(this.recordsDirectoryPath, sanitizeIdentifier(globalDecisionIdentifier) + ".json");
  }
}

export function computeGlobalDecisionContentHash(input: {
  decisionSummary: string;
  keyRationale: string;
  appliesToScope: string;
}): string {
  const canonicalText = [
    input.appliesToScope,
    input.decisionSummary,
    input.keyRationale,
  ].join("\u0000");
  return "sha256:" + createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}
