/**
 * SUM-01-01：摘要清单、动态详细度与游标契约（原型）。
 *
 * 目标（见 docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md）：
 * - 摘要总长度**无固定硬上限**：清单只增不裁，任何"单次返回/注入预算"只影响本次返回；
 * - 权威来源用 sourceRevision + contentHash 标识，**重复消息不双计**，同 revision 内容变化显式拒绝；
 * - 覆盖范围与 pending 尾部显式记录（缺口不自称已覆盖）；
 * - 游标绑定 agentInstanceId 与清单 revision，跨 Agent/陈旧一律拒绝；
 * - 分页读取走 chunkReader 端口，取一页只读一页（不现场扫全文）。
 */
import { createHash } from "node:crypto";

import { z } from "zod";

export const SUMMARY_MANIFEST_SCHEMA_VERSION = 1;

export const SUMMARY_DETAIL_LEVELS = [
  "summary",
  "outline",
  "section",
  "detail",
] as const;
export type SummaryDetailLevel = (typeof SUMMARY_DETAIL_LEVELS)[number];

export const SUMMARY_SOURCE_KINDS = [
  "conversation",
  "work-archive",
  "report",
  "deferred-file",
] as const;
export type SummarySourceKind = (typeof SUMMARY_SOURCE_KINDS)[number];

export type SummaryContractErrorCode =
  | "cross-agent-cursor"
  | "stale-cursor"
  | "invalid-page-request"
  | "duplicate-source-revision"
  | "invalid-manifest";

export class SummaryContractError extends Error {
  constructor(
    readonly errorCode: SummaryContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SummaryContractError";
  }
}

export const summaryEvidencePointerSchema = z
  .object({
    sourceKind: z.enum(SUMMARY_SOURCE_KINDS),
    sourceIdentifier: z.string().min(1),
    sourceRevision: z.number().int().nonnegative(),
    contentHash: z.string().min(1),
  })
  .strict();
export type SummaryEvidencePointer = z.infer<
  typeof summaryEvidencePointerSchema
>;

export const summaryChunkSchema = z
  .object({
    chunkIdentifier: z.string().min(1),
    sourceRevisionFrom: z.number().int().positive(),
    sourceRevisionTo: z.number().int().positive(),
    themeIdentifier: z.string().min(1),
    detailLevels: z.array(z.enum(SUMMARY_DETAIL_LEVELS)).min(1),
    evidencePointers: z.array(summaryEvidencePointerSchema),
    /** 计量单位（token 换算由 SUM-02 的计量适配端口决定，不在此处假设 tokenizer）。 */
    estimatedUnitCount: z.number().int().nonnegative(),
    summaryText: z.string().min(1),
  })
  .strict();
export type SummaryChunk = z.infer<typeof summaryChunkSchema>;

