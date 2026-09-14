/**
 * SUM-01-02：摘要增量索引的受控保存与原子发布。
 *
 * 不变量：
 * - 已发布清单必须与其分块/覆盖元数据自洽（指纹 + 覆盖区间无未记录缺口），
 *   否则读取直接 fail-closed（DomainError journal-corrupted），绝不把
 *   "新摘要指向旧正文"的清单当作有效摘要返回；
 * - 发布采用 CAS（清单 revision），陈旧发布被拒绝；
 * - 生成过程先落 pending 草稿（含本地权威事实），崩溃后可续跑且不重复提取；
 * - 读取路径只读清单，不触发任何重摘要或模型调用。
 */
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  removeJsonFileWithBackup,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import { sanitizePathSegment } from "../orchestration/work-archive-store.js";
import {
  SummaryContractError,
  validateSummaryManifest,
  type SummaryManifest,
  type SummarySourceKind,
} from "./summary-manifest.js";
import {
  assertSidecarIndexIsPointerOnly,
  type SummarySidecarIndexEntry,
} from "./summary-sidecar-index.js";

export interface SummarySourceKey {
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
}

export interface SummaryIndexStoreOptions {
  baseDirectory: string;
  /** 故障注入（测试"中断发布"）：替换清单写入，抛错即模拟崩溃。 */
  manifestWriteHook?: (
    filePath: string,
    manifest: SummaryManifest,
  ) => Promise<void>;
}

export const summaryPendingGenerationSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentInstanceId: z.string().min(1),
    sourceKind: z.enum(["conversation", "work-archive", "report", "deferred-file"]),
    sourceIdentifier: z.string().min(1),
    facts: z.array(
      z
        .object({
          factIdentifier: z.string().min(1),
          sourceKind: z.enum([
            "conversation",
            "work-archive",
            "report",
            "deferred-file",
          ]),
          sourceIdentifier: z.string().min(1),
          sourceRevision: z.number().int().positive(),
          contentHash: z.string().min(1),
          entryType: z.enum(["message", "decision", "result", "report", "note"]),
          factText: z.string().min(1),
          recordedAtIso: z.iso.datetime(),
        })
        .strict(),
    ),
    pendingSourceRevisions: z.array(z.number().int().positive()),
    draftNarrative: z.string().nullable(),
    baseManifestRevision: z.number().int().nonnegative(),
    createdAtIso: z.iso.datetime(),
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type SummaryPendingGeneration = z.infer<
  typeof summaryPendingGenerationSchema
>;

export interface SummarySourceInvalidation {
  isInvalidated: boolean;
  reason: "no-manifest" | "source-advanced" | "source-content-changed" | null;
  manifestRevision: number | null;
  coveredThroughSourceRevision: number | null;
}

export class SummaryIndexStore {
  private readonly publishLocksByPath = new Map<string, AsyncMutex>();
  private readonly singleFlightByKey = new Map<string, Promise<unknown>>();

  constructor(private readonly options: SummaryIndexStoreOptions) {}

  private summaryDirectoryPath(
    agentInstanceId: string,
    key: SummarySourceKey,
  ): string {
    return path.join(
      this.options.baseDirectory,
      "agent-memory",
      sanitizePathSegment(agentInstanceId),
      "summaries",
      sanitizePathSegment(key.sourceKind) +
        "-" +
        sanitizePathSegment(key.sourceIdentifier),
    );
  }

  private manifestFilePath(
    agentInstanceId: string,
    key: SummarySourceKey,
  ): string {
    return path.join(
      this.summaryDirectoryPath(agentInstanceId, key),
      "manifest.json",
    );
  }

  private pendingFilePath(
    agentInstanceId: string,
    key: SummarySourceKey,
  ): string {
    return path.join(
      this.summaryDirectoryPath(agentInstanceId, key),
      "pending.json",
    );
  }

  private getPublishLock(filePath: string): AsyncMutex {
    const existing = this.publishLocksByPath.get(filePath);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AsyncMutex();
    this.publishLocksByPath.set(filePath, created);
    return created;
  }

