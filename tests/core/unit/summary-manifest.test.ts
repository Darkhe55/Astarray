/**
 * SUM-01-01：摘要清单/游标/动态详细度契约的行为反例（先红后绿）。
 *
 * 反例覆盖：固定总长裁剪、跨 Agent 游标、陈旧游标、重复消息双计、
 * 分页读取越界（取一页却扫全文）、尾部 pending 丢失。
 */
import { describe, expect, it } from "vitest";

import {
  appendSummarySource,
  buildDynamicDetailView,
  createManifestChunkReader,
  createSummaryCursor,
  createSummaryManifest,
  readSummaryPage,
  summarizeManifestCoverage,
  SummaryContractError,
} from "../../../packages/core/src/summarization/summary-manifest.js";

function buildLongManifest(sourceCount: number) {
  let manifest = createSummaryManifest({
    agentInstanceId: "agent-summary-1",
    sourceKind: "conversation",
    sourceIdentifier: "session-1",
    generatorVersion: "prototype-1",
  });
  for (let revision = 1; revision <= sourceCount; revision += 1) {
    manifest = appendSummarySource(manifest, {
      sourceRevision: revision,
      contentHash: "hash-" + revision.toString(16).padStart(64, "0").slice(0, 64),
      summaryText: "主题" + (revision % 3) + " 的第 " + revision + " 条摘要",
      themeIdentifier: "theme-" + (revision % 3),
      estimatedUnitCount: 10,
      evidencePointers: [
        {
          sourceKind: "conversation",
          sourceIdentifier: "message-" + revision,
          sourceRevision: revision,
          contentHash: "hash-" + revision,
        },
      ],
    }).manifest;
  }
  return manifest;
}

