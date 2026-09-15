/**
 * SUM-01-04b：安装包消费验证 —— 从隔离安装的 astarray 包读取"大历史摘要"再展开。
 *
 * 用法：node scripts/verify-summary-package.mjs --package-dir <已安装包目录> [--state-dir <目录>]
 * 说明：
 * - 大历史以**文档化 schema** 的工作存档 fixture 形式落盘（纯数据，不是仓库代码）；
 * - 随后只用**安装包导出的公共 SDK**（dist/public-sdk.js）做构建、读取、分页与展开，
 *   证明打包产物自身能消费大历史摘要；
 * - 记录设备规格、输入规模、磁盘索引大小、耗时与"资源不足只裁剪本次返回"。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

const packageDirectoryPath = readArgument("--package-dir", null);
if (packageDirectoryPath === null) {
  console.error("缺少 --package-dir <已安装包目录>");
  process.exit(2);
}
const agentCount = Number.parseInt(readArgument("--agent-count", "6"), 10);
const entriesPerAgent = Number.parseInt(readArgument("--entries-per-agent", "400"), 10);
const stateDirectory =
  readArgument("--state-dir", null) ??
  path.join(os.tmpdir(), "astarray-summary-package-" + randomUUID());
const missionIdentifier = "mission-summary-package-verify";
const entryTypes = ["assignment", "progress", "decision", "result", "failure", "handoff"];

function buildArchiveFixture() {
  let archiveBytes = 0;
  let estimatedEntryCount = 0;
  for (let agentIndex = 0; agentIndex < agentCount; agentIndex += 1) {
    const agentInstanceId = "package-verify-agent-" + String(agentIndex);
    const entries = [];
    for (let entryIndex = 0; entryIndex < entriesPerAgent; entryIndex += 1) {
      const recordedAtIso = new Date(
        Date.UTC(2026, 0, 1) + (agentIndex * entriesPerAgent + entryIndex) * 1000,
      ).toISOString();
      entries.push({
        archiveEntryId: "entry-" + String(agentIndex) + "-" + String(entryIndex),
        recordedAtIso,
        taskId: "T-" + String(entryIndex % 25),
        entryType: entryTypes[entryIndex % entryTypes.length],
        summary:
          "第 " +
          String(entryIndex) +
          " 条工作记录：实现/测试/复核细节 " +
          "x".repeat(24),
        artifactReferences: [],
      });
    }
    estimatedEntryCount += entries.length;
    const archive = {
      schemaVersion: 1,
      missionId: missionIdentifier,
      agentInstanceId,
      agentRole: "tertiary",
      revision: Math.max(1, entries.length),
      updatedAtIso: new Date().toISOString(),
      entries,
    };
    const archivePath = path.join(
      stateDirectory,
      "missions",
      missionIdentifier,
      "agents",
      agentInstanceId,
      "work-archive.json",
    );
    mkdirSync(path.dirname(archivePath), { recursive: true });
    const serialized = JSON.stringify(archive);
    writeFileSync(archivePath, serialized, "utf8");
    archiveBytes += Buffer.byteLength(serialized, "utf8");
  }
  return { archiveBytes, estimatedEntryCount };
}

try {
  const fixture = buildArchiveFixture();
  const publicSdkPath = path.join(
    packageDirectoryPath,
    "dist",
    "public-sdk.js",
  );
  const { AstarrayApplicationFacade } = await import(
    pathToFileURL(publicSdkPath).href
  );
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    statusPollIntervalMilliseconds: 10,
  });
  const checks = {};
  try {
    application.createSession({ sessionId: "package-verify", mode: "assist" });

    const summarizeStartedAtMs = Date.now();
    const build = await application.summarizeArchivedMission({
      missionId: missionIdentifier,
    });
    const summarizeMilliseconds = Date.now() - summarizeStartedAtMs;

    const sources = await application.listSummarySources();
    const overview = await application.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "summary",
    });

    const paginateStartedAtMs = Date.now();
    let pageIndex = 0;
    let pageCount = 0;
    let totalReturnedUnitCount = 0;
    let firstChunkIdentifier = null;
    for (;;) {
      const page = await application.readSummaryView({
        sourceIdentifier: missionIdentifier,
        detailLevel: "detail",
        pageSize: 200,
        pageIndex,
      });
      pageCount += 1;
      totalReturnedUnitCount += page.returnedUnitCount;
      firstChunkIdentifier ??= page.chunks[0]?.chunkIdentifier ?? null;
      if (!page.hasMore || page.nextPageIndex === null) {
        break;
      }
      pageIndex = page.nextPageIndex;
      if (pageCount > 200) {
        throw new Error("分页未收敛（超过 200 页）");
      }
    }
    const paginateMilliseconds = Date.now() - paginateStartedAtMs;

    const expandStartedAtMs = Date.now();
    const section = await application.expandSummarySectionView({
      sourceIdentifier: missionIdentifier,
      chunkIdentifier: firstChunkIdentifier,
    });
    const expandMilliseconds = Date.now() - expandStartedAtMs;

    const bounded = await application.readSummaryView({
      sourceIdentifier: missionIdentifier,
      detailLevel: "detail",
      pageSize: build.chunkCount,
      maximumReturnUnitCount: 1,
    });

    checks.entryCountMatchesInput =
      build.entryCount === fixture.estimatedEntryCount;
    checks.chunkCountMatchesInput = build.chunkCount === fixture.estimatedEntryCount;
    checks.singleSourceListed = sources.length === 1;
    checks.coverageComplete =
      overview.coverage.coveredThroughSourceRevision === fixture.estimatedEntryCount;
    checks.manifestIndexPersisted = overview.resourceMetrics.manifestFileBytes > 0;
    checks.readPathDidNotTouchSourceText =
      overview.resourceMetrics.sourceAccessCount === 0 &&
      section.resourceMetrics.sourceAccessCount === 0;
    checks.sectionHasEvidencePointer = section.evidencePointers.length > 0;
    checks.boundedReturnKeepsManifest =
      bounded.isReturnBounded === true && bounded.coverage.chunkCount === build.chunkCount;

    const manifestFilePath = path.join(
      stateDirectory,
      "agent-memory",
      "main-agent-sdk",
      "summaries",
      "work-archive-" + missionIdentifier,
      "manifest.json",
    );
    const manifestFileBytesOnDisk = statSync(manifestFilePath).size;

    const result = {
      status: Object.values(checks).every(Boolean) ? "ok" : "failed",
      packageDirectoryPath,
      nodeVersion: process.version,
      platform: process.platform + " " + process.arch,
      cpuCount: os.cpus().length,
      totalMemoryMiB: Math.round(os.totalmem() / (1024 * 1024)),
      input: {
        agentCount,
        entriesPerAgent,
        entryCount: fixture.estimatedEntryCount,
        archiveFixtureBytes: fixture.archiveBytes,
      },
      output: {
        chunkCount: build.chunkCount,
        manifestFileBytes: manifestFileBytesOnDisk,
        pageCount,
        totalReturnedUnitCount,
        generatorVersion: build.generatorVersion,
      },
      timingsMilliseconds: {
        summarize: summarizeMilliseconds,
        paginateAllPages: paginateMilliseconds,
        expandSection: expandMilliseconds,
      },
      honesty: {
        boundedReturnUnitCount: bounded.returnedUnitCount,
        isReturnBounded: bounded.isReturnBounded,
        manifestChunkCountAfterBoundedRead: bounded.coverage.chunkCount,
      },
      checks,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "ok" ? 0 : 1;
  } finally {
    await application.shutdown().catch(() => {});
  }
} finally {
  if (readArgument("--keep-state-dir", null) === null) {
    rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
  }
}
