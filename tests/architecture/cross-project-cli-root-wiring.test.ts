/**
 * 架构守卫（2026-11-02，PROJECT-01-03）：跨项目 CLI 必须**暴露并传递项目根**。
 *
 * ## 为什么需要这条守卫（真实教训）
 *
 * 包级验收（`npm run verify:instruction-entry-package`）实测发现：
 * `cross-project read/import-copy` 的服务要求 `sourceProjectRootPath`/`targetProjectRootPath`
 * 才能把「声明路径」锚定到真实文件，但 **CLI 从未注册这两个选项、也从未把它们传给执行器**
 * ⇒ 服务一律 fail-closed 回 `resource-out-of-scope`
 * ⇒ **跨项目 5 条包级判据全红（12/17）**。
 *
 * 这类"服务要、入口不给"的静默缺口**不会**被类型检查发现
 * （选项是可选的，缺了只是 fail-closed），所以用一条静态守卫把它钉住。
 *
 * 判定方式：读取 CLI 源码文本，断言
 *  ① 命令组注册了两个 root 选项；
 *  ② 执行器调用处确实把选项值传了下去。
 * 这是**源码级**断言（不跑子进程），成本低且直接指向"接线"这件事本身。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cliSourcePath = path.resolve("packages/tui/src/cli.tsx");

function readCliSource(): string {
  return readFileSync(cliSourcePath, "utf8");
}

describe("PROJECT-01-03：跨项目 CLI 必须暴露并传递项目根（架构守卫）", () => {
  it("① 命令组注册了 `--source-project-root` 与 `--target-project-root`", () => {
    const sourceText = readCliSource();

    expect(sourceText).toContain('"--source-project-root <dir>"');
    expect(sourceText).toContain('"--target-project-root <dir>"');
  });

  it("② 执行器调用处把 root 选项值传了下去（不是只注册不传）", () => {
    const sourceText = readCliSource();

    /**
     * 只注册选项、不传给执行器，等价于没接线 —— 这正是最初的缺陷形态。
     * 故必须同时断言"传参"存在，且与选项字段名一致。
     */
    expect(sourceText).toContain("sourceProjectRootPath: options.sourceProjectRoot");
    expect(sourceText).toContain("targetProjectRootPath: options.targetProjectRoot");
  });

  it("③ 两个 root 选项都设为 **required**（缺省即失败，而不是静默走 out-of-scope）", () => {
    const sourceText = readCliSource();

    // 统计 requiredOption 形式的注册次数（read 一处 + import-copy 两处 = 3）
    const requiredCount =
      (sourceText.match(/\.requiredOption\(\s*\n?\s*"--source-project-root <dir>"/g) ?? [])
        .length +
      (sourceText.match(/\.requiredOption\(\s*\n?\s*"--target-project-root <dir>"/g) ?? [])
        .length;
    expect(requiredCount).toBe(3);
  });
});