  private assertCoverageInvariant(manifest: SummaryManifest): void {
    const coveredRevisions = new Set<number>();
    for (const chunk of manifest.chunks) {
      for (
        let revision = chunk.sourceRevisionFrom;
        revision <= chunk.sourceRevisionTo;
        revision += 1
      ) {
        coveredRevisions.add(revision);
      }
    }
    for (const revision of manifest.pendingSourceRevisions) {
      coveredRevisions.add(revision);
    }
    if (manifest.coveredThroughSourceRevision === 0) {
      if (manifest.chunks.length > 0 || manifest.pendingSourceRevisions.length > 0) {
        throw new DomainError(
          "journal-corrupted",
          "清单声明未覆盖任何来源却存在分块/pending: " +
            manifest.manifestIdentifier,
        );
      }
      return;
    }
    for (
      let revision = 1;
      revision <= manifest.coveredThroughSourceRevision;
      revision += 1
    ) {
      if (!coveredRevisions.has(revision)) {
        throw new DomainError(
          "journal-corrupted",
          "清单覆盖区间存在未记录缺口 revision=" +
            revision +
            "（可能指向旧正文）: " +
            manifest.manifestIdentifier,
        );
      }
    }
  }

  /** 读取已发布清单；损坏/不完整一律 fail-closed，不触发任何重摘要。 */
  async readManifest(
    input: { agentInstanceId: string } & SummarySourceKey,
  ): Promise<SummaryManifest | null> {
    const filePath = this.manifestFilePath(input.agentInstanceId, input);
    const readResult = await readJsonWithBackupRecovery(
      filePath,
      filePath + ".bak",
    );
    if (readResult === null) {
      return null;
    }
    let manifest: SummaryManifest;
    try {
      manifest = validateSummaryManifest(readResult.content);
    } catch (error) {
      if (error instanceof SummaryContractError) {
        throw new DomainError("journal-corrupted", error.message);
      }
      throw error;
    }
    this.assertCoverageInvariant(manifest);
    return manifest;
  }

