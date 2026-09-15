/**
 * SUM-02-04：安装包计量/核验/缓存/质量门联测（只用安装包公开 exports）。
 *
 * 用法：node scripts/verify-measurement-package.mjs --package-dir <已安装包目录>
 */
import { mkdtempSync, rmSync } from "node:fs";
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

const temporaryDirectoryPath = mkdtempSync(
  path.join(os.tmpdir(), "astarray-measurement-package-"),
);

try {
  const publicSdk = await import(
    pathToFileURL(path.join(packageDirectoryPath, "dist", "public-sdk.js")).href
  );
  const {
    MeasurementCache,
    TokenMeasurementService,
    assembleRequestBudget,
    attachProviderUsageToMeasurement,
    computeMeasurementCacheMetrics,
    createJsonlProviderUsageCapture,
    describeOfflineCaptureStatus,
    evaluateSummaryQuality,
    extractAuthoritativeClaims,
    rebuildNarrativeFromClaims,
    verifyNarrativeAgainstClaims,
  } = publicSdk;

  const checks = {};
  const nowIso = () => "2026-09-15T00:00:00.000Z";
  const measurementService = new TokenMeasurementService(nowIso);
  const text = "预算 4096 token，状态 done，不裁剪正文。";

  // 1) 内容/计量缓存分离：换模型不改写内容，指标可复算。
  const cache = new MeasurementCache(undefined, nowIso);
  const content = cache.putContent(text);
  const measurementForModelA = await measurementService.measureTokenCount({
    text,
    providerIdentifier: "provider-a",
    modelIdentifier: "model-a",
  });
  cache.putMeasurement(content.contentHash, measurementForModelA);
  const snapshotBefore = JSON.stringify(cache.exportSnapshot().contentEntries);
  const measurementForModelB = await measurementService.measureTokenCount({
    text,
    providerIdentifier: "provider-b",
    modelIdentifier: "model-b",
  });
  cache.putMeasurement(content.contentHash, measurementForModelB);
  const snapshot = cache.exportSnapshot();
  const metrics = computeMeasurementCacheMetrics(snapshot);
  const metricsRecomputed = computeMeasurementCacheMetrics(
    JSON.parse(JSON.stringify(snapshot)),
  );
  checks.contentUnchangedAfterModelSwitch =
    JSON.stringify(snapshot.contentEntries) === snapshotBefore;
  checks.cacheMetricsRecomputable = JSON.stringify(metrics) === JSON.stringify(metricsRecomputed);
  checks.cacheSeparationHolds =
    metrics.contentEntryCount === 1 && metrics.measurementEntryCount === 2;

  // 2) 事实核验：重建叙述应判定为 supported。
  const records = [
    {
      sourceIdentifier: "record-1",
      sourceRevision: 1,
      contentHash: "hash-1",
      text,
    },
  ];
  const claims = extractAuthoritativeClaims(records);
  const rebuilt = rebuildNarrativeFromClaims({ claims });
  const verification = verifyNarrativeAgainstClaims({
    narrativeText: rebuilt.narrativeText,
    citations: rebuilt.citations,
    records,
  });
  checks.rebuiltNarrativeSupported = verification.verdict === "supported";

  // 3) 请求预算：超预算只分页、无重无漏。
  const budgetRecords = [];
  for (let index = 0; index < 10; index += 1) {
    const recordText = "记录 " + String(index) + " " + "字".repeat(120);
    budgetRecords.push({
      recordIdentifier: "record-" + String(index),
      priorityTier: 0,
      text: recordText,
      isMandatory: false,
      measurement: await measurementService.measureTokenCount({
        text: recordText,
        providerIdentifier: null,
        modelIdentifier: null,
      }),
    });
  }
  const assembly = assembleRequestBudget({
    configuredGlobalContextTokenCount: 1024,
    reservedOutputTokenCount: 128,
    reservedPackagingTokenCount: 0,
    records: budgetRecords,
    pageSize: 3,
  });
  const union = [
    ...assembly.selectedRecordIdentifiers,
    ...assembly.pagedRecordIdentifiers.flat(),
  ];
  checks.budgetPaginationLossless =
    assembly.status === "requires-pagination" &&
    new Set(union).size === budgetRecords.length &&
    union.length === budgetRecords.length;

  // 4) Provider usage 捕获（本地端口）与离线诚实状态。
  const capture = createJsonlProviderUsageCapture({
    filePath: path.join(temporaryDirectoryPath, "usage.jsonl"),
  });
  const capturedUsage = {
    schemaVersion: 1,
    captureIdentifier: "capture-1",
    requestIdentifier: "request-1",
    providerIdentifier: "provider-a",
    modelIdentifier: "model-a",
    serializationVersion: 1,
    inputTokenCount: 1000,
    outputTokenCount: 250,
    cachedInputTokenCount: 128,
    observedAtIso: "2026-09-15T00:00:00.000Z",
  };
  await capture.recordUsage(capturedUsage);
  const usageRoundTrip = await capture.readAll();
  const authoritativeMeasurement = attachProviderUsageToMeasurement({
    usage: usageRoundTrip[0],
    measurementService,
  });
  checks.captureRoundTrip =
    usageRoundTrip.length === 1 && usageRoundTrip[0].captureIdentifier === "capture-1";
  checks.providerUsageAuthoritative =
    authoritativeMeasurement.isAuthoritative === true &&
    authoritativeMeasurement.estimatedTokenCount === 1250;
  checks.offlineCaptureHonest =
    describeOfflineCaptureStatus().isRealProviderCaptureAvailable === false;

  // 5) 质量评估：人类标注可用、模型自评被拒。
  const humanSamples = [
    {
      sampleIdentifier: "s1",
      claimIdentifier: "claim-1",
      label: "supported",
      labelSource: "human",
      labeledByUserId: "user-1",
      labeledAtIso: "2026-09-15T00:00:00.000Z",
    },
  ];
  const humanMetrics = evaluateSummaryQuality({
    labeledSamples: humanSamples,
    predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
  });
  let isModelSelfEvaluationRejected = false;
  try {
    evaluateSummaryQuality({
      labeledSamples: [
        { ...humanSamples[0], labelSource: "model", labeledByUserId: null },
      ],
      predictions: [{ claimIdentifier: "claim-1", prediction: "supported" }],
    });
  } catch {
    isModelSelfEvaluationRejected = true;
  }
  checks.humanLabelEvaluationAvailable = humanMetrics.precision === 1;
  checks.modelSelfEvaluationRejected = isModelSelfEvaluationRejected;

  const result = {
    status: Object.values(checks).every(Boolean) ? "ok" : "failed",
    packageDirectoryPath,
    nodeVersion: process.version,
    platform: process.platform + " " + process.arch,
    metrics: {
      contentEntryCount: metrics.contentEntryCount,
      measurementEntryCount: metrics.measurementEntryCount,
      distinctModelCount: metrics.distinctModelCount,
      paginatedRecordCount: assembly.pagedRecordIdentifiers.flat().length,
      selectionStatus: assembly.status,
      verificationVerdict: verification.verdict,
      humanLabelPrecision: humanMetrics.precision,
    },
    checks,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "ok" ? 0 : 1;
} finally {
  rmSync(temporaryDirectoryPath, { recursive: true, force: true, maxRetries: 5 });
}
