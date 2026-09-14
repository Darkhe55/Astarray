/**
 * SUM-01-04a 集成测试：真实 mission 工作存档 → 公共门面摘要读取（产品接线）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade | null = null;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-04a-"));
  application = null;
});

afterEach(async () => {
  await application?.shutdown().catch(() => {});
  application = null;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function runMissionAndOpenApplication(): Promise<{
  facade: AstarrayApplicationFacade;
  missionIdentifier: string;
}> {
  const facade = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
  application = facade;
  facade.createSession({ sessionId: "session-summary", mode: "assist" });
  const submitted = await facade.submitTask({
    sessionId: "session-summary",
    taskIdentifier: "task-summary-1",
    prompt: "生成可供摘要的工作记录",
  });
  const deadline = Date.now() + 30_000;
  let status = submitted.status;
  while (
    !["done", "failed", "blocked", "cancelled"].includes(status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (
      await facade.queryTask({
        sessionId: "session-summary",
        taskIdentifier: submitted.taskIdentifier,
      })
    ).status;
  }
  expect(status).toBe("done");
  expect(submitted.missionIdentifier).toBeTruthy();
  return { facade, missionIdentifier: submitted.missionIdentifier ?? "" };
}

describe("SUM-01-04a 摘要产品接线", () => {
  it("真实 mission 存档可生成摘要并经公共门面读取与展开", async () => {
    const { facade, missionIdentifier } = await runMissionAndOpenApplication();

    const build = await facade.summarizeArchivedMission({
      missionId: missionIdentifier,
    });
    expect(build.entryCount).toBeGreaterThan(0);
    expect(build.chunkCount).toBeGreaterThan(0);
    expect(build.generatorVersion).toBe("local-extractive-1");

    const sources = await facade.listSummarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      sourceKind: "work-archive",
      sourceIdentifier: missionIdentifier,
      chunkCount: build.chunkCount,
      generatorVersion: "local-extractive-1",
    });
    expect(JSON.stringify(sources)).not.toContain(stateDirectory);

    const overview = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "summary",
    });
    expect(overview.kind).toBe("page");
    expect(overview.chunks).toHaveLength(0);
    expect(overview.coverage.chunkCount).toBe(build.chunkCount);
    expect(overview.resourceMetrics.manifestFileBytes).toBeGreaterThan(0);
    expect(overview.resourceMetrics.sourceAccessCount).toBe(0);
    expect(overview.resourceMetrics.diskReadOperationCount).toBe(1);
    expect(overview.resourceMetrics.wallMilliseconds).toBeGreaterThanOrEqual(0);

    const sectionPage = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "section",
      pageSize: 2,
      pageIndex: 0,
    });
    expect(sectionPage.chunks.length).toBeGreaterThan(0);
    const firstChunk = sectionPage.chunks[0]!;
    expect(firstChunk.excerpt.length).toBeGreaterThan(0);

    // 节选上限取 4：真实存档摘要必然更长，能验证"本次返回被裁剪"。
    const section = await facade.expandSummarySectionView({
      sourceIdentifier: missionIdentifier,
      chunkIdentifier: firstChunk.chunkIdentifier,
      maximumExcerptCharacters: 4,
    });
    expect(section.kind).toBe("section");
    expect(section.excerpt).toHaveLength(4);
    expect(section.isExcerptBounded).toBe(true);
    expect(section.evidencePointers[0]?.sourceIdentifier).toContain("#");
    // 叙述节选同样受本次返回上限约束（清单中的叙述未被裁剪）。
    expect(section.narrativeExcerpt).toHaveLength(4);
    const wider = await facade.expandSummarySectionView({
      sourceIdentifier: missionIdentifier,
      chunkIdentifier: firstChunk.chunkIdentifier,
    });
    expect(wider.narrativeExcerpt).toContain("本地抽取式摘要");
    expect(section.resourceMetrics.sourceAccessCount).toBe(0);
  });

  it("翻页一致性与缺失来源的诚实状态", async () => {
    const { facade, missionIdentifier } = await runMissionAndOpenApplication();
    await facade.summarizeArchivedMission({ missionId: missionIdentifier });

    const firstPage = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "section",
      pageSize: 1,
      pageIndex: 0,
    });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextPageIndex).toBe(1);

    const secondPage = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "section",
      pageSize: 1,
      pageIndex: 1,
      expectedManifestRevision: firstPage.manifestRevision,
    });
    expect(secondPage.chunks[0]?.chunkIdentifier).not.toBe(
      firstPage.chunks[0]?.chunkIdentifier,
    );

    await expect(
      facade.readSummaryView({
        sourceIdentifier: missionIdentifier,
        expectedManifestRevision: firstPage.manifestRevision - 1,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-cursor" });

    await expect(
      facade.readSummaryView({ sourceIdentifier: "mission-does-not-exist" }),
    ).rejects.toMatchObject({ errorCode: "summary-not-found" });
  });

  it("资源不足时只裁剪本次返回，绝不丢正文", async () => {
    const { facade, missionIdentifier } = await runMissionAndOpenApplication();
    const build = await facade.summarizeArchivedMission({
      missionId: missionIdentifier,
    });

    const bounded = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "detail",
      pageSize: build.chunkCount,
      maximumReturnUnitCount: 1,
    });
    expect(bounded.isReturnBounded).toBe(true);
    expect(bounded.returnedUnitCount).toBeLessThanOrEqual(1);
    expect(bounded.coverage.chunkCount).toBe(build.chunkCount);

    // 清单未被裁剪：完整读取仍能拿到全部分块。
    const complete = await facade.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "detail",
      pageSize: build.chunkCount,
    });
    expect(complete.coverage.chunkCount).toBe(build.chunkCount);
    expect(complete.chunks.length).toBeGreaterThan(0);
  });
});
