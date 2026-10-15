/**
 * SUM-01-01（卡内 L29）：「**更新以新增内容量和阶段检查点触发，具体阈值由 01 测量决定**」
 * —— 本用例即该**触发阈值**的测量（本轮交付）。
 *
 * ## 为什么是"测量"而不是"实现"
 *
 * 卡内明写具体数值**先测后冻**；且 `SUM01_01` 报告 L54 如实记着
 * 「尚未冻结的具体数值（分页大小、**触发阈值**、更新频率、token 换算）在 02/04 测量后冻结」。
 * 代码里目前**没有消费该阈值的触发策略**（`advanceSummaryGeneration()` 是按需调用）
 * ⇒ 本轮产出**数据 + 建议冻结点**，不假装已经接上策略。
 *
 * ## 测什么（全部走**真实产品路径**，不造假存储）
 *
 * 用真实报告存档（`stateDirectory/main-agent-reports`）与真实发布入口
 * `publishReportSummarySourceFromArchive()`：对同一 mission 逐条 ingest 报告的**真实**写入，
 * 并按"**每新增 K 条触发一次更新**"的策略发布，比较不同 K 的**代价**与**滞后**：
 *
 * | 量 | 定义 | 方向 |
 * | --- | --- | --- |
 * | `totalEntriesDerived` | 各次发布的 `entryCount` 之和（**做过的重推导工作量**） | 越小越省 |
 * | `finalEntryCount` | 最后一次发布的条目数（**最终覆盖**） | 必须等于 N（不丢内容） |
 * | **冗余率** | `1 - finalEntryCount / totalEntriesDerived` | 越小越省 |
 * | **滞后** | `K - 1`（摘要最多落后多少条新增内容） | 越小越新 |
 *
 * ## 卡内纪律：质量侧**不得**用生成模型自评
 *
 * 卡内要求以「信息覆盖、**重复率**、任务回访质量」验证。本用例覆盖**可确定性计算**的前两项中
 * 的"重复（重推导）率"与"覆盖"；**"任务回访质量"须人工标注**（`SUM-02-04` 的评估器
 * 明确要求 `labelSource: "human"`、拒绝模型自评）⇒ **本轮未测，如实标注**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000 });

import {
  MainAgentReportArchiveIngestor,
  type TertiaryTerminalReport,
} from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

const REPORT_COUNT = 50;
/** 候选触发粒度：每新增 K 条报告触发一次摘要更新。 */
const TRIGGER_GRANULARITIES = [1, 2, 5, 10, 25];

const temporaryDirectories: string[] = [];

function buildReport(index: number): TertiaryTerminalReport {
  return {
    reportId: "report-" + String(index).padStart(3, "0"),
    missionId: "mission-trigger",
    taskBundleId: "task-" + String(index).padStart(3, "0"),
    reportingAgentInstanceId: "tertiary-" + String(index),
    reportKind: "completed",
    // 内容各异 ⇒ 条目内容哈希不同（重复条目会被适配器去重，这里刻意避免重复）
    summary: "第 " + String(index) + " 个三级任务完成并通过门禁",
    executedChecks: [{ command: "npm run check", exitCode: 0 }],
    createdAtIso: new Date(Date.UTC(2026, 9, 10, 0, 0, index)).toISOString(),
    contentHash: "sha256:" + String(index).padStart(64, "0"),
  };
}

async function measureDirectoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectoryBytes(entryPath);
    } else {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}

interface GranularityMeasurement {
  triggerGranularity: number;
  publishCount: number;
  totalEntriesDerived: number;
  finalEntryCount: number;
  redundancyRatio: number;
  lagInNewEntries: number;
  wallTimeMilliseconds: number;
  stateDirectoryBytes: number;
}

