/**
 * SUM-02-04：内容缓存与计量缓存分离（换模型不改写历史；指标可复算）。
 */
import { describe, expect, it } from "vitest";

import {
  MeasurementCache,
  buildMeasurementCacheKey,
  computeMeasurementCacheMetrics,
} from "../../../packages/core/src/measurement/measurement-cache.js";
import { TokenMeasurementService } from "../../../packages/core/src/measurement/token-measurement.js";

const NOW = () => "2026-09-15T00:00:00.000Z";

async function measurementFor(input: {
  text: string;
  providerIdentifier: string;
  modelIdentifier: string;
  serializationVersion?: number;
}) {
  const service = new TokenMeasurementService(NOW);
  return service.measureTokenCount({
    text: input.text,
    providerIdentifier: input.providerIdentifier,
    modelIdentifier: input.modelIdentifier,
    ...(input.serializationVersion !== undefined
      ? { serializationVersion: input.serializationVersion }
      : {}),
  });
}

describe("SUM-02-04 内容/计量缓存分离", () => {
  it("换模型只新增计量，不改写内容；指标可由快照复算", async () => {
    const cache = new MeasurementCache(undefined, NOW);
    const text = "同一段需要计量的内容";
    const content = cache.putContent(text);
    cache.putMeasurement(
      content.contentHash,
      await measurementFor({
        text,
        providerIdentifier: "provider-a",
        modelIdentifier: "model-a",
      }),
    );
    const snapshotAfterModelA = cache.exportSnapshot();

    cache.putMeasurement(
      content.contentHash,
      await measurementFor({
        text,
        providerIdentifier: "provider-b",
        modelIdentifier: "model-b",
      }),
    );
    const snapshotAfterModelB = cache.exportSnapshot();

    // 内容条目完全不变（换模型不重写历史）。
    expect(snapshotAfterModelB.contentEntries).toEqual(
      snapshotAfterModelA.contentEntries,
    );
    expect(snapshotAfterModelB.measurementEntries.length).toBe(2);
    expect(cache.listContentHashes()).toEqual([content.contentHash]);

    // 指标可复算：活状态与快照复算一致。
    const liveMetrics = computeMeasurementCacheMetrics(cache.exportSnapshot());
    const recomputed = computeMeasurementCacheMetrics(
      JSON.parse(JSON.stringify(snapshotAfterModelB)),
    );
    expect(liveMetrics).toEqual(recomputed);
    expect(liveMetrics).toMatchObject({
      contentEntryCount: 1,
      measurementEntryCount: 2,
      distinctContentCount: 1,
      distinctModelCount: 2,
      measurementsPerContent: 2,
      isContentModelIndependent: true,
    });
    expect(liveMetrics.modelIdentifiers).toEqual(["model-a", "model-b"]);
    expect(liveMetrics.contentCharacterCount).toBe(text.length);
  });

  it("同内容重复入缓存不重复计数；序列化版本进入计量键", async () => {
    const cache = new MeasurementCache(undefined, NOW);
    const text = "版本键内容";
    const first = cache.putContent(text);
    const second = cache.putContent(text);
    expect(second.contentHash).toBe(first.contentHash);
    expect(cache.listContentHashes()).toHaveLength(1);

    const measurementV1 = await measurementFor({
      text,
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      serializationVersion: 1,
    });
    const measurementV2 = await measurementFor({
      text,
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      serializationVersion: 2,
    });
    cache.putMeasurement(first.contentHash, measurementV1);
    cache.putMeasurement(first.contentHash, measurementV1);
    cache.putMeasurement(first.contentHash, measurementV2);
    expect(cache.listMeasurementKeys()).toHaveLength(2);
    expect(
      buildMeasurementCacheKey({ contentHash: first.contentHash, measurement: measurementV1 }),
    ).not.toBe(
      buildMeasurementCacheKey({ contentHash: first.contentHash, measurement: measurementV2 }),
    );
    expect(cache.getContent(first.contentHash)?.text).toBe(text);
    expect(cache.getMeasurement(cache.listMeasurementKeys()[0]!)).not.toBeNull();
  });

  it("内容条目结构上不含模型字段（分离由结构保证）", async () => {
    const cache = new MeasurementCache(undefined, NOW);
    const content = cache.putContent("内容");
    cache.putMeasurement(
      content.contentHash,
      await measurementFor({
        text: "内容",
        providerIdentifier: "provider-a",
        modelIdentifier: "model-a",
      }),
    );
    const entry = cache.exportSnapshot().contentEntries[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      ["contentHash", "firstSeenAtIso", "text"].sort(),
    );
    expect(computeMeasurementCacheMetrics(cache.exportSnapshot()).isContentModelIndependent).toBe(true);
  });
});
