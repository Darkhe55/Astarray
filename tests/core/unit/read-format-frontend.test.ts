/**
 * READ-FORMAT-03a：前端脚本（JS/TS/JSX/TSX）读取策略反例（真实夹具）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ReadFormatStrategyRegistry } from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "read-format");
const registry = new ReadFormatStrategyRegistry();

async function readFixture(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(FIXTURE_ROOT, relativePath), "utf8");
}

function buildView(
  relativePath: string,
  sourceText: string,
  shouldIncludeComments: boolean,
  shouldIncludeImports: boolean,
) {
  return registry.buildReadView({
    filePath: relativePath,
    sourceText,
    shouldIncludeComments,
    shouldIncludeImports,
    isSensitiveCheckApplied: true,
  });
}

describe("READ-FORMAT-03a 前端脚本注册与回执", () => {
  it("js/jsx/ts/tsx/mjs/cjs 解析到 frontend-script；默认参数为原文", async () => {
    for (const fileName of ["a.js", "a.jsx", "a.ts", "a.tsx", "a.mjs", "a.cjs"]) {
      expect(registry.resolve({ fileName })?.strategyId).toBe("frontend-script");
    }
    const sourceText = await readFixture("frontend/sample.tsx");
    const receipt = registry.buildReadView({
      filePath: "frontend/sample.tsx",
      sourceText,
      isSensitiveCheckApplied: true,
    });
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.filterStatus).toBe("not-filtered");
    expect(receipt.lineMap).toEqual([
      {
        returnedStartLine: 1,
        sourceStartLine: 1,
        lineCount: sourceText.split("\n").length - 1,
      },
    ]);
  }, 30_000);
});

describe("READ-FORMAT-03a 注释安全", () => {
  it("字符串、模板字符串、正则与 JSX 文本里的双斜杠不误删", async () => {
    const sourceText = await readFixture("frontend/sample.tsx");
    const receipt = buildView("frontend/sample.tsx", sourceText, false, true);
    expect(receipt.viewText).not.toContain("普通注释");
    expect(receipt.viewText).toContain('"https://example.com/a//b"');
    expect(receipt.viewText).toContain("`value: ${count} // not a comment`");
    expect(receipt.viewText).toContain("/https?:\\/\\/example\\.com\\/\\w+/");
    expect(receipt.viewText).toContain("count / 2 / 3");
    expect(receipt.viewText).toContain("// JSX 文本里的双斜杠不是注释");
    expect(receipt.viewText).toContain('data-url="https://example.com/x//y"');
  }, 30_000);

  it("JSX 表达式容器内的块注释按需省略，表达式代码保留", async () => {
    const sourceText = await readFixture("frontend/sample.tsx");
    const receipt = buildView("frontend/sample.tsx", sourceText, false, true);
    expect(receipt.viewText).not.toContain("真正的 JSX 注释");
    expect(receipt.viewText).not.toContain("表达式内注释");
    expect(receipt.viewText).toContain("<span>{count }</span>");
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 18,
      endLine: 19,
    });
  }, 30_000);

  it("未闭合模板字符串原样返回并报 parse-error", async () => {
    const sourceText = await readFixture("frontend/incomplete.tsx");
    const receipt = buildView("frontend/incomplete.tsx", sourceText, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.isFilterable).toBe(false);
  }, 30_000);
});

describe("READ-FORMAT-03a 导入与副作用", () => {
  it("静态 import/require 可按需省略；动态 import() 保留并标注", async () => {
    const sourceText = await readFixture("frontend/sample.tsx");
    const receipt = buildView("frontend/sample.tsx", sourceText, true, false);
    expect(receipt.viewText).not.toContain("import React");
    expect(receipt.viewText).not.toContain('from "react"');
    expect(receipt.viewText).not.toContain("./styles.css");
    expect(receipt.viewText).toContain('import("./dynamic.js")');
    expect(receipt.retainedConstructs).toContain("dynamic-import");
    expect(receipt.filterStatus).toBe("partially-filtered");
    expect(receipt.limitations.join(" ")).toContain("dynamic-import");
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "import-statement",
      startLine: 1,
      endLine: 6,
    });
  }, 30_000);

  it("CommonJS require 与单行 import 省略；正则/字符串保留", async () => {
    const sourceText = await readFixture("frontend/sample.ts");
    const receipt = buildView("frontend/sample.ts", sourceText, true, false);
    expect(receipt.viewText).not.toContain("import fs from");
    expect(receipt.viewText).not.toContain('require("./data.json")');
    expect(receipt.viewText).toContain("// 注释");
    expect(receipt.viewText).toContain("/a\\/\\/b/");
    expect(receipt.viewText).toContain("'single // not comment'");
    expect(receipt.omittedKinds).toEqual(["import-statement"]);
  }, 30_000);

  it("仅省略注释时导入保留；仅省略导入时注释保留", async () => {
    const sourceText = await readFixture("frontend/sample.tsx");
    const commentsOnly = buildView("frontend/sample.tsx", sourceText, false, true);
    expect(commentsOnly.viewText).toContain('import React from "react";');
    expect(commentsOnly.viewText).not.toContain("普通注释");

    const importsOnly = buildView("frontend/sample.tsx", sourceText, true, false);
    expect(importsOnly.viewText).not.toContain('import React from "react";');
    expect(importsOnly.viewText).toContain("// 普通注释");
  }, 30_000);
});

describe("READ-FORMAT-03a 边界", () => {
  it("JSX 属性表达式、自闭合标签、比较小于号与正则不误删", async () => {
    const sourceText = await readFixture("frontend/sample.jsx");
    const receipt = buildView("frontend/sample.jsx", sourceText, false, false);
    expect(receipt.viewText).not.toContain("import React");
    expect(receipt.viewText).toContain("1 < 2");
    expect(receipt.viewText).toContain("/x\\/\\/y/");
    expect(receipt.viewText).toContain("<ul className={styles.list}>");
    expect(receipt.viewText).toContain("<br />");
    expect(receipt.viewText).toContain("items.map((item) => item.name)");
  }, 30_000);

  it("同行代码的 import 不删除并标注 import-with-inline-code", () => {
    const source = "import x from \"y\"; const z = 1;\n";
    const receipt = buildView("inline.ts", source, true, false);
    expect(receipt.viewText).toContain('import x from "y"; const z = 1;');
    expect(receipt.retainedConstructs).toContain("import-with-inline-code");
    expect(receipt.limitations.join(" ")).toContain("import-with-inline-code");
    // 视图与原文一致（未省略任何内容）时状态诚实为 not-filtered
    expect(receipt.filterStatus).toBe("not-filtered");
  }, 30_000);

  it("模板字符串表达式内的注释按需省略、代码保留", () => {
    const source = "const t = `a ${ b /* c */ } d`;\n";
    const receipt = buildView("inline.ts", source, false, true);
    expect(receipt.viewText).toContain("const t = `a ${ b  } d`;");
    expect(receipt.viewText).not.toContain("/* c */");
  }, 30_000);

  it("未闭合块注释原样返回并报 parse-error", () => {
    const source = "const a = 1;\n/* broken\n";
    const receipt = buildView("inline.ts", source, false, true);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
    expect(receipt.limitations.join(" ")).toContain("unterminated-block-comment");
  }, 30_000);
});