async function measureGranularity(triggerGranularity: number): Promise<GranularityMeasurement> {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-trigger-"));
  temporaryDirectories.push(stateDirectory);
  const ingestor = new MainAgentReportArchiveIngestor({ baseDirectory: stateDirectory });
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });

  let publishCount = 0;
  let totalEntriesDerived = 0;
  let finalEntryCount = 0;
  const startedAtMilliseconds = Date.now();
  try {
    for (let index = 1; index <= REPORT_COUNT; index += 1) {
      // **真实**写入报告存档（走产品的 ingestor，不手写文件）
      await ingestor.ingestReport(buildReport(index));
      if (index % triggerGranularity !== 0) continue;
      const outcome = await application.publishReportSummarySourceFromArchive({
        missionId: "mission-trigger",
        sourceIdentifier: "reports#mission-trigger",
      });
      if (outcome.entryCount > 0) publishCount += 1;
      totalEntriesDerived += outcome.entryCount;
      finalEntryCount = outcome.entryCount;
    }
  } finally {
    await application.shutdown();
  }
  const wallTimeMilliseconds = Date.now() - startedAtMilliseconds;
  const stateDirectoryBytes = await measureDirectoryBytes(stateDirectory);

  return {
    triggerGranularity,
    publishCount,
    totalEntriesDerived,
    finalEntryCount,
    redundancyRatio: Number((1 - finalEntryCount / totalEntriesDerived).toFixed(4)),
    lagInNewEntries: triggerGranularity - 1,
    wallTimeMilliseconds,
    stateDirectoryBytes,
  };
}

describe("SUM-01-01：摘要更新触发阈值测量（真实报告存档 + 真实发布入口）", () => {
  afterAll(async () => {
    for (const directory of temporaryDirectories) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("不同触发粒度下的代价/滞后权衡：覆盖必须完整，冗余率必须随粒度单调下降", async () => {
    const measurements: GranularityMeasurement[] = [];
    for (const triggerGranularity of TRIGGER_GRANULARITIES) {
      measurements.push(await measureGranularity(triggerGranularity));
    }
    console.log("SUM01_TRIGGER_MEASUREMENT=" + JSON.stringify(measurements));

    for (const measurement of measurements) {
      // ① 发布次数 = N / K（策略真的按粒度执行）
      expect(
        measurement.publishCount,
        "K=" + String(measurement.triggerGranularity) + " 的发布次数应为 N/K",
      ).toBe(REPORT_COUNT / measurement.triggerGranularity);
      /**
       * ② **覆盖完整性**：无论触发粒度多大，最终条目数必须等于报告总数 ——
       * 这是卡内"信息覆盖"最基本的一条，也是**阈值不能随意放大**的硬约束
       * （放大粒度只能省重推导，**不得丢内容**）。
       */
      expect(
        measurement.finalEntryCount,
        "K=" + String(measurement.triggerGranularity) + " 必须覆盖全部报告（不得因粒度大而丢条目）",
      ).toBe(REPORT_COUNT);
      // ③ 滞后 = K - 1（定义如此）
      expect(measurement.lagInNewEntries).toBe(measurement.triggerGranularity - 1);
      // ④ 冗余率落界
      expect(measurement.redundancyRatio).toBeGreaterThanOrEqual(0);
      expect(measurement.redundancyRatio).toBeLessThan(1);
    }

    // ⑤ 冗余率随粒度**单调不增**（省重推导的方向），滞后随之**单调增**（更陈旧的方向）
    const sortedByGranularity = [...measurements].sort(
      (left, right) => left.triggerGranularity - right.triggerGranularity,
    );
    for (let index = 1; index < sortedByGranularity.length; index += 1) {
      const previous = sortedByGranularity[index - 1]!;
      const current = sortedByGranularity[index]!;
      expect(
        current.redundancyRatio,
        "冗余率必须随触发粒度增大而单调不增（K=" + String(current.triggerGranularity) + "）",
      ).toBeLessThanOrEqual(previous.redundancyRatio);
      expect(current.lagInNewEntries).toBeGreaterThan(previous.lagInNewEntries);
    }
  });
});
