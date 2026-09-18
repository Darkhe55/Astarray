/**
 * READ-FORMAT-05b：读取策略资源测量与不变量（安装包资源测量的源级对应测试）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ReadFormatStrategyRegistry } from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "read-format");
const registry = new ReadFormatStrategyRegistry();

async function collectFixturePaths(directoryPath: string): Promise<string[]> {
  const fixturePaths: string[] = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      fixturePaths.push(...(await collectFixturePaths(entryPath)));
    } else {
      fixturePaths.push(entryPath);
    }
  }
  return fixturePaths;
}

describe("READ-FORMAT-05b 资源测量", () => {
  it("全部夹具与四种参数组合：回执不变量、视图不长于原文、耗时与内存有界", async () => {
    const fixturePaths = (await collectFixturePaths(FIXTURE_ROOT)).sort();
    expect(fixturePaths.length).toBeGreaterThanOrEqual(20);
    const combos = [
      { comments: true, imports: true },
      { comments: false, imports: true },
      { comments: true, imports: false },
      { comments: false, imports: false },
    ];
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    let peakHeapBytes = heapBeforeBytes;
    let totalInputBytes = 0;
    let totalOutputBytes = 0;
    let viewCount = 0;
    const startedAtMilliseconds = Date.now();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      for (const fixturePath of fixturePaths) {
        const sourceText = await fs.readFile(fixturePath, "utf8");
        const relativePath = path.relative(FIXTURE_ROOT, fixturePath).replace(/\\/g, "/");
        totalInputBytes += Buffer.byteLength(sourceText, "utf8");
        for (const combo of combos) {
          const receipt = registry.buildReadView({
            filePath: relativePath,
            sourceText,
            shouldIncludeComments: combo.comments,
            shouldIncludeImports: combo.imports,
            isSensitiveCheckApplied: true,
          });
          expect([
            "not-filtered",
            "filtered",
            "partially-filtered",
            "unsupported",
            "parse-error",
          ]).toContain(receipt.filterStatus);
          expect(receipt.sourceHash).toHaveLength(64);
          expect(receipt.measuredUnits).toBe(
            Buffer.byteLength(receipt.viewText, "utf8"),
          );
          expect(Buffer.byteLength(receipt.viewText, "utf8")).toBeLessThanOrEqual(
            Buffer.byteLength(sourceText, "utf8"),
          );
          totalOutputBytes += Buffer.byteLength(receipt.viewText, "utf8");
          viewCount += 1;
          const currentHeapBytes = process.memoryUsage().heapUsed;
          if (currentHeapBytes > peakHeapBytes) {
            peakHeapBytes = currentHeapBytes;
          }
        }
      }
    }
    const elapsedMilliseconds = Date.now() - startedAtMilliseconds;
    const heapDeltaBytes = peakHeapBytes - heapBeforeBytes;
    console.log(
      "read-format-resource-metrics " +
        JSON.stringify({
          fixtureCount: fixturePaths.length,
          viewCount,
          elapsedMilliseconds,
          averageMillisecondsPerView:
            Math.round((elapsedMilliseconds / viewCount) * 10_000) / 10_000,
          heapDeltaBytes,
          totalInputBytes,
          totalOutputBytes,
        }),
    );
    expect(elapsedMilliseconds).toBeLessThan(30_000);
    expect(heapDeltaBytes).toBeLessThan(128 * 1024 * 1024);
    expect(totalOutputBytes).toBeLessThanOrEqual(
      totalInputBytes * combos.length,
    );
  }, 120_000);
});