describe("SUM-01-01 摘要清单与动态详细度契约", () => {
  it("短会话：覆盖 revision 前进、pending 尾部为空", () => {
    let manifest = createSummaryManifest({
      agentInstanceId: "agent-summary-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-short",
      generatorVersion: "prototype-1",
    });
    expect(manifest.manifestRevision).toBe(1);
    expect(manifest.chunks).toHaveLength(0);

    for (const revision of [1, 2]) {
      manifest = appendSummarySource(manifest, {
        sourceRevision: revision,
        contentHash: "h" + revision,
        summaryText: "第 " + revision + " 条",
        themeIdentifier: "theme-a",
        estimatedUnitCount: 5,
        evidencePointers: [
          {
            sourceKind: "conversation",
            sourceIdentifier: "message-" + revision,
            sourceRevision: revision,
            contentHash: "h" + revision,
          },
        ],
      }).manifest;
    }
    const coverage = summarizeManifestCoverage(manifest);
    expect(coverage.coveredThroughSourceRevision).toBe(2);
    expect(coverage.pendingSourceRevisions).toEqual([]);
    expect(manifest.manifestRevision).toBe(3);
  });

  it("长会话与重复消息：无固定总长裁剪，重复来源不双计", () => {
    let manifest = buildLongManifest(300);
    expect(manifest.chunks).toHaveLength(300);

    // 重复消息（同一 sourceRevision + 同一 contentHash）：不新增分块、不双计证据。
    const duplicate = appendSummarySource(manifest, {
      sourceRevision: 300,
      contentHash: manifest.chunks.at(-1)?.evidencePointers[0]?.contentHash ?? "",
      summaryText: "重复投递",
      themeIdentifier: "theme-0",
      estimatedUnitCount: 10,
      evidencePointers: [
        {
          sourceKind: "conversation",
          sourceIdentifier: "message-300",
          sourceRevision: 300,
          contentHash: manifest.chunks.at(-1)?.evidencePointers[0]?.contentHash ?? "",
        },
      ],
    });
    expect(duplicate.wasDuplicate).toBe(true);
    expect(duplicate.manifest.chunks).toHaveLength(300);
    manifest = duplicate.manifest;

    // 继续增长到 2000 条：清单不因任何固定上限被裁剪。
    for (let revision = 301; revision <= 2000; revision += 1) {
      manifest = appendSummarySource(manifest, {
        sourceRevision: revision,
        contentHash: "hash-" + revision,
        summaryText: "长会话第 " + revision + " 条",
        themeIdentifier: "theme-" + (revision % 3),
        estimatedUnitCount: 10,
        evidencePointers: [
          {
            sourceKind: "conversation",
            sourceIdentifier: "message-" + revision,
            sourceRevision: revision,
            contentHash: "hash-" + revision,
          },
        ],
      }).manifest;
    }
    expect(manifest.chunks).toHaveLength(2000);
    expect(summarizeManifestCoverage(manifest).chunkCount).toBe(2000);
    expect(summarizeManifestCoverage(manifest).coveredThroughSourceRevision).toBe(2000);
  });

  it("同一 revision 内容变化：显式拒绝而不是静默覆盖", () => {
    const manifest = buildLongManifest(3);
    expect(() =>
      appendSummarySource(manifest, {
        sourceRevision: 2,
        contentHash: "different-hash",
        summaryText: "改过的第 2 条",
        themeIdentifier: "theme-9",
        estimatedUnitCount: 10,
        evidencePointers: [],
      }),
    ).toThrow(SummaryContractError);
  });

  it("尾部 pending：缺口 revision 显式记录，补齐后清空", () => {
    const manifest = buildLongManifest(2);
    const withGap = appendSummarySource(manifest, {
      sourceRevision: 5,
      contentHash: "hash-5",
      summaryText: "跳号到达",
      themeIdentifier: "theme-1",
      estimatedUnitCount: 10,
      evidencePointers: [],
    }).manifest;
    expect(summarizeManifestCoverage(withGap).pendingSourceRevisions).toEqual([3, 4]);

    let filled = appendSummarySource(withGap, {
      sourceRevision: 3,
      contentHash: "hash-3",
      summaryText: "补第 3 条",
      themeIdentifier: "theme-0",
      estimatedUnitCount: 10,
      evidencePointers: [],
    }).manifest;
    filled = appendSummarySource(filled, {
      sourceRevision: 4,
      contentHash: "hash-4",
      summaryText: "补第 4 条",
      themeIdentifier: "theme-1",
      estimatedUnitCount: 10,
      evidencePointers: [],
    }).manifest;
    expect(summarizeManifestCoverage(filled).pendingSourceRevisions).toEqual([]);
  });

  it("游标绑定 Agent 与清单 revision：跨 Agent/陈旧一律拒绝", () => {
    const manifest = buildLongManifest(12);
    const otherAgentManifest = {
      ...manifest,
      agentInstanceId: "agent-summary-2",
    };
    const cursor = createSummaryCursor({
      manifest,
      detailLevel: "section",
      nextChunkIndex: 5,
    });
    expect(() =>
      readSummaryPage({
        manifest: otherAgentManifest,
        cursor,
        pageSize: 5,
        chunkReader: createManifestChunkReader(otherAgentManifest),
      }),
    ).toThrow(/cross-agent-cursor|Agent/);

    const advanced = appendSummarySource(manifest, {
      sourceRevision: 13,
      contentHash: "hash-13",
      summaryText: "新到的第 13 条",
      themeIdentifier: "theme-0",
      estimatedUnitCount: 10,
      evidencePointers: [],
    }).manifest;
    expect(() =>
      readSummaryPage({
        manifest: advanced,
        cursor,
        pageSize: 5,
        chunkReader: createManifestChunkReader(advanced),
      }),
    ).toThrow(SummaryContractError);
  });

  it("分页取一页只读一页：游标可走完全部区块且读取数有界", () => {
    const manifest = buildLongManifest(103);
    let cursor = createSummaryCursor({
      manifest,
      detailLevel: "section",
      nextChunkIndex: 0,
    });
    let readChunkCount = 0;
    let pageCount = 0;
    let seen = 0;
    for (;;) {
      const reader = {
        readChunks: (fromIndex: number, count: number) => {
          readChunkCount += count;
          return manifest.chunks.slice(fromIndex, fromIndex + count);
        },
      };
      const page = readSummaryPage({
        manifest,
        cursor,
        pageSize: 10,
        chunkReader: reader,
      });
      seen += page.chunks.length;
      pageCount += 1;
      expect(page.chunks.length).toBeLessThanOrEqual(10);
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
      expect(pageCount).toBeLessThanOrEqual(11);
    }
    expect(seen).toBe(103);
    expect(readChunkCount).toBe(110);
  });

  it("动态详细度：summary/outline/section/detail 逐级展开，单次返回预算不裁剪清单", () => {
    const manifest = buildLongManifest(30);
    const reader = createManifestChunkReader(manifest);
    const summary = buildDynamicDetailView({
      manifest,
      detailLevel: "summary",
      pageSize: 10,
      chunkReader: reader,
    });
    const outline = buildDynamicDetailView({
      manifest,
      detailLevel: "outline",
      pageSize: 10,
      chunkReader: reader,
    });
    const detail = buildDynamicDetailView({
      manifest,
      detailLevel: "detail",
      pageSize: 10,
      chunkReader: reader,
    });
    expect(summary.returnedUnitCount).toBeLessThan(outline.returnedUnitCount);
    expect(outline.returnedUnitCount).toBeLessThan(detail.returnedUnitCount);
    expect(summary.isReturnBounded).toBe(true);
    expect(manifest.chunks).toHaveLength(30);

    const bounded = buildDynamicDetailView({
      manifest,
      detailLevel: "detail",
      pageSize: 30,
      maximumReturnUnitCount: 60,
      chunkReader: reader,
    });
    expect(bounded.returnedUnitCount).toBeLessThanOrEqual(60);
    expect(bounded.isReturnBounded).toBe(true);
    expect(bounded.chunks.length).toBeLessThan(30);
    expect(manifest.chunks).toHaveLength(30);
  });
});
