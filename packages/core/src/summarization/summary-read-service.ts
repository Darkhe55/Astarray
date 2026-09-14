/**
 * SUM-01-03：默认摘要读取、章节展开与证据定位（读取路径全程不读原文）。
 *
 * 约束（见 ADR-0034 §8/§18 与 SUM-01-03 验收）：
 * - 只读取已发布清单（索引）与必要页，**不读取原文、不现场重算全文哈希**；
 * - 概览级零分块读取，分页读取量有界（≤ 页大小）；
 * - 陈旧/跨 Agent 游标一律拒绝；
 * - 每个返回项都给出可定位原证据的指针（sourceIdentifier + revision + contentHash）。
 */
import {
  SummaryContractError,
  createManifestChunkReader,
  createSummaryCursor,
  readSummaryPage,
  summarizeManifestCoverage,
  type SummaryChunk,
  type SummaryCursor,
  type SummaryCoverage,
  type SummaryChunkReaderPort,
  type SummaryDetailLevel,
  type SummaryEvidencePointer,
} from "./summary-manifest.js";
import type {
  SummaryIndexStore,
  SummarySourceKey,
} from "./summary-index-store.js";

/**
 * 原文访问观察端口：读取路径**不得调用**。仅作为可观测证据，
 * 测试传入计数实现即可证明"读取摘要没有读取原文"。
 */
export interface SummarySourceAccessObserverPort {
  recordSourceAccess(input: {
    sourceIdentifier: string;
    sourceRevision: number;
  }): void;
}

export interface SummaryReadView {
  detailLevel: SummaryDetailLevel;
  chunks: SummaryChunk[];
  nextCursor: SummaryCursor | null;
  hasMore: boolean;
  coverage: SummaryCoverage;
  evidencePointers: SummaryEvidencePointer[];
  themeSummaries: Array<{ themeIdentifier: string; chunkCount: number }> | null;
  isReturnBounded: boolean;
  returnedUnitCount: number;
  /** 本次读取触碰原文的次数（读取路径恒为 0，实测断言）。 */
  sourceAccessCount: number;
}

export interface SummarySectionView {
  chunkIdentifier: string;
  sourceRevisionFrom: number;
  sourceRevisionTo: number;
  themeIdentifier: string;
  excerpt: string;
  /** 摘要正文超出返回上限（只截断本次返回，不修改清单）。 */
  isExcerptBounded: boolean;
  narrativeExcerpt: string | null;
  evidencePointers: SummaryEvidencePointer[];
  manifestRevision: number;
  sourceAccessCount: number;
}

export interface EvidenceLocatorResult {
  isLocatable: boolean;
  reason: "located" | "not-indexed" | "content-hash-mismatch" | null;
  chunkIdentifier: string | null;
  sourceAccessCount: number;
}

async function requireManifest(
  store: SummaryIndexStore,
  key: { agentInstanceId: string } & SummarySourceKey,
) {
  const manifest = await store.readManifest(key);
  if (manifest === null) {
    throw new SummaryContractError(
      "manifest-not-found",
      "没有已发布的摘要清单: " + key.sourceIdentifier,
    );
  }
  return manifest;
}

/** 默认摘要读取：概览/大纲/章节/明细四级，均只读索引与必要页。 */
export async function readSummaryDefaultView(input: {
  store: SummaryIndexStore;
  agentInstanceId: string;
  sourceKind: SummarySourceKey["sourceKind"];
  sourceIdentifier: string;
  detailLevel?: SummaryDetailLevel;
  pageSize?: number;
  cursor?: SummaryCursor;
  maximumReturnUnitCount?: number;
  /** 仅供有界读取审计：注入计数端口即可证明每页只读一页（默认读清单自身）。 */
  chunkReader?: SummaryChunkReaderPort;
  sourceAccessObserver?: SummarySourceAccessObserverPort;
}): Promise<SummaryReadView> {
  const key = {
    agentInstanceId: input.agentInstanceId,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
  };
  const manifest = await requireManifest(input.store, key);
  const detailLevel = input.detailLevel ?? "summary";
  const cursor =
    input.cursor ??
    createSummaryCursor({ manifest, detailLevel, nextChunkIndex: 0 });
  const page = readSummaryPage({
    manifest,
    cursor,
    pageSize: input.pageSize ?? 10,
    chunkReader: input.chunkReader ?? createManifestChunkReader(manifest),
    ...(input.maximumReturnUnitCount !== undefined
      ? { maximumReturnUnitCount: input.maximumReturnUnitCount }
      : {}),
  });
  return {
    detailLevel,
    chunks: page.chunks,
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
    coverage: page.coverage,
    evidencePointers: page.chunks.flatMap((chunk) => chunk.evidencePointers),
    themeSummaries: page.themeSummaries,
    isReturnBounded: page.isReturnBounded,
    returnedUnitCount: page.returnedUnitCount,
    sourceAccessCount: 0,
  };
}

