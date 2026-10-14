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

import { describe, expect, it, vi } from "vitest";

/**
 * 2026-11-08（第 57 轮）：**本守卫自己也要给预算**。
 *
 * 实测：全量门禁下本文件（与本轮的另一个守卫）曾报 `Test timed out in 5000ms` ——
 * 因为它们都要**读取全部 431 个测试文件**，而默认单例上限只有 5s。
 * 这与本任务反复修过的那一类**完全同源**（"自己要做重活却不给预算"），
 * 只不过这次栽在**我自己写的守卫**上：它不 spawn 子进程，
 * 故**不被它自己那条规则覆盖**（那条只扫子进程/起服务）。
 *
 * 诚实说明：文件里原有的 `setConfig` 字样是**正则模式定义**
 * （`TIMEOUT_BUDGET_PATTERN` 里写着 `setConfig\s*\(\s*\{\s*testTimeout`），
 * 不是真的调用 —— 所以它此前**确实没有预算**。
 */
vi.setConfig({ testTimeout: 60_000 });


/** 真正会起子进程的调用形态（注释里的关键词会被剔除后再判断）。 */
const SUBPROCESS_CALL_PATTERN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

/**
 * 真正会**起服务并在其上做真实请求**的形态。
 *
 * 为什么也要管（2026-10-23 实测教训）：本规则首版只看子进程，于是漏掉了
 * `anthropic-messages-runtime.test.ts` —— 它起一个本地 fake HTTP 服务并跑真实请求，
 * 却沿用 vitest 默认 5s；全量并发下 `⑰` 超时翻红、**隔离复跑全绿**。
 * "等待真实 I/O"与"等待子进程"是同一类风险，故并入同一预算约定。
 */
const SERVER_CALL_PATTERN = /\b(?:createServer|\.listen)\s*\(/;

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

describe("RELIABILITY-01：起子进程 / 起服务的用例必须显式给出超时预算（活的规则）", () => {
  it("不存在『真的起子进程或起服务却没有 testTimeout』的测试文件", async () => {
    const testsRoot = path.resolve("tests");
    const testFiles = await listTestFiles(testsRoot);
    expect(testFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let subprocessFileCount = 0;
    let serverFileCount = 0;

    // 2026-11-08（第 57 轮）：并发读取替代 431 次串行 await（超时的直接原因）。
    const fileTexts = await Promise.all(
      testFiles.map(async (filePath) => ({
        filePath,
        sourceText: await fs.readFile(filePath, "utf8"),
      })),
    );

    for (const { filePath, sourceText } of fileTexts) {
      const codeText = stripComments(sourceText);
      const startsSubprocess = SUBPROCESS_CALL_PATTERN.test(codeText);
      const startsServer = SERVER_CALL_PATTERN.test(codeText);
      if (!startsSubprocess && !startsServer) {
        continue;
      }
      if (startsSubprocess) {
        subprocessFileCount += 1;
      }
      if (startsServer) {
        serverFileCount += 1;
      }
      if (!TIMEOUT_BUDGET_PATTERN.test(sourceText)) {
        offenders.push(path.relative(process.cwd(), filePath));
      }
    }

    // 先证明"这个规则真的在扫东西"（否则空集合会让断言恒真）
    expect(subprocessFileCount).toBeGreaterThan(10);
    expect(serverFileCount).toBeGreaterThan(10);

    // 违规为 0 —— 若有新增，这里会直接列出文件路径
    expect(offenders).toEqual([]);
  });

  /**
   * 2026-11-05 新增（第 36 轮，源于一条**实测抓到的抖动**）：
   *
   * `context-node-lifecycle.test.ts` 用 `deadline = Date.now() + 30_000` 轮询任务终态，
   * 全量覆盖率运行下该用例耗时 **30_107ms**（恰好撞上该上限）并报出含糊的
   * `expected 'running' to be 'done'`；而**隔离复跑仅 243–381ms**
   * ⇒ 同一工作量在满载争用下被拖慢约 **80×**。已把上限抬到 55s（贴近其 60s `testTimeout`）。
   *
   * ## 本条守卫**保证**什么 / **不保证**什么（避免言过其实）
   *
   * **保证**：内部截止时间**严格小于** `testTimeout` ⇒ 真的卡住时由 vitest 报出明确的
   * `Test timed out`（可直接归因），而不会被"提前认输"伪装成一条**状态断言失败**
   * （那会让人误以为是产品语义问题）。
   *
   * **不保证**：它**拦不住"截止时间相对负载太紧"**这类问题 —— 修复前的 30s 相对 60s
   * 本身就是"小于"关系，本守卫当时**会放行**（这一点我实测确认过：把 deadline 改回 30_000
   * 时守卫仍通过）。"多紧才够"是**负载相关**的属性，静态规则无法判定；
   * 故此处只声明上面那条更弱但**确实成立**的保证。
   *
   * 反证：把某个 deadline 改成**大于** `testTimeout`（实测 90_000 vs 60_000）时，
   * 本守卫**当场报出** `context-node-lifecycle.test.ts（deadline=90000 >= testTimeout=60000）`。
   */
  it("内部 `deadline = Date.now() + N` 必须**小于**该文件的 `testTimeout`（真卡住要报 timeout，而不是伪装成状态断言失败）", async () => {
    const testsRoot = path.resolve("tests");
    const testFiles = await listTestFiles(testsRoot);

    const offenders: string[] = [];
    let deadlineOccurrenceCount = 0;

    // 2026-11-08（第 57 轮）：同样改为并发读取。
    const fileTexts = await Promise.all(
      testFiles.map(async (filePath) => ({
        filePath,
        sourceText: await fs.readFile(filePath, "utf8"),
      })),
    );

    for (const { filePath, sourceText } of fileTexts) {
      const testTimeoutMatch = /setConfig\(\s*\{\s*testTimeout:\s*([0-9_]+)/.exec(sourceText);
      if (testTimeoutMatch === null) {
        continue;
      }
      const testTimeoutMilliseconds = Number(testTimeoutMatch[1]!.replace(/_/g, ""));
      for (const deadlineMatch of sourceText.matchAll(
        /deadline\s*=\s*Date\.now\(\)\s*\+\s*([0-9_]+)/g,
      )) {
        deadlineOccurrenceCount += 1;
        const deadlineMilliseconds = Number(deadlineMatch[1]!.replace(/_/g, ""));
        if (deadlineMilliseconds >= testTimeoutMilliseconds) {
          offenders.push(
            path.relative(process.cwd(), filePath) +
              "（deadline=" +
              String(deadlineMilliseconds) +
              " >= testTimeout=" +
              String(testTimeoutMilliseconds) +
              "）",
          );
        }
      }
    }

    // 先证明"这条规则真的在扫东西"（否则空集合会让断言恒真）
    expect(deadlineOccurrenceCount).toBeGreaterThan(10);

    expect(offenders).toEqual([]);
  });
});