export const summaryManifestSchema = z
  .object({
    schemaVersion: z.literal(SUMMARY_MANIFEST_SCHEMA_VERSION),
    manifestIdentifier: z.string().min(1),
    agentInstanceId: z.string().min(1),
    sourceKind: z.enum(SUMMARY_SOURCE_KINDS),
    sourceIdentifier: z.string().min(1),
    coveredThroughSourceRevision: z.number().int().nonnegative(),
    coveredContentHash: z.string().min(1),
    /** 覆盖区间内尚未并入摘要的来源 revision（显式 pending 尾部，可为空）。 */
    pendingSourceRevisions: z.array(z.number().int().positive()),
    chunks: z.array(summaryChunkSchema),
    manifestRevision: z.number().int().positive(),
    generatorVersion: z.string().min(1),
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type SummaryManifest = z.infer<typeof summaryManifestSchema>;

export const summaryCursorSchema = z
  .object({
    agentInstanceId: z.string().min(1),
    manifestRevision: z.number().int().positive(),
    nextChunkIndex: z.number().int().nonnegative(),
    detailLevel: z.enum(SUMMARY_DETAIL_LEVELS),
  })
  .strict();
export type SummaryCursor = z.infer<typeof summaryCursorSchema>;

export interface SummaryChunkReaderPort {
  readChunks(fromIndex: number, count: number): SummaryChunk[];
}

export interface AppendSummarySourceInput {
  sourceRevision: number;
  contentHash: string;
  summaryText: string;
  themeIdentifier: string;
  estimatedUnitCount: number;
  evidencePointers?: SummaryEvidencePointer[];
  detailLevels?: SummaryDetailLevel[];
}

export interface AppendSummarySourceResult {
  manifest: SummaryManifest;
  wasDuplicate: boolean;
  wasGapFill: boolean;
}

export interface SummaryCoverage {
  coveredThroughSourceRevision: number;
  pendingSourceRevisions: number[];
  chunkCount: number;
  evidencePointerCount: number;
  themeIdentifiers: string[];
  /** 重复投递被忽略的次数（信息覆盖审计用，不双计）。 */
  duplicateDeliveryCount: number;
}

interface SummaryManifestInternal extends SummaryManifest {
  /** 运行期计数，不进入持久化 schema（由 SUM-01-02 落盘时决定是否单独记录）。 */
  duplicateDeliveryCount?: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function collectThemeIdentifiers(manifest: SummaryManifest): string[] {
  return [...new Set(manifest.chunks.map((chunk) => chunk.themeIdentifier))].sort();
}

export function createSummaryManifest(input: {
  agentInstanceId: string;
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
  generatorVersion: string;
  nowIso?: string;
}): SummaryManifest {
  const manifest: SummaryManifest = {
    schemaVersion: SUMMARY_MANIFEST_SCHEMA_VERSION,
    manifestIdentifier:
      "summary-" + input.sourceKind + "-" + sha256Hex(input.sourceIdentifier).slice(0, 16),
    agentInstanceId: input.agentInstanceId,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
    coveredThroughSourceRevision: 0,
    coveredContentHash: sha256Hex(""),
    pendingSourceRevisions: [],
    chunks: [],
    manifestRevision: 1,
    generatorVersion: input.generatorVersion,
    updatedAtIso: input.nowIso ?? new Date().toISOString(),
  };
  return summaryManifestSchema.parse(manifest);
}

/** 显式校验整份清单（持久化读取/外部导入时使用；热路径不做全量校验）。 */
export function validateSummaryManifest(manifest: unknown): SummaryManifest {
  const parsed = summaryManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new SummaryContractError(
      "invalid-manifest",
      "摘要清单非法: " + parsed.error.message,
    );
  }
  return parsed.data;
}

/**
 * 追加一个权威来源 revision。
 * - revision 大于当前覆盖：并入覆盖，缺失区间进入 pending 尾部；
 * - revision 落在 pending 缺口：补齐并清出 pending；
 * - 同 revision + 同 contentHash：判为重复投递，**不双计**；
 * - 同 revision + 不同 contentHash：显式拒绝（需重新摘要，不静默覆盖）。
 */
export function appendSummarySource(
  manifest: SummaryManifest,
  input: AppendSummarySourceInput,
): AppendSummarySourceResult {
  const internal = manifest as SummaryManifestInternal;
  const existingPointers = manifest.chunks.flatMap((chunk) => chunk.evidencePointers);
  const isSameRevisionDelivered = existingPointers.some(
    (pointer) =>
      pointer.sourceRevision === input.sourceRevision &&
      pointer.contentHash === input.contentHash,
  );
  if (input.sourceRevision <= manifest.coveredThroughSourceRevision) {
    if (isSameRevisionDelivered) {
      return {
        manifest: {
          ...internal,
          duplicateDeliveryCount: (internal.duplicateDeliveryCount ?? 0) + 1,
        } as SummaryManifest,
        wasDuplicate: true,
        wasGapFill: false,
      };
    }
    if (!manifest.pendingSourceRevisions.includes(input.sourceRevision)) {
      throw new SummaryContractError(
        "duplicate-source-revision",
        "来源 revision 已覆盖但内容哈希变化，需重新摘要而不是覆盖: " + input.sourceRevision,
      );
    }
  }

  const wasGapFill =
    input.sourceRevision <= manifest.coveredThroughSourceRevision &&
    manifest.pendingSourceRevisions.includes(input.sourceRevision);
  const previousCovered = manifest.coveredThroughSourceRevision;
  const gapRevisions: number[] = [];
  if (input.sourceRevision > previousCovered) {
    for (let revision = previousCovered + 1; revision < input.sourceRevision; revision += 1) {
      gapRevisions.push(revision);
    }
  }
  const pendingSourceRevisions = [
    ...new Set([
      ...manifest.pendingSourceRevisions.filter(
        (revision) => revision !== input.sourceRevision,
      ),
      ...gapRevisions,
    ]),
  ].sort((left, right) => left - right);

  const chunk: SummaryChunk = summaryChunkSchema.parse({
    chunkIdentifier:
      "chunk-" +
      manifest.sourceKind +
      "-" +
      String(input.sourceRevision) +
      "-" +
      sha256Hex(input.contentHash).slice(0, 12),
    sourceRevisionFrom: input.sourceRevision,
    sourceRevisionTo: input.sourceRevision,
    themeIdentifier: input.themeIdentifier,
    detailLevels:
      input.detailLevels === undefined || input.detailLevels.length === 0
        ? ["summary", "outline", "section", "detail"]
        : input.detailLevels,
    evidencePointers:
      input.evidencePointers === undefined || input.evidencePointers.length === 0
        ? [
            {
              sourceKind: manifest.sourceKind,
              sourceIdentifier:
                manifest.sourceIdentifier + "#" + String(input.sourceRevision),
              sourceRevision: input.sourceRevision,
              contentHash: input.contentHash,
            },
          ]
        : input.evidencePointers,
    estimatedUnitCount: input.estimatedUnitCount,
    summaryText: input.summaryText,
  });

  // 按来源 revision 排序插入（分页游标依赖稳定顺序）；不裁剪任何既有分块。
  const chunks = [...manifest.chunks, chunk].sort((left, right) => {
    if (left.sourceRevisionFrom !== right.sourceRevisionFrom) {
      return left.sourceRevisionFrom - right.sourceRevisionFrom;
    }
    return left.chunkIdentifier.localeCompare(right.chunkIdentifier);
  });

  const next: SummaryManifest = {
    ...manifest,
    coveredThroughSourceRevision: Math.max(
      previousCovered,
      input.sourceRevision,
    ),
    coveredContentHash: sha256Hex(
      manifest.coveredContentHash + "|" + input.sourceRevision + ":" + input.contentHash,
    ),
    pendingSourceRevisions,
    chunks,
    manifestRevision: manifest.manifestRevision + 1,
    updatedAtIso: new Date().toISOString(),
  };
  return { manifest: next, wasDuplicate: false, wasGapFill };
}

export function summarizeManifestCoverage(
  manifest: SummaryManifest,
): SummaryCoverage {
  const internal = manifest as SummaryManifestInternal;
  return {
    coveredThroughSourceRevision: manifest.coveredThroughSourceRevision,
    pendingSourceRevisions: [...manifest.pendingSourceRevisions],
    chunkCount: manifest.chunks.length,
    evidencePointerCount: manifest.chunks.reduce(
      (total, chunk) => total + chunk.evidencePointers.length,
      0,
    ),
    themeIdentifiers: collectThemeIdentifiers(manifest),
    duplicateDeliveryCount: internal.duplicateDeliveryCount ?? 0,
  };
}

export function createManifestChunkReader(
  manifest: SummaryManifest,
): SummaryChunkReaderPort {
  return {
    readChunks: (fromIndex: number, count: number): SummaryChunk[] =>
      manifest.chunks.slice(fromIndex, fromIndex + count),
  };
}

export function createSummaryCursor(input: {
  manifest: SummaryManifest;
  detailLevel: SummaryDetailLevel;
  nextChunkIndex?: number;
}): SummaryCursor {
  return summaryCursorSchema.parse({
    agentInstanceId: input.manifest.agentInstanceId,
    manifestRevision: input.manifest.manifestRevision,
    nextChunkIndex: input.nextChunkIndex ?? 0,
    detailLevel: input.detailLevel,
  });
}

export function validateSummaryCursor(input: {
  manifest: SummaryManifest;
  cursor: SummaryCursor;
}): void {
  if (input.cursor.agentInstanceId !== input.manifest.agentInstanceId) {
    throw new SummaryContractError(
      "cross-agent-cursor",
      "游标属于其他 Agent，拒绝跨 Agent 读取: " +
        input.cursor.agentInstanceId +
        " != " +
        input.manifest.agentInstanceId,
    );
  }
  if (input.cursor.manifestRevision !== input.manifest.manifestRevision) {
    throw new SummaryContractError(
      "stale-cursor",
      "游标绑定的清单 revision 已过期: " +
        input.cursor.manifestRevision +
        " != " +
        input.manifest.manifestRevision,
    );
  }
}

export interface SummaryPage {
  detailLevel: SummaryDetailLevel;
  chunks: SummaryChunk[];
  nextCursor: SummaryCursor | null;
  coverage: SummaryCoverage;
  /** 本次返回是否因单次返回预算而截断（清单本身从不裁剪）。 */
  isReturnBounded: boolean;
  returnedUnitCount: number;
  /** summary 级别的概览（主题 -> 分块数）；其他级别为 null。 */
  themeSummaries: Array<{ themeIdentifier: string; chunkCount: number }> | null;
}

export function readSummaryPage(input: {
  manifest: SummaryManifest;
  cursor: SummaryCursor;
  pageSize: number;
  chunkReader: SummaryChunkReaderPort;
  maximumReturnUnitCount?: number;
}): SummaryPage {
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1) {
    throw new SummaryContractError(
      "invalid-page-request",
      "pageSize 必须为正整数: " + String(input.pageSize),
    );
  }
  validateSummaryCursor({ manifest: input.manifest, cursor: input.cursor });

  let chunks: SummaryChunk[];
  let isReturnBounded = false;
  if (input.cursor.detailLevel === "summary") {
    // 概览级别只读清单索引，不读取任何分块正文。
    chunks = [];
  } else {
    chunks = input.chunkReader.readChunks(
      input.cursor.nextChunkIndex,
      input.pageSize,
    );
    if (input.cursor.detailLevel === "outline") {
      chunks = chunks.map((chunk) => ({
        ...chunk,
        // 大纲只暴露主题与范围，不返回摘要正文之外的证据正文。
        summaryText: chunk.themeIdentifier + " · " + String(chunk.sourceRevisionFrom),
        evidencePointers: [],
        estimatedUnitCount: 1,
      }));
    }
  }

  const maximumReturnUnitCount = input.maximumReturnUnitCount;
  if (maximumReturnUnitCount !== undefined) {
    const boundedChunks: SummaryChunk[] = [];
    let usedUnits = 0;
    for (const chunk of chunks) {
      if (usedUnits + chunk.estimatedUnitCount > maximumReturnUnitCount) {
        isReturnBounded = true;
        break;
      }
      usedUnits += chunk.estimatedUnitCount;
      boundedChunks.push(chunk);
    }
    chunks = boundedChunks;
  }

  const nextIndex = input.cursor.nextChunkIndex + chunks.length;
  const nextCursor: SummaryCursor | null =
    input.cursor.detailLevel === "summary" || nextIndex >= input.manifest.chunks.length
      ? null
      : {
          ...input.cursor,
          nextChunkIndex: nextIndex,
        };

  const themeCounts = new Map<string, number>();
  for (const chunk of input.manifest.chunks) {
    themeCounts.set(
      chunk.themeIdentifier,
      (themeCounts.get(chunk.themeIdentifier) ?? 0) + 1,
    );
  }
  return {
    detailLevel: input.cursor.detailLevel,
    chunks,
    nextCursor,
    coverage: summarizeManifestCoverage(input.manifest),
    isReturnBounded,
    returnedUnitCount: chunks.reduce(
      (total, chunk) => total + chunk.estimatedUnitCount,
      0,
    ),
    themeSummaries:
      input.cursor.detailLevel === "summary"
        ? [...themeCounts.entries()]
            .map(([themeIdentifier, chunkCount]) => ({
              themeIdentifier,
              chunkCount,
            }))
            .sort((left, right) =>
              left.themeIdentifier.localeCompare(right.themeIdentifier),
            )
        : null,
  };
}

/**
 * 动态详细度视图：summary（概览，零分块读取）→ outline（主题+范围）
 * → section（摘要分块）→ detail（摘要+证据指针）。
 * 单次返回预算（`maximumReturnUnitCount`）只裁剪本次返回，从不修改清单。
 */
export function buildDynamicDetailView(input: {
  manifest: SummaryManifest;
  detailLevel: SummaryDetailLevel;
  pageSize: number;
  maximumReturnUnitCount?: number;
  cursor?: SummaryCursor;
  chunkReader?: SummaryChunkReaderPort;
}): SummaryPage {
  const cursor =
    input.cursor ??
    createSummaryCursor({
      manifest: input.manifest,
      detailLevel: input.detailLevel,
      nextChunkIndex: 0,
    });
  const page = readSummaryPage({
    manifest: input.manifest,
    cursor,
    pageSize: input.pageSize,
    chunkReader:
      input.chunkReader ?? createManifestChunkReader(input.manifest),
    ...(input.maximumReturnUnitCount !== undefined
      ? { maximumReturnUnitCount: input.maximumReturnUnitCount }
      : {}),
  });
  if (input.detailLevel === "summary") {
    return {
      ...page,
      // 概览级以主题数计费，避免"取一页却把全部分块读进来"。
      isReturnBounded: true,
      returnedUnitCount: page.themeSummaries?.length ?? 0,
    };
  }
  return page;
}