  /** CAS 原子发布：期望 revision 不符即拒绝（陈旧覆盖）。 */
  async publishManifest(
    input: { agentInstanceId: string; expectedRevision: number } & SummarySourceKey & {
        manifest: SummaryManifest;
      },
  ): Promise<SummaryManifest> {
    const filePath = this.manifestFilePath(input.agentInstanceId, input);
    return this.getPublishLock(filePath).runExclusive(async () => {
      const current = await this.readManifest(input);
      const currentRevision = current?.manifestRevision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw new SummaryContractError(
          "stale-publish",
          "清单 revision 已变化，拒绝陈旧发布: 期望 " +
            String(input.expectedRevision) +
            "，现有 " +
            String(currentRevision),
        );
      }
      const verified = validateSummaryManifest(input.manifest);
      this.assertCoverageInvariant(verified);
      await backupExistingFile(filePath, filePath + ".bak");
      if (this.options.manifestWriteHook !== undefined) {
        await this.options.manifestWriteHook(filePath, verified);
      } else {
        await writeAtomicJson(filePath, verified);
      }
      return verified;
    });
  }

  async writePendingGeneration(
    pending: SummaryPendingGeneration,
  ): Promise<void> {
    const filePath = this.pendingFilePath(pending.agentInstanceId, pending);
    await writeAtomicJson(filePath, summaryPendingGenerationSchema.parse(pending));
  }

  async readPendingGeneration(
    input: { agentInstanceId: string } & SummarySourceKey,
  ): Promise<SummaryPendingGeneration | null> {
    const filePath = this.pendingFilePath(input.agentInstanceId, input);
    const readResult = await readJsonWithBackupRecovery(
      filePath,
      filePath + ".bak",
    );
    if (readResult === null) {
      return null;
    }
    const parsed = summaryPendingGenerationSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        "pending 生成草稿损坏，拒绝续跑: " + parsed.error.message,
      );
    }
    return parsed.data;
  }

  /** 清理已发布的 pending 草稿：先 .bak 备份再删除（不直接 rm）。 */
  async clearPendingGeneration(
    input: { agentInstanceId: string } & SummarySourceKey,
  ): Promise<void> {
    const filePath = this.pendingFilePath(input.agentInstanceId, input);
    await removeJsonFileWithBackup(filePath, filePath + ".bak");
  }

  private sidecarFilePath(
    agentInstanceId: string,
    key: SummarySourceKey,
  ): string {
    return path.join(
      this.summaryDirectoryPath(agentInstanceId, key),
      "sidecar-index.json",
    );
  }

  /** 写入源码/媒体旁置索引（只存指针；写入前经 pointer-only 断言）。 */
  async writeSidecarIndex(
    input: { agentInstanceId: string } & SummarySourceKey & {
        entries: SummarySidecarIndexEntry[];
      },
  ): Promise<void> {
    assertSidecarIndexIsPointerOnly(input.entries);
    await writeAtomicJson(this.sidecarFilePath(input.agentInstanceId, input), {
      schemaVersion: 1,
      entries: input.entries,
    });
  }

  async readSidecarIndex(
    input: { agentInstanceId: string } & SummarySourceKey,
  ): Promise<SummarySidecarIndexEntry[] | null> {
    const filePath = this.sidecarFilePath(input.agentInstanceId, input);
    const readResult = await readJsonWithBackupRecovery(
      filePath,
      filePath + ".bak",
    );
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as { entries?: unknown };
    const entries = Array.isArray(content.entries) ? content.entries : [];
    assertSidecarIndexIsPointerOnly(entries);
    return entries as SummarySidecarIndexEntry[];
  }

  /** 同一来源键的生成任务 single-flight：并发请求只执行一次。 */
  async withSingleFlight<T>(
    input: { agentInstanceId: string } & SummarySourceKey,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = [
      input.agentInstanceId,
      input.sourceKind,
      input.sourceIdentifier,
    ].join("|");
    const existing = this.singleFlightByKey.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }
    const running = Promise.resolve().then(task);
    const tracked: Promise<T> = running.finally(() => {
      // finally 在任务结算后执行，此时 tracked 已完成初始化。
      if (this.singleFlightByKey.get(key) === tracked) {
        this.singleFlightByKey.delete(key);
      }
    });
    this.singleFlightByKey.set(key, tracked);
    return tracked;
  }

  /**
   * 检测外部变化：来源前进或同 revision 内容变化 → 标记失效。
   * 只读清单，**不触发重摘要**（重摘要由调用方按策略发起）。
   */
  async detectSourceInvalidation(
    input: { agentInstanceId: string } & SummarySourceKey & {
        observedSourceRevision: number;
        observedContentHash: string;
      },
  ): Promise<SummarySourceInvalidation> {
    const manifest = await this.readManifest(input);
    if (manifest === null) {
      return {
        isInvalidated: false,
        reason: "no-manifest",
        manifestRevision: null,
        coveredThroughSourceRevision: null,
      };
    }
    const revisionScopedPointer = manifest.chunks
      .flatMap((chunk) => chunk.evidencePointers)
      .find(
        (pointer) => pointer.sourceRevision === input.observedSourceRevision,
      );
    if (input.observedSourceRevision > manifest.coveredThroughSourceRevision) {
      return {
        isInvalidated: true,
        reason: "source-advanced",
        manifestRevision: manifest.manifestRevision,
        coveredThroughSourceRevision: manifest.coveredThroughSourceRevision,
      };
    }
    if (
      revisionScopedPointer !== undefined &&
      revisionScopedPointer.contentHash !== input.observedContentHash
    ) {
      return {
        isInvalidated: true,
        reason: "source-content-changed",
        manifestRevision: manifest.manifestRevision,
        coveredThroughSourceRevision: manifest.coveredThroughSourceRevision,
      };
    }
    return {
      isInvalidated: false,
      reason: null,
      manifestRevision: manifest.manifestRevision,
      coveredThroughSourceRevision: manifest.coveredThroughSourceRevision,
    };
  }
}
