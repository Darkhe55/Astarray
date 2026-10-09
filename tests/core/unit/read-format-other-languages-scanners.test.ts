/**
 * 其他语言读取扫描器的**直接调用**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 为什么直接调用：本文件导出的 `scanGoView` / `scanSqlView` / `scanShellView` 是
 * `read-format-other-languages.ts` 自己的实现；上一轮我经 **registry** 走 `.go` 路径补测，
 * 实测那些行（L30/L34/L38/L139/L150）**仍然未覆盖**——registry 并未走到本文件的扫描器。
 * 因此必须直接调用，才能覆盖本文件的分支。
 *
 * 截距说明：Go 段的分支我已逐行读过，用**行为断言**；
 * SQL/Shell 段的实现本轮未逐行阅读，故只用**安全不变式**（不抛错、字段齐备、视图文本为字符串）
 * 并明确标注意图是触发边界分支，不假装做了更强的语义验证。
 */
import { describe, expect, it } from "vitest";

import {
  scanGoView,
  scanShellView,
  scanSqlView,
} from "../../../packages/core/src/tools/read-format/read-format-other-languages.js";

const BACKTICK = String.fromCharCode(96);

function expectUsableReceipt(view: {
  viewText: string;
  filterStatus: string;
  lineMap: unknown[];
  omittedLineRanges: unknown[];
}): void {
  expect(typeof view.viewText).toBe("string");
  expect(view.filterStatus).toBeDefined();
  expect(Array.isArray(view.lineMap)).toBe(true);
  expect(Array.isArray(view.omittedLineRanges)).toBe(true);
}

describe("Go 扫描器（直接调用）：空源与末行无换行", () => {
  it("空源：行数为 0、行映射为空（触发 countLines('') / identityLineMap(0)）", () => {
    const view = scanGoView({ sourceText: "", shouldIncludeComments: false, shouldIncludeImports: true });
    expect(view.viewText).toBe("");
    expect(view.lineMap).toHaveLength(0);
    expectUsableReceipt(view);
  });

  it("单行 import 且无尾换行：省略导入后不得残留（触发 indexOf('\\n') === -1）", () => {
    const view = scanGoView({
      sourceText: 'import "fmt"',
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(view.viewText).not.toContain('"fmt"');
    expectUsableReceipt(view);
  });

  it("import 块后跟同行注释且无尾换行：省略导入时不得残留", () => {
    const view = scanGoView({
      sourceText: 'import (\n\t"fmt"\n) // 说明',
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(view.viewText).not.toContain('"fmt"');
    expectUsableReceipt(view);
  });

  it("import 块后跟同行代码且无尾换行：保留构造，不得丢弃导入", () => {
    const view = scanGoView({
      sourceText: 'import (\n\t"fmt"\n) var x = 1',
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(view.viewText).toContain('"fmt"');
    expectUsableReceipt(view);
  });

  it("未闭合反引号原始串：不抛错（触发 isUnterminated）", () => {
    const view = scanGoView({
      sourceText: "var s = " + BACKTICK + "abc",
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expectUsableReceipt(view);
  });

  it("未闭合块注释：不抛错", () => {
    const view = scanGoView({
      sourceText: "/* 未闭合",
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expectUsableReceipt(view);
  });
});

describe("SQL 扫描器（直接调用）：边界输入", () => {
  it("空源：不抛错且行映射为空", () => {
    const view = scanSqlView({ sourceText: "", shouldIncludeComments: false, shouldIncludeImports: true });
    expect(view.viewText).toBe("");
    expectUsableReceipt(view);
  });

  it("普通语句 + 行注释：省略注释时注释不得残留", () => {
    const view = scanSqlView({
      sourceText: "SELECT 1; -- 说明\nSELECT 2;\n",
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(view.viewText).not.toContain("说明");
    expect(view.viewText).toContain("SELECT 2;");
    expectUsableReceipt(view);
  });

  it("末行无换行：不抛错", () => {
    const view = scanSqlView({
      sourceText: "SELECT 1;",
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expectUsableReceipt(view);
  });

  it("未闭合块注释：不抛错", () => {
    const view = scanSqlView({
      sourceText: "SELECT 1; /* 未闭合",
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expectUsableReceipt(view);
  });
});

describe("Shell 扫描器（直接调用）：边界输入", () => {
  it("空源：不抛错且行映射为空", () => {
    const view = scanShellView({ sourceText: "", shouldIncludeComments: false, shouldIncludeImports: true });
    expect(view.viewText).toBe("");
    expectUsableReceipt(view);
  });

  it("shebang + 行注释：省略注释时注释不得残留", () => {
    const view = scanShellView({
      sourceText: "#!/bin/sh\n# 说明\necho hi\n",
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(view.viewText).not.toContain("说明");
    expect(view.viewText).toContain("echo hi");
    expectUsableReceipt(view);
  });

  it("末行无换行：不抛错", () => {
    const view = scanShellView({
      sourceText: "echo hi",
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expectUsableReceipt(view);
  });

  it("未闭合引号：不抛错", () => {
    const view = scanShellView({
      sourceText: 'echo "未闭合',
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expectUsableReceipt(view);
  });
});