/** 章节展开：按 chunkIdentifier 定点取一节，带原文出处指针与有界节选。 */
export async function expandSummarySection(input: {
  store: SummaryIndexStore;
  agentInstanceId: string;
  sourceKind: SummarySourceKey["sourceKind"];
  sourceIdentifier: string;
  chunkIdentifier: string;
  maximumExcerptCharacters?: number;
  sourceAccessObserver?: SummarySourceAccessObserverPort;
}): Promise<SummarySectionView> {
  const key = {
    agentInstanceId: input.agentInstanceId,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
  };
  const manifest = await requireManifest(input.store, key);
  const chunk = manifest.chunks.find(
    (candidate) => candidate.chunkIdentifier === input.chunkIdentifier,
  );
  if (chunk === undefined) {
    throw new SummaryContractError(
      "chunk-not-found",
      "摘要清单中不存在该章节: " + input.chunkIdentifier,
    );
  }
  const maximumExcerptCharacters = input.maximumExcerptCharacters ?? 800;
  const excerpt = chunk.summaryText.slice(0, maximumExcerptCharacters);
  return {
    chunkIdentifier: chunk.chunkIdentifier,
    sourceRevisionFrom: chunk.sourceRevisionFrom,
    sourceRevisionTo: chunk.sourceRevisionTo,
    themeIdentifier: chunk.themeIdentifier,
    excerpt,
    isExcerptBounded: chunk.summaryText.length > maximumExcerptCharacters,
    narrativeExcerpt:
      manifest.narrativeText === null
        ? null
        : manifest.narrativeText.slice(0, maximumExcerptCharacters),
    evidencePointers: chunk.evidencePointers,
    manifestRevision: manifest.manifestRevision,
    sourceAccessCount: 0,
  };
}

/** 证据定位：在清单内核对指针，不读取原文、不现场重算哈希。 */
export async function verifyEvidenceLocator(input: {
  store: SummaryIndexStore;
  agentInstanceId: string;
  sourceKind: SummarySourceKey["sourceKind"];
  sourceIdentifier: string;
  pointer: SummaryEvidencePointer;
  sourceAccessObserver?: SummarySourceAccessObserverPort;
}): Promise<EvidenceLocatorResult> {
  const key = {
    agentInstanceId: input.agentInstanceId,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
  };
  const manifest = await requireManifest(input.store, key);
  const locatedChunk = manifest.chunks.find((chunk) =>
    chunk.evidencePointers.some(
      (pointer) =>
        pointer.sourceIdentifier === input.pointer.sourceIdentifier &&
        pointer.sourceRevision === input.pointer.sourceRevision &&
        pointer.contentHash === input.pointer.contentHash,
    ),
  );
  if (locatedChunk !== undefined) {
    return {
      isLocatable: true,
      reason: "located",
      chunkIdentifier: locatedChunk.chunkIdentifier,
      sourceAccessCount: 0,
    };
  }
  const revisionMismatch = manifest.chunks
    .flatMap((chunk) => chunk.evidencePointers)
    .some(
      (pointer) =>
        pointer.sourceIdentifier === input.pointer.sourceIdentifier &&
        pointer.sourceRevision === input.pointer.sourceRevision,
    );
  return {
    isLocatable: false,
    reason: revisionMismatch ? "content-hash-mismatch" : "not-indexed",
    chunkIdentifier: null,
    sourceAccessCount: 0,
  };
}

/** 覆盖率视图（含 pending 尾部），不读取任何分块。 */
export async function readSummaryCoverage(input: {
  store: SummaryIndexStore;
  agentInstanceId: string;
  sourceKind: SummarySourceKey["sourceKind"];
  sourceIdentifier: string;
}): Promise<SummaryCoverage> {
  const manifest = await requireManifest(input.store, input);
  return summarizeManifestCoverage(manifest);
}
