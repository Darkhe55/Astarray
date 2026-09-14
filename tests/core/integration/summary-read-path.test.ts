/**
 * SUM-01-03 集成测试：默认摘要与章节展开、分页有界读取、来源校验、旁置索引。
 *
 * 反例优先：读取触发原文访问、取一页扫全文、陈旧/跨 Agent 游标被接受、
 * 证据定位需要现场重算、旁置索引夹带正文。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SummaryIndexStore } from "../../../packages/core/src/summarization/summary-index-store.js";
import { advanceSummaryGeneration } from "../../../packages/core/src/summarization/summary-generation-service.js";
import {
  expandSummarySection,
  readSummaryDefaultView,
  verifyEvidenceLocator,
} from "../../../packages/core/src/summarization/summary-read-service.js";
import {
  assertSidecarIndexIsPointerOnly,
  buildSidecarIndexEntries,
} from "../../../packages/core/src/summarization/summary-sidecar-index.js";
import { createSummaryCursor } from "../../../packages/core/src/summarization/summary-manifest.js";
import type {
  SummaryChunk,
  SummarySourceKind,
} from "../../../packages/core/src/summarization/summary-manifest.js";
import type { SummarySourceEntry } from "../../../packages/core/src/summarization/summary-fact-extractor.js";

let stateDirectory: string;
const AGENT = "agent-read-1";
const SOURCE_KIND: SummarySourceKind = "conversation";
const SOURCE_IDENTIFIER = "session-read-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-03-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function expectErrorCode(task: () => unknown, expectedCode: string): void {
  try {
    task();
  } catch (error) {
    expect((error as { errorCode?: string }).errorCode).toBe(expectedCode);
    return;
  }
  throw new Error("未抛出预期错误: " + expectedCode);
}

function buildEntries(count: number): SummarySourceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceKind: SOURCE_KIND,
    sourceIdentifier: SOURCE_IDENTIFIER,
    sourceRevision: index + 1,
    contentHash: "h" + (index + 1),
    entryType: (index % 2 === 0 ? "message" : "decision") as
      | "message"
      | "decision",
    text: "第 " + (index + 1) + " 条记录内容",
    recordedAtIso: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }));
}

async function publishManifest(entryCount: number): Promise<SummaryIndexStore> {
  const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
  await advanceSummaryGeneration({
    store,
    agentInstanceId: AGENT,
    sourceKind: SOURCE_KIND,
    sourceIdentifier: SOURCE_IDENTIFIER,
    entries: buildEntries(entryCount),
    narrativeGenerator: {
      async generateNarrative(input: { facts: Array<unknown> }) {
        return "叙述覆盖 " + input.facts.length + " 条事实";
      },
    },
  });
  return store;
}

function createCountingChunkReader(chunks: SummaryChunk[]) {
  const counters = { reads: 0 };
  return {
    counters,
    reader: {
      readChunks: (fromIndex: number, count: number): SummaryChunk[] => {
        counters.reads += count;
        return chunks.slice(fromIndex, fromIndex + count);
      },
    },
  };
}

describe("SUM-01-03 默认摘要读取与章节展开", () => {
  it("概览级零分块读取，返回覆盖率与 pending 尾部", async () => {
    const store = await publishManifest(5);
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    const counting = createCountingChunkReader(manifest!.chunks);
    const view = await readSummaryDefaultView({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      detailLevel: "summary",
      pageSize: 10,
      chunkReader: counting.reader,
    });
    expect(counting.counters.reads).toBe(0);
    expect(view.chunks).toHaveLength(0);
    expect(view.coverage.coveredThroughSourceRevision).toBe(5);
    expect(view.coverage.pendingSourceRevisions).toEqual([]);
    // 主题按标识排序：decision(2 条) 在 message(3 条) 之前。
    expect(view.themeSummaries?.map((theme) => theme.chunkCount)).toEqual([2, 3]);
    expect(view.hasMore).toBe(false);
  });

  it("长摘要分页：取一页只读一页，游标可走完全部分块", async () => {
    const store = await publishManifest(103);
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    const counting = createCountingChunkReader(manifest!.chunks);
    let cursor = createSummaryCursor({
      manifest: manifest!,
      detailLevel: "section",
      nextChunkIndex: 0,
    });
    let seen = 0;
    let pageCount = 0;
    for (;;) {
      const view = await readSummaryDefaultView({
        store,
        agentInstanceId: AGENT,
        sourceKind: SOURCE_KIND,
        sourceIdentifier: SOURCE_IDENTIFIER,
        detailLevel: "section",
        pageSize: 5,
        cursor,
        chunkReader: counting.reader,
      });
      seen += view.chunks.length;
      pageCount += 1;
      expect(view.chunks.length).toBeLessThanOrEqual(5);
      if (!view.hasMore || view.nextCursor === null) {
        break;
      }
      cursor = view.nextCursor;
    }
    expect(seen).toBe(103);
    expect(pageCount).toBe(21);
    // 有界读取：总读取量 = 页数 × 页大小（不会现场扫全文）。
    expect(counting.counters.reads).toBe(105);
  });

  it("章节展开：定点取节 + 有界节选 + 证据指针；未知章节显式失败", async () => {
    const store = await publishManifest(20);
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    const target = manifest!.chunks[7]!;
    const section = await expandSummarySection({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      chunkIdentifier: target.chunkIdentifier,
      maximumExcerptCharacters: 6,
    });
    expect(section.chunkIdentifier).toBe(target.chunkIdentifier);
    expect(section.excerpt).toHaveLength(6);
    expect(section.isExcerptBounded).toBe(true);
    expect(section.evidencePointers[0]?.sourceRevision).toBe(
      target.sourceRevisionFrom,
    );
    expect(section.narrativeExcerpt).toContain("叙述覆盖");
    expect(section.sourceAccessCount).toBe(0);

    await expect(
      expandSummarySection({
        store,
        agentInstanceId: AGENT,
        sourceKind: SOURCE_KIND,
        sourceIdentifier: SOURCE_IDENTIFIER,
        chunkIdentifier: "chunk-does-not-exist",
      }),
    ).rejects.toMatchObject({ errorCode: "chunk-not-found" });
  });

  it("陈旧/跨 Agent 游标一律拒绝", async () => {
    const store = await publishManifest(6);
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    const sectionCursor = createSummaryCursor({
      manifest: manifest!,
      detailLevel: "section",
      nextChunkIndex: 2,
    });
    // 跨 Agent：同一份清单但游标属于别的 Agent。
    await expect(
      readSummaryDefaultView({
        store,
        agentInstanceId: AGENT,
        sourceKind: SOURCE_KIND,
        sourceIdentifier: SOURCE_IDENTIFIER,
        detailLevel: "section",
        pageSize: 2,
        cursor: { ...sectionCursor, agentInstanceId: "agent-other" },
      }),
    ).rejects.toMatchObject({ errorCode: "cross-agent-cursor" });

    // 清单前进后旧游标失效（新增来源 → 新 revision）。
    await advanceSummaryGeneration({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      entries: buildEntries(8),
      narrativeGenerator: {
        async generateNarrative(input: { facts: Array<unknown> }) {
          return "叙述 " + input.facts.length;
        },
      },
    });
    await expect(
      readSummaryDefaultView({
        store,
        agentInstanceId: AGENT,
        sourceKind: SOURCE_KIND,
        sourceIdentifier: SOURCE_IDENTIFIER,
        detailLevel: "section",
        pageSize: 2,
        cursor: sectionCursor,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-cursor" });
  });

  it("全部读取路径均不读取原文（观测端口计数为 0）", async () => {
    const store = await publishManifest(12);
    const accesses: Array<{ sourceIdentifier: string; sourceRevision: number }> = [];
    const observer = {
      recordSourceAccess(input: {
        sourceIdentifier: string;
        sourceRevision: number;
      }): void {
        accesses.push(input);
      },
    };
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    await readSummaryDefaultView({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      detailLevel: "detail",
      pageSize: 12,
      sourceAccessObserver: observer,
    });
    await expandSummarySection({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      chunkIdentifier: manifest!.chunks[0]!.chunkIdentifier,
      sourceAccessObserver: observer,
    });
    await verifyEvidenceLocator({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      pointer: manifest!.chunks[0]!.evidencePointers[0]!,
      sourceAccessObserver: observer,
    });
    expect(accesses).toEqual([]);
  });

  it("证据定位在清单内完成：命中/哈希不符/未索引可区分", async () => {
    const store = await publishManifest(4);
    const manifest = await store.readManifest({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    const storedPointer = manifest!.chunks[2]!.evidencePointers[0]!;
    const located = await verifyEvidenceLocator({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      pointer: storedPointer,
    });
    expect(located.isLocatable).toBe(true);
    expect(located.reason).toBe("located");
    expect(located.chunkIdentifier).toBe(manifest!.chunks[2]!.chunkIdentifier);

    const mismatched = await verifyEvidenceLocator({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      pointer: { ...storedPointer, contentHash: "tampered" },
    });
    expect(mismatched.reason).toBe("content-hash-mismatch");
    expect(mismatched.isLocatable).toBe(false);

    const notIndexed = await verifyEvidenceLocator({
      store,
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      pointer: { ...storedPointer, sourceRevision: 999 },
    });
    expect(notIndexed.reason).toBe("not-indexed");
    expect(notIndexed.sourceAccessCount).toBe(0);
  });

  it("源码/媒体旁置索引只存指针：夹带正文被拒，原格式不被改写", async () => {
    const store = await publishManifest(3);
    const entries = buildSidecarIndexEntries(
      Array.from({ length: 100 }, (_, index) => ({
        sourceKind: (index % 2 === 0 ? "source-file" : "media-file") as
          | "source-file"
          | "media-file",
        sourceIdentifier: "src/module-" + index + ".ts",
        sourceRevision: 1,
        contentHash: "sha-" + index,
        byteLength: 1024 + index,
        mediaType: index % 2 === 0 ? "text/typescript" : "image/png",
        recordedAtIso: new Date(2026, 0, 1).toISOString(),
      })),
    );
    expect(entries).toHaveLength(100);
    expect(entries.every((entry) => entry.pointerOnly)).toBe(true);
    await store.writeSidecarIndex({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
      entries,
    });
    const readBack = await store.readSidecarIndex({
      agentInstanceId: AGENT,
      sourceKind: SOURCE_KIND,
      sourceIdentifier: SOURCE_IDENTIFIER,
    });
    expect(readBack).toHaveLength(100);
    expect(JSON.stringify(readBack)).not.toContain("词法内容");

    // 反例：把正文塞进索引必须被拒。
    expectErrorCode(
      () =>
        assertSidecarIndexIsPointerOnly([
          { ...entries[0], content: "原始文件全文" },
        ]),
      "journal-corrupted",
    );
    expectErrorCode(
      () =>
        assertSidecarIndexIsPointerOnly([
          {
            sourceKind: "source-file",
            sourceIdentifier: "a.ts",
            sourceRevision: 1,
            contentHash: "x",
            pointerOnly: true,
            unknownField: 1,
          },
        ]),
      "journal-corrupted",
    );
  });
});
