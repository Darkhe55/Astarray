import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CacheKeyBuilder,
  computeFileFingerprint,
  DiskCache,
} from "../../../packages/core/src/infra/cache.js";
import type { CacheKeyParts } from "../../../packages/core/src/infra/cache.js";
import { MetricsRegistry } from "../../../packages/core/src/infra/metrics.js";
import { containsAnsiControlSequences, stripAnsiControlSequences } from "../../../packages/core/src/infra/ansi-sanitizer.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cache-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function makeKeyParts(overrides: Partial<CacheKeyParts> = {}): CacheKeyParts {
  return {
    provider: "openai",
    model: "gpt-test",
    mode: "assist",
    systemPromptHash: "sys-hash",
    inputText: "输入文本",
    toolSubsetHash: "tools-hash",
    contextSummaryHash: "ctx-hash",
    fileFingerprint: "fp-1234",
    ...overrides,
  };
}

describe("CacheKeyBuilder", () => {
  it("任一关键输入变化都会改变 key 分量", () => {
    const baseKey = CacheKeyBuilder.buildKey(makeKeyParts());
    const changedInputKey = CacheKeyBuilder.buildKey(
      makeKeyParts({ inputText: "不同输入" }),
    );
    const changedModeKey = CacheKeyBuilder.buildKey(
      makeKeyParts({ mode: "devolve" }),
    );
    const changedFingerprintKey = CacheKeyBuilder.buildKey(
      makeKeyParts({ fileFingerprint: "fp-9999" }),
    );
    const changedToolKey = CacheKeyBuilder.buildKey(
      makeKeyParts({ toolSubsetHash: "other-tools" }),
    );
    expect(changedInputKey).not.toBe(baseKey);
    expect(changedModeKey).not.toBe(baseKey);
    expect(changedFingerprintKey).not.toBe(baseKey);
    expect(changedToolKey).not.toBe(baseKey);
  });

  it("相同输入产生相同 key", () => {
    expect(CacheKeyBuilder.buildKey(makeKeyParts())).toBe(
      CacheKeyBuilder.buildKey(makeKeyParts()),
    );
  });

  it("写操作、时间敏感、失败默认 bypass", () => {
    expect(
      CacheKeyBuilder.shouldBypass({ isWriteOperation: true, isTimeSensitive: false, isFailedResult: false }),
    ).toBe(true);
    expect(
      CacheKeyBuilder.shouldBypass({ isWriteOperation: false, isTimeSensitive: true, isFailedResult: false }),
    ).toBe(true);
    expect(
      CacheKeyBuilder.shouldBypass({ isWriteOperation: false, isTimeSensitive: false, isFailedResult: true }),
    ).toBe(true);
    expect(
      CacheKeyBuilder.shouldBypass({ isWriteOperation: false, isTimeSensitive: false, isFailedResult: false }),
    ).toBe(false);
  });
});

describe("DiskCache", () => {
  it("put 后 get 命中（文件指纹一致）", async () => {
    const cache = new DiskCache(temporaryDirectory);
    const key = CacheKeyBuilder.buildKey(makeKeyParts());
    await cache.put({
      key,
      cachedAtIso: "2026-08-12T10:00:00.000Z",
      resultText: "缓存结果",
      estimatedTokenCount: 42,
      fileFingerprint: "fp-1234",
    });
    const result = await cache.get(key, "fp-1234");
    expect(result.status).toBe("hit");
    expect(result.entry?.resultText).toBe("缓存结果");
  });

  it("未命中返回 miss", async () => {
    const cache = new DiskCache(temporaryDirectory);
    const result = await cache.get("不存在之key", "fp");
    expect(result.status).toBe("miss");
    expect(result.entry).toBeNull();
  });

  it("文件指纹不一致返回 stale-reject（不复用）", async () => {
    const cache = new DiskCache(temporaryDirectory);
    const key = CacheKeyBuilder.buildKey(makeKeyParts());
    await cache.put({
      key,
      cachedAtIso: "2026-08-12T10:00:00.000Z",
      resultText: "旧结果",
      estimatedTokenCount: 10,
      fileFingerprint: "fp-old",
    });
    const result = await cache.get(key, "fp-new");
    expect(result.status).toBe("stale-reject");
    expect(result.entry).toBeNull();
  });

  it("损坏的缓存条目按 miss 处理", async () => {
    const cache = new DiskCache(temporaryDirectory);
    const key = CacheKeyBuilder.buildKey(makeKeyParts());
    await fs.mkdir(path.join(temporaryDirectory, "cache"), { recursive: true });
    await fs.writeFile(path.join(temporaryDirectory, "cache", `${key}.json`), "损坏", "utf8");
    const result = await cache.get(key, "fp");
    expect(result.status).toBe("miss");
  });
});

