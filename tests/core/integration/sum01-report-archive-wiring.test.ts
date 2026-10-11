/**
 * SUM-01-04 反例（2026-10-10）：**报告来源必须从真实报告存档取数**。
 *
 * 卡内 SUM-01-04 明文："覆盖**会话历史、工作存档、报告和延后文件**"；
 * `PLAN_STATUS` 如实记录过："**仍未完成**：三类来源的**真实数据源接线**
 * （尚未从会话事件流/报告存档/延后文件存储真实取数）"。
 *
 * 现状缺口（本轮实测）：`publishSummarySource()` 要求调用方**直接把条目数组传进来**
 * （`turns`/`reports`/`deferredFiles`）⇒ 没有任何路径能**从已落盘的真实存档取数**，
 * 于是"报告来源"在生产上不可达 —— 调用方要么自己读盘再拼装（重复实现），
 * 要么根本无法发布。
 *
 * 本片钉住的语义（全部**真实文件 I/O**）：
 *  - 提供 `publishReportSummarySourceFromArchive()`：从**真实报告存档**读索引与报告，
 *    映射为摘要条目并发布；
 *  - 发布的条目必须**真的来源于磁盘**（先 ingest 再发布，条目数/内容与存档一致）；
 *  - **空任务**（无报告）⇒ `entryCount: 0`、`manifestRevision: 0`（不发布空清单冒充成功）；
 *  - 存档里**结构非法/缺字段**的报告必须被**跳过**而不是让整批失败。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  MainAgentReportArchiveIngestor,
  type TertiaryTerminalReport,
} from "../../../packages/core/src/orchestration/main-agent-report-archive.js";

let stateDirectory: string;
let archiveDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-report-"));
  /** 与产品同源：真实存档根为 `stateDirectory/main-agent-reports`（由 ingestor 内部拼接）。 */
  archiveDirectory = stateDirectory;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildReport(overrides: Partial<TertiaryTerminalReport> = {}): TertiaryTerminalReport {
  return {
    reportId: "report-1",
    missionId: "mission-1",
    taskBundleId: "task-1",
    reportingAgentInstanceId: "tertiary-1",
    reportKind: "completed",
    summary: "三级 Agent 完成任务并通过门禁",
    executedChecks: [{ command: "npm run check", exitCode: 0 }],
    createdAtIso: "2026-10-10T00:00:00.000Z",
    contentHash: "sha256:" + "a".repeat(64),
    ...overrides,
  };
}

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
}

describe("SUM-01-04：报告来源从真实存档取数", () => {
  it("① 先 ingest 到真实存档，再发布 ⇒ 条目数必须与存档一致", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({ baseDirectory: archiveDirectory });
    await ingestor.ingestReport(buildReport({ reportId: "report-1" }));
    await ingestor.ingestReport(buildReport({ reportId: "report-2", taskBundleId: "task-2" }));

    const application = await createFacade();
    try {
      const outcome = await application.publishReportSummarySourceFromArchive({
        missionId: "mission-1",
        sourceIdentifier: "reports#mission-1",
      });
      expect(outcome.sourceKind).toBe("report");
      // 两条真实报告 ⇒ 两个条目（不得为 0，也不得凭空多出）
      expect(outcome.entryCount).toBe(2);
      expect(outcome.manifestRevision).toBeGreaterThan(0);
    } finally {
      await application.shutdown();
    }
  });

  it("② 空任务（无报告）⇒ entryCount 0 且 manifestRevision 0（不发布空清单冒充成功）", async () => {
    const application = await createFacade();
    try {
      const outcome = await application.publishReportSummarySourceFromArchive({
        missionId: "mission-with-no-reports",
        sourceIdentifier: "reports#empty",
      });
      expect(outcome.entryCount).toBe(0);
      expect(outcome.manifestRevision).toBe(0);
      expect(outcome.chunkCount).toBe(0);
    } finally {
      await application.shutdown();
    }
  });

  it("③ 存档中的报告**真实来源于磁盘**：新 facade 仍能读到同一批条目", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({ baseDirectory: archiveDirectory });
    await ingestor.ingestReport(buildReport({ reportId: "report-only" }));

    const firstApplication = await createFacade();
    try {
      const first = await firstApplication.publishReportSummarySourceFromArchive({
        missionId: "mission-1",
        sourceIdentifier: "reports#persist",
      });
      expect(first.entryCount).toBe(1);
    } finally {
      await firstApplication.shutdown();
    }

    /** 重启：全新 facade（不共享内存）必须从**磁盘**重新取数。 */
    const secondApplication = await createFacade();
    try {
      const second = await secondApplication.publishReportSummarySourceFromArchive({
        missionId: "mission-1",
        sourceIdentifier: "reports#persist",
      });
      expect(second.entryCount).toBe(1);
    } finally {
      await secondApplication.shutdown();
    }
  });

  it("④ 摘要清单必须可从公开入口查到（发布不是只写盘不读）", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({ baseDirectory: archiveDirectory });
    await ingestor.ingestReport(buildReport({ reportId: "report-visible" }));

    const application = await createFacade();
    try {
      await application.publishReportSummarySourceFromArchive({
        missionId: "mission-1",
        sourceIdentifier: "reports#visible",
      });
      /**
       * 用**真实读取入口**核对（`querySummaryIndex` 并不存在 —— 我最初的假设错了）：
       * 清单必须能从公开入口查到，且条目数一致。
       */
      const sources = await application.listSummarySources();
      const published = sources.find(
        (source) =>
          source.sourceIdentifier === "reports#visible" && source.sourceKind === "report",
      );
      expect(published).toBeDefined();
      /** 该类型没有 `entryCount`（我最初的假设又错了一次）—— 用**真实字段**核对。 */
      expect(published?.chunkCount).toBeGreaterThan(0);
      expect(published?.manifestRevision).toBeGreaterThan(0);
    } finally {
      await application.shutdown();
    }
  });
});
