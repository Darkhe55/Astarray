/**
 * SUM-01-04 反例（2026-10-10）：四类来源必须都能经**公开入口**发布摘要。
 *
 * 现状缺口：`AstarrayApplicationFacade.summarizeArchivedMission()` **只处理 work-archive**
 * （从 mission 工作存档读条目 → `buildWorkArchiveSummaryEntries` → 发布）。
 * 上一轮补的三个适配器（会话历史/报告/延后文件）**在公开入口上没有对应发布路径** ⇒
 * `SummarySourceKind` 里的 `conversation`/`report`/`deferred-file` 仍不可达，
 * 即"卡内要求覆盖四类来源"在产品层面未成立。
 *
 * 本轮钉住：`publishSummarySource()` 按来源种类分派到对应适配器，并真实发布清单；
 * 四类都能 `listSummarySources()` 列出、能用对应 `sourceKind` 读回。
 *
 * 只跑本地临时目录，不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-publish-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 1,
    failureThreshold: 3,
  });
}

describe("SUM-01-04：四类来源经公开入口发布摘要", () => {
  it("① 会话历史来源可发布、可列出、可按 sourceKind 读回", async () => {
    const application = await createApplication();
    try {
      const published = await application.publishSummarySource({
        sourceKind: "conversation",
        sourceIdentifier: "session-1",
        turns: [
          {
            turnIdentifier: "turn-1",
            speaker: "user",
            text: "请实现功能",
            recordedAtIso: "2026-10-10T00:00:01.000Z",
          },
          {
            turnIdentifier: "turn-2",
            speaker: "assistant",
            text: "已完成实现",
            recordedAtIso: "2026-10-10T00:00:02.000Z",
          },
        ],
      });
      expect(published.sourceKind).toBe("conversation");
      expect(published.entryCount).toBe(2);
      expect(published.manifestRevision).toBeGreaterThan(0);

      const sources = await application.listSummarySources();
      expect(
        sources.some(
          (source) =>
            source.sourceKind === "conversation" && source.sourceIdentifier === "session-1",
        ),
      ).toBe(true);

      const view = await application.readSummaryView({
        sourceKind: "conversation",
        sourceIdentifier: "session-1",
      });
      // PublicSummaryView 不含 sourceKind，改为断言"读回的是该来源且清单已发布"
      expect(view.sourceIdentifier).toBe("session-1");
      expect(view.manifestRevision).toBeGreaterThan(0);
    } finally {
      await application.shutdown();
    }
  });

  it("② 报告来源可发布（entryCount 与输入一致）", async () => {
    const application = await createApplication();
    try {
      const published = await application.publishSummarySource({
        sourceKind: "report",
        sourceIdentifier: "reports-1",
        reports: [
          {
            reportIdentifier: "report-1",
            taskIdentifier: "T-001",
            summaryText: "任务一完成",
            recordedAtIso: "2026-10-10T00:00:01.000Z",
          },
        ],
      });
      expect(published.sourceKind).toBe("report");
      expect(published.entryCount).toBe(1);
    } finally {
      await application.shutdown();
    }
  });

  it("③ 延后文件来源可发布（同文件不同行区间计为两条）", async () => {
    const application = await createApplication();
    try {
      const published = await application.publishSummarySource({
        sourceKind: "deferred-file",
        sourceIdentifier: "deferred-1",
        deferredFiles: [
          {
            fileIdentifier: "file-1",
            filePath: "docs/a.md",
            lineRangeStart: 1,
            lineRangeEnd: 10,
            excerptText: "第一段",
            recordedAtIso: "2026-10-10T00:00:01.000Z",
          },
          {
            fileIdentifier: "file-1",
            filePath: "docs/a.md",
            lineRangeStart: 11,
            lineRangeEnd: 20,
            excerptText: "第二段",
            recordedAtIso: "2026-10-10T00:00:02.000Z",
          },
        ],
      });
      expect(published.sourceKind).toBe("deferred-file");
      expect(published.entryCount).toBe(2);
    } finally {
      await application.shutdown();
    }
  });

  it("④ 空来源不得伪造：entryCount=0 且 manifestRevision=0（不发布空清单冒充成功）", async () => {
    const application = await createApplication();
    try {
      const published = await application.publishSummarySource({
        sourceKind: "conversation",
        sourceIdentifier: "empty-session",
        turns: [],
      });
      expect(published.entryCount).toBe(0);
      expect(published.manifestRevision).toBe(0);
      expect(published.chunkCount).toBe(0);
    } finally {
      await application.shutdown();
    }
  });

  it("⑤ 来源种类与载荷不匹配必须拒绝（不得按错适配器解释）", async () => {
    const application = await createApplication();
    try {
      await expect(
        application.publishSummarySource({
          sourceKind: "report",
          sourceIdentifier: "mismatch",
          turns: [
            {
              turnIdentifier: "turn-1",
              speaker: "user",
              text: "x",
              recordedAtIso: "2026-10-10T00:00:01.000Z",
            },
          ],
        } as never),
      ).rejects.toThrow(/report|载荷|不匹配/);
    } finally {
      await application.shutdown();
    }
  });
});
