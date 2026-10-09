/**
 * 标记语言（SFC）读取扫描器的**边界分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 先逐行读了 `read-format-frontend-markup.ts` 的 L34-105 再写用例，目标分支：
 *  - L42/L50：空源 → 行数 0、行映射为空；
 *  - L46：源码末行**无换行符**；
 *  - L70：标签内**引号未闭合** → `findTagEnd` 返回 -1；
 *  - L96/L97：因此整体 `break`（不得继续按错误的区段切分）；
 *  - L101/L102：`<template>` **没有闭合标签** → `continue`（跳过该段而不是抛错）。
 *
 * 断言原则：畸形输入只断言**不抛错且回执可用**（并注明意图是触发容错分支）；
 * 正常输入则断言视图可用与行映射非空。
 */
import { describe, expect, it } from "vitest";

import { scanMarkupView } from "../../../packages/core/src/tools/read-format/read-format-frontend-markup.js";

function scan(sourceText: string) {
  return scanMarkupView({
    sourceText,
    shouldIncludeComments: false,
    shouldIncludeImports: false,
  });
}

const WELL_FORMED_SFC = [
  "<template>",
  "  <div>hello</div>",
  "</template>",
  "",
  "<script setup>",
  "const a = 1;",
  "</script>",
  "",
  "<style scoped>",
  ".a { color: red; }",
  "</style>",
  "",
].join("\n");

describe("SFC 扫描器：空源与无尾换行", () => {
  it("空源：视图为空且行映射为空（触发 countLines('')/identityLineMap(0)）", () => {
    const view = scan("");
    expect(view.viewText).toBe("");
    expect(view.lineMap).toHaveLength(0);
    expect(view.filterStatus).toBeDefined();
  });

  it("正常 SFC：视图可用且行映射非空", () => {
    const view = scan(WELL_FORMED_SFC);
    expect(typeof view.viewText).toBe("string");
    expect(view.lineMap.length).toBeGreaterThan(0);
  });

  it("无尾换行：不得抛错且回执可用（触发 endsWith('\\n') 的假分支）", () => {
    const view = scan("<template><div>hi</div></template>");
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });
});

describe("SFC 扫描器：畸形标签的容错", () => {
  it("标签内引号未闭合：不得抛错（触发 findTagEnd 返回 -1 并 break）", () => {
    const view = scan('<template>\n  <div class="unterminated\n</template>\n');
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("template 没有闭合标签：不得抛错（触发 closeMatch === null 的 continue）", () => {
    const view = scan("<template>\n  <div>hi</div>\n");
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("只有 script 段且完整：不得抛错且视图可用", () => {
    const view = scan("<script>\nconst a = 1;\n</script>\n");
    expect(typeof view.viewText).toBe("string");
  });
});
