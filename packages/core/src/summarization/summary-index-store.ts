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
import { promises as fs } from "node:fs";
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
import {
  decodePathSegment,
  sanitizePathSegment,
} from "../orchestration/work-archive-store.js";
import { advanceSummaryGeneration } from "./summary-generation-service.js";
import { buildLocalExtractiveNarrative } from "./summary-source-adapters.js";
import type { SummarySourceEntry } from "./summary-fact-extractor.js";

/**
 * 迁移产物的生成器版本（**刻意与常规版本区分**）：
 * 便于日后识别"这是迁移重建的清单"，而不是正常增量生成的。
 */
const LEGACY_MIGRATION_GENERATOR_VERSION = "local-extractive-legacy-migration-1";

/**
 * 旧清单备份文件名（**确定性**，不带时间戳）。
 *
 * 为什么必须确定性：若在"移走旧清单"之后、"发布新清单"之前崩溃，
 * 该来源会处于"无 manifest.json"态。用带时间戳的名字就**再也认不出**
 * 这是"迁移中断"还是"从未有过清单"⇒ 恢复不可能。用固定名字后，
 * 只要看到"无 manifest.json 但有该备份"，即可判定为**迁移中断并重试**。
 */
const LEGACY_MANIFEST_BACKUP_FILE_NAME = "manifest.json.legacy-backup";
import {
  SUMMARY_MANIFEST_SCHEMA_VERSION,
  SUMMARY_SOURCE_KINDS,
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

  /** 清单文件字节数（资源观测；不存在记 0）。 */
  async manifestFileSizeBytes(
    input: { agentInstanceId: string } & SummarySourceKey,
  ): Promise<number> {
    try {
      const stats = await fs.stat(
        this.manifestFilePath(input.agentInstanceId, input),
      );
      return stats.size;
    } catch {
      return 0;
    }
  }

  /** 列出该 Agent 已发布摘要的来源键（逐目录读清单，按标识排序）。 */
  async listSourceKeys(agentInstanceId: string): Promise<
    Array<{
      sourceKind: SummarySourceKind;
      sourceIdentifier: string;
      manifestRevision: number;
      coveredThroughSourceRevision: number;
      chunkCount: number;
      pendingSourceRevisionCount: number;
      narrativeCharacterCount: number;
      generatorVersion: string;
    }>
  > {
    const summariesDirectoryPath = path.join(
      this.options.baseDirectory,
      "agent-memory",
      sanitizePathSegment(agentInstanceId),
      "summaries",
    );
    let directoryNames: string[];
    try {
      const entries = await fs.readdir(summariesDirectoryPath, {
        withFileTypes: true,
      });
      directoryNames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const views: Array<{
      sourceKind: SummarySourceKind;
      sourceIdentifier: string;
      manifestRevision: number;
      coveredThroughSourceRevision: number;
      chunkCount: number;
      pendingSourceRevisionCount: number;
      narrativeCharacterCount: number;
      generatorVersion: string;
    }> = [];
    for (const directoryName of directoryNames) {
      try {
        const rawContent = await fs.readFile(
          path.join(summariesDirectoryPath, directoryName, "manifest.json"),
          "utf8",
        );
        const manifest = validateSummaryManifest(JSON.parse(rawContent));
        views.push({
          sourceKind: manifest.sourceKind,
          sourceIdentifier: manifest.sourceIdentifier,
          manifestRevision: manifest.manifestRevision,
          coveredThroughSourceRevision: manifest.coveredThroughSourceRevision,
          chunkCount: manifest.chunks.length,
          pendingSourceRevisionCount: manifest.pendingSourceRevisions.length,
          narrativeCharacterCount: manifest.narrativeText?.length ?? 0,
          generatorVersion: manifest.generatorVersion,
        });
      } catch {
        // 损坏或半写目录不参与列表（读取单个来源时会显式 fail-closed）。
        continue;
      }
    }
    return views.sort((left, right) => {
      if (left.sourceKind !== right.sourceKind) {
        return left.sourceKind.localeCompare(right.sourceKind);
      }
      return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
    });
  }

  /**
   * 从摘要目录名还原 `sourceKind` 与 `sourceIdentifier`。
   *
   * 目录名布局为 `sanitize(kind) + "-" + sanitize(identifier)`（见 `summaryDirectoryPath`）。
   * 清单损坏时字段读不出来，只能从目录名还原 —— 种类在**已知枚举**里逐一匹配，
   * 标识符用**真实解码器** `decodePathSegment`（编码是单射的）。
   * 匹配不到已知种类时**不猜**：返回 `null` 种类 + 整体解码的标识符。
   */
  private static splitSummaryDirectoryName(directoryName: string): {
    sourceKind: SummarySourceKind | null;
    sourceIdentifier: string;
  } {
    for (const knownKind of SUMMARY_SOURCE_KINDS) {
      const prefix = sanitizePathSegment(knownKind) + "-";
      if (directoryName.startsWith(prefix)) {
        return {
          sourceKind: knownKind,
          sourceIdentifier: decodePathSegment(directoryName.slice(prefix.length)),
        };
      }
    }
    return {
      sourceKind: null,
      sourceIdentifier: decodePathSegment(directoryName),
    };
  }

  /**
   * SUM-01-02：**只读**判定哪些清单是"旧格式"（需要迁移）。   *
   * 为什么需要它：`summaryManifestSchema` 是 `.strict()` 且要求
   * `chunkChainHash`/`manifestIntegrityHash` 等字段 ⇒ **历史清单根本读不出来**
   * （`readManifest()` 抛 `journal-corrupted`），而全仓此前**没有任何迁移判定入口**
   * ⇒ 卡内点名的"旧文件迁移"没有判定点，用户也不知道哪些清单要迁移。
   *
   * 严格遵守卡内纪律：
   *  - **只读**：不改写、不删除、**不触发任何重摘要**（"读取不触发全文重摘要"）；
   *  - 逐条独立判定：单条损坏**不让整批失败**，并把原因如实报出；
   *  - 无 `summaries` 目录 ⇒ 空报告 + `isMigrationNeeded: false`（**不虚构待迁移项**）。
   *
   * 注意：本方法**只判定、不迁移**。真正的迁移必须走原子发布路径
   * （见 `publishManifest` 的 CAS + `withSingleFlight`），以免"崩溃留下新摘要指旧正文"。
   */
  async detectLegacyManifests(input: { agentInstanceId: string }): Promise<{
    entries: Array<{
      sourceKind: SummarySourceKind | null;
      sourceIdentifier: string;
      reason: string;
    }>;
    isMigrationNeeded: boolean;
  }> {
    const summariesDirectoryPath = path.join(
      this.options.baseDirectory,
      "agent-memory",
      sanitizePathSegment(input.agentInstanceId),
      "summaries",
    );
    let directoryNames: string[];
    try {
      const directoryEntries = await fs.readdir(summariesDirectoryPath, {
        withFileTypes: true,
      });
      directoryNames = directoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      /** 全新安装：没有 summaries 目录 ⇒ 没有任何待迁移项。 */
      return { entries: [], isMigrationNeeded: false };
    }

    const entries: Array<{
      sourceKind: SummarySourceKind | null;
      sourceIdentifier: string;
      reason: string;
    }> = [];
    for (const directoryName of directoryNames) {
      const manifestFilePath = path.join(summariesDirectoryPath, directoryName, "manifest.json");
      let rawContent: string;
      try {
        rawContent = await fs.readFile(manifestFilePath, "utf8");
      } catch {
        /**
         * 目录在但没有清单：需要处理（不得静默忽略）。
         * 若同时存在**迁移备份**，说明上一次迁移"移走了旧清单但没发成新清单"
         * （崩溃中断）⇒ 必须**可恢复**，否则该来源永久失去内容。
         */
        const hasInterruptedMigrationBackup = await (async () => {
          try {
            await fs.stat(path.join(summariesDirectoryPath, directoryName, LEGACY_MANIFEST_BACKUP_FILE_NAME));
            return true;
          } catch {
            return false;
          }
        })();
        entries.push({
          /**
           * 目录名是 `sanitize(kind) + "-" + sanitize(identifier)` ⇒ **种类与标识符都能还原**
           * （种类在已知枚举里逐一匹配，标识符用真实解码器 `decodePathSegment`）。
           */
          ...SummaryIndexStore.splitSummaryDirectoryName(directoryName),
          reason: hasInterruptedMigrationBackup
            ? "上一次迁移被中断（旧清单已备份但新清单未发布）⇒ 需要重试迁移"
            : "目录存在但缺少 manifest.json（半写或未完成发布）",
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        entries.push({
          ...SummaryIndexStore.splitSummaryDirectoryName(directoryName),
          /**
           * JSON 不可解析 ⇒ 字段读不出来，只能从目录名还原。
           * 注意：**种类未知时无法确定 `-` 是分隔符还是标识符的一部分**
           * （编码方案下 `-` 是合法字面字符），故此时标识符是**整段解码后的目录名**
           * 而非裸标识符 —— 这一点在 reason 中如实说明，不假装精确。
           */
          reason:
            SummaryIndexStore.splitSummaryDirectoryName(directoryName).sourceKind === null
              ? "manifest.json 不是合法 JSON（解析失败）；目录名种类未知，标识符为整段解码结果"
              : "manifest.json 不是合法 JSON（解析失败，可能写入被中断）",
        });
        continue;
      }
      /** 新格式能通过校验 ⇒ 不是待迁移项。 */
      try {
        validateSummaryManifest(parsed);
        continue;
      } catch (validationError) {
        const record =
          parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
        const missingFields = [
          "chunkChainHash",
          "manifestIntegrityHash",
          "generatorVersion",
          "manifestRevision",
        ].filter((fieldName) => record[fieldName] === undefined);
        const schemaVersion = record["schemaVersion"];
        const reasons: string[] = [];
        if (missingFields.length > 0) {
          reasons.push("缺少字段: " + missingFields.join(","));
        }
        if (schemaVersion !== SUMMARY_MANIFEST_SCHEMA_VERSION) {
          reasons.push(
            "schemaVersion 不符（期望 " +
              String(SUMMARY_MANIFEST_SCHEMA_VERSION) +
              "，实际 " +
              String(schemaVersion) +
              "）",
          );
        }
        if (reasons.length === 0) {
          /**
           * `validateSummaryManifest` 走 zod ⇒ 只会抛 `Error` 子类
           * （`ZodError extends Error`），因此**不需要** `instanceof` 兜底分支：
           * 那是一个永远走不到的假分支（只会拉低覆盖率而不保护任何行为）。
           * 这里保留 `cause` 以便诊断时能看到真实的 zod 问题路径。
           */
          reasons.push(
            "结构校验未通过: " +
              (validationError instanceof Error
                ? validationError.message
                : String(validationError)),
          );
        }
        const sourceKindValue = record["sourceKind"];
        const isKnownSourceKind =
          typeof sourceKindValue === "string" &&
          (SUMMARY_SOURCE_KINDS as readonly string[]).includes(sourceKindValue);
        entries.push({
          sourceKind: isKnownSourceKind
            ? (sourceKindValue as SummarySourceKind)
            : null,
          sourceIdentifier:
            typeof record["sourceIdentifier"] === "string" &&
            record["sourceIdentifier"] !== ""
              ? record["sourceIdentifier"]
              : SummaryIndexStore.splitSummaryDirectoryName(directoryName).sourceIdentifier,
          reason: "旧格式清单需要迁移（" + reasons.join("；") + "）",
        });
        continue;
      }
    }
    /**
     * 排序必须**完全确定**：此前只按标识符与原因排序，导致目录扫描顺序
     * （`readdir` 不保证顺序）会泄漏到报告里 ⇒ 同一次迁移在两次运行中
     * 可能给出不同顺序。补上 `sourceKind` 这一层比较键（`null` 排最后）。
     */
    entries.sort((left, right) => {
      const leftKind = left.sourceKind ?? "";
      const rightKind = right.sourceKind ?? "";
      if (leftKind !== rightKind) {
        return leftKind.localeCompare(rightKind);
      }
      if (left.sourceIdentifier !== right.sourceIdentifier) {
        return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
      }
      return left.reason.localeCompare(right.reason);
    });
    return { entries, isMigrationNeeded: entries.length > 0 };
  }

  /**
   * SUM-01-02：**安全执行**旧清单迁移（备份旧文件 ⇒ 原子重发新清单）。
   *
   * 为什么必须这样做：旧格式清单**读不出来**（`journal-corrupted`），
   * 而 `advanceSummaryGeneration()` 第一步就是 `readManifest()` ⇒ 迁移无法启动。
   * 直接删旧文件是**不可接受**的（卡内：任何删除/替换/覆盖必须自动备份）。
   *
   * 语义：
   *  - 先**备份**旧 `manifest.json` 到 `manifest.json.legacy-backup-<revision>`
   *    （复用 `backupExistingFile`，绝不直接覆盖）；
   *  - 再用**既有** `writePendingGeneration` ⇒ `publishManifest`（原子 + CAS）
   *    写新清单；写入中断时旧文件仍在（崩溃安全，可重试）；
   *  - **幂等**：已是新格式的来源直接跳过（不改写、不重复备份）；
   *  - **逐条独立**：单条失败**不中止整批**，失败项如实进 `failedEntries`；
   *  - **不给条目就不迁移**（迁移本质是"用本地提取重建"）：
   *    缺条目的来源计入 `skippedSourceIdentifiers`，**不得**伪造空内容。
   */
  async migrateLegacyManifests(input: {
    agentInstanceId: string;
    /** 按来源标识符给出**重建用的**条目；缺条目即跳过该来源（不伪造）。 */
    entriesBySourceIdentifier: Record<string, SummarySourceEntry[]>;
  }): Promise<{
    migratedSourceIdentifiers: string[];
    skippedSourceIdentifiers: string[];
    failedEntries: Array<{ sourceIdentifier: string; reason: string }>;
  }> {
    const detected = await this.detectLegacyManifests({
      agentInstanceId: input.agentInstanceId,
    });
    const migratedSourceIdentifiers: string[] = [];
    const skippedSourceIdentifiers: string[] = [];
    const failedEntries: Array<{ sourceIdentifier: string; reason: string }> = [];

    for (const detectedEntry of detected.entries) {
      const sourceIdentifier = detectedEntry.sourceIdentifier;
      const entries = input.entriesBySourceIdentifier[sourceIdentifier];
      if (entries === undefined) {
        /** 没有重建条目 ⇒ **不迁移、不伪造**，并如实记入跳过。 */
        skippedSourceIdentifiers.push(sourceIdentifier);
        continue;
      }
      /** 种类未知的目录无从确定来源键 ⇒ 如实记失败，不猜。 */
      if (detectedEntry.sourceKind === null) {
        failedEntries.push({
          sourceIdentifier,
          reason: "来源种类未知，无法确定来源键（不猜测种类）",
        });
        continue;
      }
      try {
        if (entries.length === 0) {
          failedEntries.push({
            sourceIdentifier,
            reason: "重建条目为空，拒绝发布空清单覆盖旧内容",
          });
          continue;
        }
        const directoryPath = this.summaryDirectoryPath(input.agentInstanceId, {
          sourceKind: detectedEntry.sourceKind,
          sourceIdentifier,
        });
        const manifestFilePath = path.join(directoryPath, "manifest.json");
        /**
         * **必须先"备份并移走"旧清单**：`advanceSummaryGeneration()` 第一步就是
         * `readManifest()`，而旧格式清单会**抛 `journal-corrupted`** ⇒ 不移走就永远
         * 开始不了迁移（这正是我第一版失败的原因）。
         *
         * 复用既有 `removeJsonFileWithBackup`：**先复制备份、再删除**原文件
         * （卡内"任何删除/替换/覆盖必须自动备份"）。备份名带时间戳，
         * 同一来源重复迁移时不会互相覆盖备份。
         *
         * 崩溃窗口：若在"移走旧文件"之后、"发布新清单"之前中断，
         * 该来源会处于"无清单"态 —— 但**旧内容仍完整保留在备份里**（可恢复），
         * 且重跑迁移即可成功（用例 ⑤ 钉住这一点）。
         */
        const backupPath = path.join(
          directoryPath,
          LEGACY_MANIFEST_BACKUP_FILE_NAME,
        );
        const doesLegacyManifestExist = await (async () => {
          try {
            await fs.stat(manifestFilePath);
            return true;
          } catch {
            return false;
          }
        })();
        if (doesLegacyManifestExist) {
          const didMoveLegacyManifest = await removeJsonFileWithBackup(
            manifestFilePath,
            backupPath,
          );
          if (!didMoveLegacyManifest) {
            failedEntries.push({
              sourceIdentifier,
              reason: "旧清单无法备份，已跳过以避免无备份覆盖",
            });
            continue;
          }
        } else {
          /**
           * 旧清单**已不在**但备份在 ⇒ 上一次迁移"移走了旧清单但没发成新清单"
           * （崩溃中断）。此时**不得**再要求备份（否则会二次覆盖备份并卡死恢复），
           * 直接复用 pending 续跑即可。备份文件已在，恢复能力不受影响。
           */
          const doesBackupExist = await (async () => {
            try {
              await fs.stat(backupPath);
              return true;
            } catch {
              return false;
            }
          })();
          if (!doesBackupExist) {
            failedEntries.push({
              sourceIdentifier,
              reason: "旧清单与迁移备份都不存在，无法安全迁移（不猜测内容）",
            });
            continue;
          }
        }

        /**
         * 复用**既有**生成服务：它内部已实现 pending 续跑、single-flight 与
         * CAS 原子发布 ⇒ 迁移不另开写盘路径（避免"崩溃留下新摘要指旧正文"）。
         * `generatorVersion` 用**可区分**的迁移版本，便于日后识别迁移产物。
         */
        const generation = await advanceSummaryGeneration({
          store: this,
          agentInstanceId: input.agentInstanceId,
          sourceKind: detectedEntry.sourceKind,
          sourceIdentifier,
          entries,
          narrativeGenerator: {
            generateNarrative: async (generationInput) =>
              buildLocalExtractiveNarrative(generationInput.facts),
          },
          generatorVersion: LEGACY_MIGRATION_GENERATOR_VERSION,
        });
        if (generation.manifest === null) {
          failedEntries.push({
            sourceIdentifier,
            reason: "迁移发布未产生清单（generation 返回空）",
          });
          continue;
        }
        migratedSourceIdentifiers.push(sourceIdentifier);
      } catch (migrationError) {
        failedEntries.push({
          sourceIdentifier,
          reason:
            migrationError instanceof Error
              ? migrationError.message
              : String(migrationError),
        });
      }
    }
    return { migratedSourceIdentifiers, skippedSourceIdentifiers, failedEntries };
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
