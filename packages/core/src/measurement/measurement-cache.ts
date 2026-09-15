/**
 * SUM-02-04：内容缓存与计量缓存分离。
 *
 * 不变量：
 * - 内容条目只按内容哈希保存，**与模型无关**；换模型只新增计量条目，绝不改写内容；
 * - 计量条目键 = 内容哈希 + provider + model + tokenizer@version + 序列化版本；
 * - 指标由缓存状态**纯函数复算**，与增量计数一致（可对导出快照离线复算）。
 */
import { createHash } from "node:crypto";

import {
  type TokenMeasurement,
} from "./token-measurement.js";

export const MEASUREMENT_CACHE_SCHEMA_VERSION = 1;

export interface ContentCacheEntry {
  contentHash: string;
  text: string;
  firstSeenAtIso: string;
}

export interface MeasurementCacheEntry {
  measurementKey: string;
  contentHash: string;
  measurement: TokenMeasurement;
}

export interface MeasurementCacheSnapshot {
  schemaVersion: 1;
  contentEntries: ContentCacheEntry[];
  measurementEntries: MeasurementCacheEntry[];
}

export interface MeasurementCacheMetrics {
  contentEntryCount: number;
  contentCharacterCount: number;
  measurementEntryCount: number;
  distinctContentCount: number;
  distinctModelCount: number;
  /** 每个内容平均计量次数；无内容时为 null（不虚报）。 */
  measurementsPerContent: number | null;
  modelIdentifiers: string[];
  /** 内容条目不含任何模型字段（结构上证明"换模型不改写历史"）。 */
  isContentModelIndependent: boolean;
}

export function computeContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildMeasurementCacheKey(input: {
  contentHash: string;
  measurement: TokenMeasurement;
}): string {
  return [
    input.contentHash,
    input.measurement.providerIdentifier ?? "-",
    input.measurement.modelIdentifier ?? "-",
    (input.measurement.tokenizerIdentifier ?? "-") +
      "@" +
      (input.measurement.tokenizerVersion ?? "-"),
    String(input.measurement.serializationVersion),
  ].join("|");
}

export class MeasurementCache {
  private readonly contentEntries = new Map<string, ContentCacheEntry>();
  private readonly measurementEntries = new Map<string, MeasurementCacheEntry>();

  constructor(
    snapshot?: MeasurementCacheSnapshot,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {
    if (snapshot !== undefined) {
      for (const entry of snapshot.contentEntries) {
        this.contentEntries.set(entry.contentHash, { ...entry });
      }
      for (const entry of snapshot.measurementEntries) {
        this.measurementEntries.set(entry.measurementKey, {
          ...entry,
          measurement: { ...entry.measurement },
        });
      }
    }
  }

  putContent(text: string): ContentCacheEntry {
    const contentHash = computeContentHash(text);
    const existing = this.contentEntries.get(contentHash);
    if (existing !== undefined) {
      return { ...existing };
    }
    const entry: ContentCacheEntry = {
      contentHash,
      text,
      firstSeenAtIso: this.nowIso(),
    };
    this.contentEntries.set(contentHash, entry);
    return { ...entry };
  }

  getContent(contentHash: string): ContentCacheEntry | null {
    const entry = this.contentEntries.get(contentHash);
    return entry === undefined ? null : { ...entry };
  }

  putMeasurement(contentHash: string, measurement: TokenMeasurement): MeasurementCacheEntry {
    const measurementKey = buildMeasurementCacheKey({ contentHash, measurement });
    const entry: MeasurementCacheEntry = {
      measurementKey,
      contentHash,
      measurement: { ...measurement },
    };
    this.measurementEntries.set(measurementKey, entry);
    return { ...entry, measurement: { ...entry.measurement } };
  }

  getMeasurement(measurementKey: string): MeasurementCacheEntry | null {
    const entry = this.measurementEntries.get(measurementKey);
    return entry === undefined
      ? null
      : { ...entry, measurement: { ...entry.measurement } };
  }

  listContentHashes(): string[] {
    return [...this.contentEntries.keys()].sort();
  }

  listMeasurementKeys(): string[] {
    return [...this.measurementEntries.keys()].sort();
  }

  exportSnapshot(): MeasurementCacheSnapshot {
    return {
      schemaVersion: MEASUREMENT_CACHE_SCHEMA_VERSION,
      contentEntries: [...this.contentEntries.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.contentHash.localeCompare(right.contentHash)),
      measurementEntries: [...this.measurementEntries.values()]
        .map((entry) => ({ ...entry, measurement: { ...entry.measurement } }))
        .sort((left, right) => left.measurementKey.localeCompare(right.measurementKey)),
    };
  }
}

/** 从快照纯函数复算指标（不依赖增量计数器）。 */
export function computeMeasurementCacheMetrics(
  snapshot: MeasurementCacheSnapshot,
): MeasurementCacheMetrics {
  const modelIdentifiers = [
    ...new Set(
      snapshot.measurementEntries
        .map((entry) => entry.measurement.modelIdentifier)
        .filter((modelIdentifier): modelIdentifier is string => modelIdentifier !== null),
    ),
  ].sort();
  const distinctContentCount = new Set(
    snapshot.measurementEntries.map((entry) => entry.contentHash),
  ).size;
  const contentCharacterCount = snapshot.contentEntries.reduce(
    (total, entry) => total + entry.text.length,
    0,
  );
  return {
    contentEntryCount: snapshot.contentEntries.length,
    contentCharacterCount,
    measurementEntryCount: snapshot.measurementEntries.length,
    distinctContentCount,
    distinctModelCount: modelIdentifiers.length,
    measurementsPerContent:
      snapshot.contentEntries.length === 0
        ? null
        : snapshot.measurementEntries.length / snapshot.contentEntries.length,
    modelIdentifiers,
    isContentModelIndependent: snapshot.contentEntries.every(
      (entry) => !("providerIdentifier" in entry) && !("modelIdentifier" in entry),
    ),
  };
}
