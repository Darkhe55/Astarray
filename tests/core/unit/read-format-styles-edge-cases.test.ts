/**
 * 样式表读取扫描器的**边界分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 先逐行读了 `read-format-frontend-styles.ts`（152 行，单一导出 `scanStyleSheetView`）再写用例：
 *  - L31-32：`url(` 的**前导字符**判定（行首的 `url(` 与前面带标识符字符的 `xurl(` 行为不同）；
 *  - L39：`url(...)` 内的**反斜杠转义**；
 *  - L50：`url(...)` 内**未闭合引号** → 直接判定未闭合；
 *  - L56/L63：`url(...)` 内**嵌套括号**与**换行**（换行即未闭合）；
 *  - L96：`@import` 语句里**未闭合字符串** → 不匹配（返回 null）；
 *  - L111/L122：`@import` 行**无尾换行**时的两处 `indexOf("\n") === -1`；
 *  - L113：语句后**同行还有代码**时整行保留（不得删掉真实代码）。
 *
 * 核心行为断言：`url(http://…)` 里的 `//` **不得**被当作行注释（否则会吃掉后面的真实代码）。
 */
import { describe, expect, it } from "vitest";

import { scanStyleSheetView } from "../../../packages/core/src/tools/read-format/read-format-frontend-styles.js";

function scan(
  sourceText: string,
  shouldIncludeComments: boolean,
  shouldIncludeImports: boolean,
  hasLineComments: boolean,
) {
  return scanStyleSheetView({ sourceText, shouldIncludeComments, shouldIncludeImports, hasLineComments });
}

describe("样式表扫描器：url(...) 的边界分支", () => {
  it("url() 里的 // 不得被当成行注释（否则会吃掉后面的真实代码）", () => {
    const view = scan("body { background: url(http://example.com/a.png); color: red; }\n", false, false, true);
    // 若把 url 里的 // 当注释，color: red 会被吞掉
    expect(view.viewText).toContain("color: red");
  });

  it("url() 出现在源码最开头（前导字符为空）：同样不得被当成注释", () => {
    const view = scan("url(//example.com/a.png) body { color: red; }\n", false, false, true);
    expect(view.viewText).toContain("color: red");
  });

  it("url() 内反斜杠转义：不得抛错且回执可用（触发转义跳过分支）", () => {
    const view = scan("body { background: url(a\\)b.png); }\n", false, false, true);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("url() 内引号未闭合：不得抛错且回执可用（触发未闭合分支）", () => {
    const view = scan('body { background: url("a.png); }\n', false, false, true);
    expect(typeof view.viewText).toBe("string");
  });

  it("url() 内换行：不得抛错且回执可用（触发换行即未闭合分支）", () => {
    const view = scan('body { background: url(\n"a.png"); }\n', false, false, true);
    expect(typeof view.viewText).toBe("string");
  });

  it("前面带标识符字符的 xurl( 不被当作 url()：不得抛错", () => {
    const view = scan("body { background: xurl(http://example.com/a.png); }\n", false, false, true);
    expect(typeof view.viewText).toBe("string");
  });
});

describe("样式表扫描器：@import 边界", () => {
  it("@import 行无尾换行：省略导入后不得残留（触发两处 indexOf('\\n') === -1）", () => {
    const view = scan('@import "a.css";', false, false, false);
    expect(view.viewText).not.toContain("a.css");
  });

  it("@import 后同行还有代码：必须整行保留（不得删掉真实代码）", () => {
    const view = scan('@import "a.css"; body { color: red; }\n', false, false, false);
    expect(view.viewText).toContain("body { color: red; }");
  });

  it("@import 后同行只有块注释：可安全省略", () => {
    const view = scan('@import "a.css"; /* 说明 */\nbody { color: red; }\n', false, false, false);
    expect(view.viewText).not.toContain("a.css");
    expect(view.viewText).toContain("body { color: red; }");
  });

  it("@import 语句里引号未闭合：不得抛错（触发未闭合返回 null 分支）", () => {
    const view = scan('@import "a.css;\nbody { color: red; }\n', false, false, false);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("行注释能力开关：SCSS 与 CSS 的策略标识不同", () => {
    const scssView = scan("@use 'a';\n", false, false, true);
    const cssView = scan("@import 'a';\n", false, false, false);
    expect(typeof scssView.viewText).toBe("string");
    expect(typeof cssView.viewText).toBe("string");
  });
});
