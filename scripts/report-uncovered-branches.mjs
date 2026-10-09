#!/usr/bin/env node
/**
 * 分支覆盖率缺口定位工具（E2E-01-04 覆盖率冲刺用）。
 *
 * 背景：仓库 `vitest.config.ts` 的 coverage reporter 不含 `json`，且 CLI
 * `--coverage.reporter=json` 覆盖不生效（实测输出目录为空），因此拿不到行级数据。
 * 生成 coverage-final.json 的方法：复制仓库配置并加 `json` reporter（见下文用法）。
 *
 * 关键区分（2026-10-09 实测）：v8 会产出**无位置信息**的分支（行号为 0，记为 L0）。
 * 它们无法靠补测定向覆盖，因此报告把 L0 与**可定位**分支分开统计——
 * 缺口补足只能从可定位池里出。
 *
 * 用法：
 *   1) 生成行级数据（临时配置需含 reporter: ["json"]，reportsDirectory 指向任意目录）：
 *        npx vitest run --coverage --maxWorkers=6 --config <临时配置>
 *   2) node scripts/report-uncovered-branches.mjs <coverage-final.json 路径> [topN]
 */
import { existsSync, readFileSync } from "node:fs";

const coverageFinalPath = process.argv[2] ?? "coverage/coverage-final.json";
const topFileCount = Number.parseInt(process.argv[3] ?? "15", 10);

if (!existsSync(coverageFinalPath)) {
  console.error("找不到 coverage-final.json: " + coverageFinalPath);
  console.error("请先用含 json reporter 的配置跑一次覆盖率（见本文件顶部用法）。");
  process.exit(2);
}

const coverageData = JSON.parse(readFileSync(coverageFinalPath, "utf8"));
const repositoryRootPattern = /^.*[\\/]astarray[\\/]/;

let globalCovered = 0;
let globalTotal = 0;
let unmappedCovered = 0;
let unmappedTotal = 0;
const locatableUncoveredByFile = new Map();

for (const [filePath, fileCoverage] of Object.entries(coverageData)) {
  const branchMap = fileCoverage.branchMap ?? {};
  const branchCounts = fileCoverage.b ?? {};
  const fileKey = filePath.replace(repositoryRootPattern, "");
  for (const [branchIdentifier, branchMeta] of Object.entries(branchMap)) {
    const counts = branchCounts[branchIdentifier] ?? [];
    const locations = branchMeta.locations ?? [];
    for (let index = 0; index < locations.length; index += 1) {
      const lineNumber = locations[index]?.start?.line ?? 0;
      const isCovered = (counts[index] ?? 0) > 0;
      globalTotal += 1;
      if (isCovered) globalCovered += 1;
      if (lineNumber === 0) {
        unmappedTotal += 1;
        if (isCovered) unmappedCovered += 1;
        continue;
      }
      if (isCovered) continue;
      const fileEntry = locatableUncoveredByFile.get(fileKey) ?? { count: 0, locations: [] };
      fileEntry.count += 1;
      fileEntry.locations.push({ line: lineNumber, type: branchMeta.type ?? "unknown" });
      locatableUncoveredByFile.set(fileKey, fileEntry);
    }
  }
}

const globalPercentage = globalTotal === 0 ? 100 : (globalCovered / globalTotal) * 100;
const locatableCovered = globalCovered - unmappedCovered;
const locatableTotal = globalTotal - unmappedTotal;
const requiredAdditionalCoverage = Math.max(0, Math.ceil(globalTotal * 0.85) - globalCovered);

console.log(
  "全局分支: " +
    String(globalCovered) +
    "/" +
    String(globalTotal) +
    " = " +
    globalPercentage.toFixed(2) +
    "%；达到 85% 还需覆盖 " +
    String(requiredAdditionalCoverage) +
    " 条",
);
console.log(
  "  无位置信息(L0): " +
    String(unmappedCovered) +
    "/" +
    String(unmappedTotal) +
    "（未覆盖 " +
    String(unmappedTotal - unmappedCovered) +
    "，无法定向补测）",
);
console.log(
  "  可定位(line>0): " +
    String(locatableCovered) +
    "/" +
    String(locatableTotal) +
    "（未覆盖 " +
    String(locatableTotal - locatableCovered) +
    "，缺口只能从这一池补）",
);
console.log("");
console.log("可定位未覆盖分支 Top " + String(topFileCount) + "：");
const sortedFiles = [...locatableUncoveredByFile.entries()].sort(
  (left, right) => right[1].count - left[1].count,
);
for (const [fileKey, fileEntry] of sortedFiles.slice(0, topFileCount)) {
  const lineGroups = [];
  for (const location of fileEntry.locations) {
    const groupKey = String(location.line) + ":" + location.type;
    const existing = lineGroups.find((entry) => entry.key === groupKey);
    if (existing === undefined) {
      lineGroups.push({ key: groupKey, line: location.line, type: location.type, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  console.log(String(fileEntry.count).padStart(4) + "  " + fileKey);
  console.log(
    "      " +
      lineGroups
        .slice(0, 16)
        .map((entry) => "L" + String(entry.line) + "(" + entry.type + "×" + String(entry.count) + ")")
        .join(" "),
  );
}