describe("computeFileFingerprint", () => {
  it("文件存在时返回内容指纹，缺失时返回空串", async () => {
    const filePath = path.join(temporaryDirectory, "data.txt");
    await fs.writeFile(filePath, "内容", "utf8");
    expect(await computeFileFingerprint(filePath)).toMatch(/^[a-f0-9]{16}$/);
    expect(await computeFileFingerprint(path.join(temporaryDirectory, "missing.txt"))).toBe("");
  });
});

describe("MetricsRegistry", () => {
  it("报告区分 hit/miss/bypass/stale_reject", () => {
    const metrics = new MetricsRegistry();
    metrics.recordCacheStatus("hit");
    metrics.recordCacheStatus("hit");
    metrics.recordCacheStatus("miss");
    metrics.recordCacheStatus("bypass");
    metrics.recordCacheStatus("stale-reject");
    const report = metrics.getReport();
    expect(report.cacheStatusCounts).toEqual({
      hit: 2,
      miss: 1,
      bypass: 1,
      "stale-reject": 1,
    });
  });

  it("token 统计区分 estimated 与 exact", () => {
    const metrics = new MetricsRegistry();
    metrics.recordTokenUsage({ provider: "openai", model: "m", tokenCount: 100, isEstimated: false });
    metrics.recordTokenUsage({ provider: "openai", model: "m", tokenCount: 50, isEstimated: true });
    const report = metrics.getReport();
    expect(report.totalTokenCount).toBe(150);
    expect(report.exactTokenCount).toBe(100);
    expect(report.estimatedTokenCount).toBe(50);
  });

  it("峰值并发追踪", () => {
    const metrics = new MetricsRegistry();
    metrics.enterConcurrentSection();
    metrics.enterConcurrentSection();
    metrics.enterConcurrentSection();
    metrics.leaveConcurrentSection();
    metrics.leaveConcurrentSection();
    metrics.enterConcurrentSection();
    metrics.leaveConcurrentSection();
    metrics.leaveConcurrentSection();
    const report = metrics.getReport();
    expect(report.peakConcurrency).toBe(3);
    expect(report.currentConcurrency).toBe(0);
  });

  it("leaveConcurrentSection 不会低于 0", () => {
    const metrics = new MetricsRegistry();
    metrics.leaveConcurrentSection();
    metrics.leaveConcurrentSection();
    expect(metrics.getReport().currentConcurrency).toBe(0);
  });

  it("调用计数器与 mission 创建", () => {
    const metrics = new MetricsRegistry();
    metrics.recordToolCall();
    metrics.recordToolCall();
    metrics.recordProviderCall();
    metrics.recordMissionCreated();
    const report = metrics.getReport();
    expect(report.totalCalls).toBe(3);
    expect(report.missionCount).toBe(1);
  });

  it("消息延迟与 mission 计数", () => {
    const metrics = new MetricsRegistry();
    expect(metrics.getReport().averageMessageLatencyMilliseconds).toBeNull();
    metrics.recordMessageDelivery(100);
    metrics.recordMessageDelivery(300);
    metrics.recordMissionCreated();
    const report = metrics.getReport();
    expect(report.averageMessageLatencyMilliseconds).toBe(200);
    expect(report.messageDeliveries).toBe(2);
    expect(report.missionCount).toBe(1);
  });
});

describe("ANSI 控制序列清洗", () => {
  it("清洗颜色与光标控制序列", () => {
    const input = "\u001B[31m红色\u001B[0m 普通 \u001B[2J清屏";
    expect(containsAnsiControlSequences(input)).toBe(true);
    expect(stripAnsiControlSequences(input)).toBe("红色 普通 清屏");
  });

  it("清洗 OSC 超链接序列", () => {
    const input = "\u001B]8;;https://example.com\u0007链接\u001B]8;;\u0007";
    expect(stripAnsiControlSequences(input)).toBe("链接");
  });

  it("普通文本不受影响", () => {
    const input = "普通文本 hello world";
    expect(stripAnsiControlSequences(input)).toBe(input);
    expect(containsAnsiControlSequences(input)).toBe(false);
  });
});
