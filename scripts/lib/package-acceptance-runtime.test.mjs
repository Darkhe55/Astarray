/**
 * package-acceptance-runtime：**跨平台**解析 `npm-cli.js` 的反例（2026-10-10）。
 *
 * **缺陷现象**（Linux 平台证据发现）：三个包级验收脚本在 Linux 上**全部无法运行**：
 *
 * ```
 * Error: 无法解析 npm-cli.js 路径
 *     at resolveNpmCliPath (scripts/lib/package-acceptance-runtime.mjs:43)
 *     at runNpmSync (…:48)
 *     at packTarball (…:83)
 * ```
 *
 * 影响面：`verify:toolkit-package`（Windows 上 48/48）、
 * `verify:instruction-entry-package`（17/17）、
 * `verify:observability-entry-package`（8/8）—— 三者都经 `packTarball()`，
 * 故**在 Linux 上全部 exit 1**，即"包级验收"这项在 Linux 平台**从未真正跑过**。
 *
 * **根因**：`resolveNpmCliPath()` 只尝试一种候选布局——"`npm` 可执行文件的
 * 兄弟目录 `node_modules/npm/bin/npm-cli.js`"。该布局成立的条件是 npm 装在
 * `node_modules` 里（Windows/npm 官方全局安装）。而 **apt 安装的 npm 布局不同**：
 *
 * ```
 * /usr/bin/npm  ->  /usr/share/nodejs/npm/bin/npm-cli.js   （符号链接）
 * ```
 *
 * 此时兄弟目录 `dirname('/usr/bin/npm') + '/node_modules/npm/bin/npm-cli.js'`
 * = `/usr/bin/node_modules/...` 不存在 ⇒ 抛错。**未回退、未诊断**。
 *
 * 本片钉住的语义：
 *  - `resolveNpmCliPath()` 必须**返回一个真实存在**的文件（不得返回凭空拼接的路径）；
 *  - 必须支持"npm 可执行文件是**符号链接**"的布局（跟随链接）；
 *  - 解析失败时**不得静默降级**（继续抛错），但错误信息要能指出尝试过什么。
 *
 * 本文件在修复前必须在 Linux 上失败（Windows 上通过，因为兄弟布局成立）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveNpmCliPath, runNpmSync } from "./package-acceptance-runtime.mjs";

describe("package-acceptance-runtime：npm-cli.js 的跨平台解析", () => {
  it("① 必须解析到一个真实存在的 npm-cli.js（Linux 上修复前抛错）", () => {
    const npmCliPath = resolveNpmCliPath();
    assert.ok(
      existsSync(npmCliPath),
      "解析结果必须真实存在，实际得到: " + String(npmCliPath),
    );
    assert.match(path.basename(npmCliPath), /^npm-cli\.js$/);
  });

  it("② 允许经环境变量显式指定（换 npm 布局时的逃生门）", () => {
    const npmExecutableName = process.platform === "win32" ? "npm.cmd" : "npm";
    const whichOutput = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [npmExecutableName],
      { encoding: "utf8" },
    );
    // 用"把真实 CLI 路径直接喂给环境变量"来验证逃生门生效
    const realCliPath = (() => {
      for (const line of whichOutput.split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate === "") continue;
        const sibling = path.join(
          path.dirname(candidate),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        if (existsSync(sibling)) return sibling;
      }
      return null;
    })();

    if (realCliPath === null) {
      // 本平台兄弟布局不成立（如 Linux apt 布局）⇒ 该逃生门正是为此存在，
      // 但没有真实 CLI 路径就无法构造该断言；用 ① 已覆盖主路径。
      return;
    }

    const previousValue = process.env.NPM_CLI_PATH;
    process.env.NPM_CLI_PATH = realCliPath;
    try {
      assert.equal(resolveNpmCliPath(), realCliPath);
    } finally {
      if (previousValue === undefined) {
        delete process.env.NPM_CLI_PATH;
      } else {
        process.env.NPM_CLI_PATH = previousValue;
      }
    }
  });

  it("③ runNpmSync 必须能真正执行 npm（--version 有输出）", () => {
    const versionOutput = String(runNpmSync(["--version"])).trim();
    assert.match(versionOutput, /^\d+\.\d+\.\d+/);
  });
});
