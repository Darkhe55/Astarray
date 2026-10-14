/**
 * RELIABILITY-01 / 故障注入矩阵 `load-sensitive-full-gate-flake` 的**可复现证据**
 * （2026-10-21）。
 *
 * 背景：全量门禁在并发下曾偶发 `Test timed out in 5000ms`，根因不是竞态，而是
 * **配置缺口** —— 一批使用子进程的测试文件**没有**显式 `testTimeout`，于是沿用
 * vitest 默认 5s；而实测隔离耗时最长者达 4168ms、满载争用系数约 1.4–3× ⇒ 必然偶发翻红。
 *
 * 本文件把该缺口变成**活的规则**：以后新增"起子进程却没有预算"的文件会**当场红**，
 * 而不是等某次全量运行偶发失败才发现。这也是矩阵条目标为 `fixed` 时所需的证据引用
 * （矩阵审计会拒绝"无证据的已修声明"）。
 *
 * 判定刻意与实现细节解耦：只看"是否真的起子进程"与"是否显式给了预算"两件事。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** 真正会起子进程的调用形态（注释里的关键词会被剔除后再判断）。 */
const SUBPROCESS_CALL_PATTERN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

/** 显式给出超时预算的形态：`vi.setConfig({ testTimeout })`，或逐例 `}, N)`。 */
const TIMEOUT_BUDGET_PATTERN = /testTimeout|setConfig\s*\(\s*\{\s*testTimeout/;

/** 去掉行注释与块注释，避免"注释里提到 spawn"被当成真的起子进程。 */
function stripComments(sourceText: string): string {
  return sourceText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function listTestFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(entryPath)));
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("RELIABILITY-01：子进程用例必须显式给出超时预算（活的规则）", () => {
  it("不存在『真的起子进程却没有 testTimeout』的测试文件", async () => {
    const testsRoot = path.resolve("tests");
    const testFiles = await listTestFiles(testsRoot);
    expect(testFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let subprocessFileCount = 0;

    for (const filePath of testFiles) {
      const sourceText = await fs.readFile(filePath, "utf8");
      const codeText = stripComments(sourceText);
      if (!SUBPROCESS_CALL_PATTERN.test(codeText)) {
        continue;
      }
      subprocessFileCount += 1;
      if (!TIMEOUT_BUDGET_PATTERN.test(sourceText)) {
        offenders.push(path.relative(process.cwd(), filePath));
      }
    }

    // 先证明"这个规则真的在扫东西"（否则空集合会让断言恒真）
    expect(subprocessFileCount).toBeGreaterThan(10);

    // 违规为 0 —— 若有新增，这里会直接列出文件路径
    expect(offenders).toEqual([]);
  });
});
