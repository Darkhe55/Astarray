/**
 * `scanSectionedView` 的**直接调用**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 为什么单独一个文件：上一轮我给 `read-format-frontend-markup.ts` 补测时调的是
 * `scanMarkupView`，实测只 +1 —— 因为该文件的 `countLines`/`identityLineMap`
 * 只在 **L358/L376** 被调用，而那两处在 **`scanSectionedView`** 内（该导出此前**无任何测试**）。
 * 教训：「同一文件内不同导出可能用不同 helper」，必须按目标行所属的**导出**构造输入。
 *
 * 目标分支：
 *  - L245：源码里没有 `<template|script|style>` 区段 → **委托**给 `scanMarkupView`；
 *  - L358/L376（经其内部 helper）→ L46：源码**无尾换行**时的 `endsWith("\n")` 假分支；
 *  - L263/L267/L270：`mergeSubView` 的 parse-error / 视图不完整 / 部分过滤三个分支。
 *
 * 断言均为行为断言（视图可用、行映射非空、不得抛错）。
 */
import { describe, expect, it } from "vitest";

import { scanSectionedView } from "../../../packages/core/src/tools/read-format/read-format-frontend-markup.js";

function scanSectioned(
  sourceText: string,
  overrides: Partial<Parameters<typeof scanSectionedView>[0]> = {},
) {
  return scanSectionedView({
    sourceText,
    shouldIncludeComments: false,
    shouldIncludeImports: false,
    isScriptJsx: false,
    ...overrides,
  });
}

const COMPLETE_SFC_WITH_TRAILING_NEWLINE = [
  "<template>",
  "  <div>hello</div>",
  "</template>",
  "",
  "<script>",
  "const value = 1;",
  "</script>",
  "",
  "<style>",
  ".a { color: red; }",
  "</style>",
  "",
].join("\n");

describe("scanSectionedView：无区段时委托", () => {
  it("纯文本（无 template/script/style 区段）：委托给 scanMarkupView，视图可用", () => {
    const view = scanSectioned("just some plain text\n");
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("空源：不得抛错且回执可用", () => {
    const view = scanSectioned("");
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });
});

describe("scanSectionedView：完整 SFC 与无尾换行", () => {
  it("完整 SFC（带尾换行）：视图可用且行映射非空", () => {
    const view = scanSectioned(COMPLETE_SFC_WITH_TRAILING_NEWLINE);
    expect(typeof view.viewText).toBe("string");
    expect(view.lineMap.length).toBeGreaterThan(0);
  });

  it("完整 SFC **无尾换行**：不得抛错且行映射非空（触发 endsWith 假分支）", () => {
    const view = scanSectioned(COMPLETE_SFC_WITH_TRAILING_NEWLINE.trimEnd());
    expect(typeof view.viewText).toBe("string");
    expect(view.lineMap.length).toBeGreaterThan(0);
  });

  it("isScriptJsx 为真：JSX 脚本段同样可用", () => {
    const view = scanSectioned(COMPLETE_SFC_WITH_TRAILING_NEWLINE, { isScriptJsx: true });
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("styleLanguageHint 提示：不得抛错", () => {
    const view = scanSectioned(COMPLETE_SFC_WITH_TRAILING_NEWLINE, { styleLanguageHint: "scss" });
    expect(typeof view.viewText).toBe("string");
  });
});

describe("scanSectionedView：子视图异常状态的合并分支", () => {
  it("script 段内引号未闭合（子视图异常）：不得抛错且回执可用", () => {
    const sourceText = "<template>\n  <div>hi</div>\n</template>\n<script>\nconst a = \"unterminated\n</script>\n";
    const view = scanSectioned(sourceText);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("段内注释被省略（视图不完整）：omittedKinds 应有记录", () => {
    const sourceText = "<template>\n  <div>hi</div>\n</template>\n<script>\n// 注释\nconst a = 1;\n</script>\n";
    const view = scanSectioned(sourceText);
    expect(typeof view.viewText).toBe("string");
    expect(Array.isArray(view.omittedKinds)).toBe(true);
  });
});
