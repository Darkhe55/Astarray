/**
 * 架构守卫（2026-11-04）：**不得用"首尾字符像 JSON"判断结果到齐并立即 kill 子进程**。
 *
 * ## 为什么需要它（真实教训，第 34 轮实测）
 *
 * `tests/tui/integration/cli-anthropic-protocol.test.ts` 全量覆盖率运行下偶发
 * `SyntaxError: Unexpected end of JSON input`，隔离复跑通过。
 * 根因在等待判据：
 *
 * ```js
 * if (stdoutText.trim().startsWith("{") && stdoutText.trim().endsWith("}")) {
 *   clearInterval(resultChecker); childProcess.kill(); settle();   // ← 提前 kill
 * }
 * ```
 *
 * 该判据**只证明首尾字符像 JSON**：负载下 stdout 分块到达时，第一块可能**已同时满足**两个条件，
 * 于是**提前 kill** ⇒ 拿到**截断输出** ⇒ `JSON.parse` 抛错。
 *
 * **佐证**：同级用例 `authorization-retry-closure` 与
 * `gui02-01-cli-permission-ask-registration` **早已**在判据后加了
 * `try { JSON.parse } catch { return }` —— 说明这个坑此前被填过，
 * 而 `cli-anthropic-protocol` 是**漏掉的那一个**。
 *
 * ## 判定规则（宽严的取舍）
 *
 * 凡出现 `endsWith("}")` 的等待判据，其**后继 15 行内**必须至少有一种**缓解手段**：
 *  - `JSON.parse`（真的验证可解析 ⇒ 首选）；
 *  - `setTimeout`（给子进程留出补全输出的时间 ⇒ 可接受）；
 *  - `ObservedAt` / `observedAt`（该判据只用于**时间观测**，不是 kill 触发条件）。
 *
 * 这样既能拦住"判据像 JSON 就 kill"的脆弱形态，又不会误伤
 * `cli-exit-linger`（纯观测）与 `artifact-presence-cli`（5s 缓冲）这类**已缓解**的写法。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** `endsWith("}")` 形态的结果到齐判据。 */
const RESULT_COMPLETENESS_PATTERN = /endsWith\("}"\)/;

/** 可接受的缓解手段（任一即可）。 */
const MITIGATION_PATTERNS = [/JSON\.parse/, /setTimeout\(/, /[Oo]bservedAt/];

/** 向后查看的行数窗口。 */
const LOOKAHEAD_LINE_COUNT = 15;

/**
 * **本守卫自身必须被排除**：它把 `endsWith("}")` 作为**规则数据**写在正则里，
 * 并不是一处等待子进程结果的判据 —— 若不排除，守卫会把自己判成违规
 * （实测：offenders 里正是本文件）。
 * 这与 T12-05 破坏性 API 守卫"扫描器自身也是源码"的处境同类，故显式排除并写明理由。
 */
const GUARD_FILE_NAME = "subprocess-result-wait-completeness.test.ts";

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

describe("架构守卫：等待子进程结果时不得以'像 JSON'当作'JSON 完整'", () => {
  it("凡 `endsWith(\"}\")` 判据，其后继窗口内必须有缓解手段（JSON.parse / setTimeout / 纯观测）", async () => {
    const testFiles = await listTestFiles(path.resolve("tests"));
    expect(testFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let occurrences = 0;

    for (const filePath of testFiles) {
      if (path.basename(filePath) === GUARD_FILE_NAME) {
        continue;
      }
      const sourceText = await fs.readFile(filePath, "utf8");
      const lines = sourceText.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!RESULT_COMPLETENESS_PATTERN.test(lines[index]!)) {
          continue;
        }
        occurrences += 1;
        const lookaheadText = lines
          .slice(index, index + LOOKAHEAD_LINE_COUNT)
          .join("\n");
        const hasMitigation = MITIGATION_PATTERNS.some((pattern) =>
          pattern.test(lookaheadText),
        );
        if (!hasMitigation) {
          offenders.push(
            path.relative(process.cwd(), filePath) + ":" + String(index + 1),
          );
        }
      }
    }

    // 先证明"这条规则真的在扫东西"（否则空集合会让断言恒真）
    expect(occurrences).toBeGreaterThan(0);

    // 违规即为"像 JSON 就当作完整"的脆弱等待 ⇒ 直接列出位置
    expect(offenders).toEqual([]);
  });
});
