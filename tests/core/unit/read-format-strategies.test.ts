/**
 * READ-FORMAT-02：C 系、Python、Rust 读取策略反例（真实夹具）。
 */
import { createHash } from "node:crypto";
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

function expectedLineCount(sourceText: string): number {
  return sourceText.split("\n").length - 1;
}

describe("READ-FORMAT-02 注册表与回执契约", () => {
  it("按后缀解析到对应策略；未支持格式返回原文并显式标注 unsupported", () => {
    expect(registry.resolve({ fileName: "a.c" })?.strategyId).toBe("c-family");
    expect(registry.resolve({ fileName: "a.hpp" })?.strategyId).toBe("c-family");
    expect(registry.resolve({ fileName: "a.py" })?.strategyId).toBe("python");
    expect(registry.resolve({ fileName: "a.rs" })?.strategyId).toBe("rust");
    expect(registry.resolve({ fileName: "a.xyz" })).toBeNull();

    const unsupported = buildView("notes.xyz", "// not filtered\n", false, false);
    expect(unsupported.filterStatus).toBe("unsupported");
    expect(unsupported.isFilterable).toBe(false);
    expect(unsupported.viewText).toBe("// not filtered\n");
    expect(unsupported.limitations.join(" ")).toContain("format-unsupported");
  }, 30_000);

  it("回执保留源哈希/revision、视图参数、策略版本与行映射", async () => {
    const sourceText = await readFixture("c-family/sample.c");
    const receipt = buildView("c-family/sample.c", sourceText, false, false);
    expect(receipt.sourceHash).toBe(
      createHash("sha256").update(sourceText, "utf8").digest("hex"),
    );
    expect(receipt.sourceRevision).toBe(receipt.sourceHash);
    expect(receipt.sourceRevisionKind).toBe("content-hash");
    expect(receipt.strategyId).toBe("c-family");
    expect(receipt.policyVersion).toBe(1);
    expect(receipt.viewParameters).toEqual({
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(receipt.sensitiveCheckAppliedBeforeView).toBe(true);
    expect(receipt.budgetImpact).toBe("same-file");
    expect(receipt.measurementKind).toBe("utf-8-bytes");
    expect(receipt.measuredUnits).toBe(
      Buffer.byteLength(receipt.viewText, "utf8"),
    );
    expect(receipt.lineMap).toEqual([
      {
        returnedStartLine: 1,
        sourceStartLine: 1,
        lineCount: expectedLineCount(sourceText),
      },
    ]);
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "include-directive",
      startLine: 1,
      endLine: 2,
    });
  }, 30_000);

  it("默认参数（缺省）等价于原文，不做任何过滤", async () => {
    for (const fixture of [
      "c-family/sample.c",
      "c-family/sample.cpp",
      "c-family/sample.cs",
      "python/sample.py",
      "rust/sample.rs",
    ]) {
      const sourceText = await readFixture(fixture);
      const receipt = registry.buildReadView({
        filePath: fixture,
        sourceText,
        isSensitiveCheckApplied: true,
      });
      expect(receipt.viewText).toBe(sourceText);
      expect(receipt.filterStatus).toBe("not-filtered");
      expect(receipt.isViewComplete).toBe(true);
      expect(receipt.omittedKinds).toEqual([]);
    }
  }, 60_000);
});

describe("READ-FORMAT-02 C 系", () => {
  it("字符串里的注释标记不误删；宏整行保留；include 与注释按需省略", async () => {
    const sourceText = await readFixture("c-family/sample.c");
    const receipt = buildView("c-family/sample.c", sourceText, false, false);
    expect(receipt.viewText.includes("#include")).toBe(false);
    expect(receipt.viewText.includes("行注释里出现字符串")).toBe(false);
    expect(receipt.viewText.includes("跨多行")).toBe(false);
    // 字符串内容原样保留
    expect(receipt.viewText).toContain('"// 字符串里的斜杠不是注释"');
    expect(receipt.viewText).toContain('"/* 字符串里的块注释标记 */"');
    expect(receipt.viewText).toContain("char character = '/';");
    // 宏与预处理控制整行保留
    expect(receipt.viewText).toContain("#define MAX_COUNT 42 /* 宏内的注释 */");
    expect(receipt.retainedConstructs).toContain("preprocessor-directive");
    expect(receipt.omittedKinds).toEqual(
      expect.arrayContaining(["include-directive", "comment"]),
    );
    expect(receipt.filterStatus).toBe("partially-filtered");
    expect(receipt.isViewComplete).toBe(false);
    // 注释省略的块注释跨行范围
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 8,
      endLine: 9,
    });
  }, 30_000);

  it("四种组合：仅省注释保留 include；仅省 include 保留注释", async () => {
    const sourceText = await readFixture("c-family/sample.c");
    const commentsOnly = buildView("c-family/sample.c", sourceText, false, true);
    expect(commentsOnly.viewText).toContain("#include <stdio.h>");
    expect(commentsOnly.viewText.includes("行注释里出现字符串")).toBe(false);

    const importsOnly = buildView("c-family/sample.c", sourceText, true, false);
    expect(importsOnly.viewText.includes("#include")).toBe(false);
    expect(importsOnly.viewText).toContain("// 行注释里出现字符串");
  }, 30_000);

  it("C++ 原始字符串与 C# 逐字/原始字符串不被当注释；using 语句不当作导入", async () => {
    const cppSource = await readFixture("c-family/sample.cpp");
    const cppReceipt = buildView("c-family/sample.cpp", cppSource, false, false);
    expect(cppReceipt.viewText).toContain(
      'R"(// raw string 里的内容 /* 也不过滤 */)"',
    );
    expect(cppReceipt.viewText.includes("// 注释")).toBe(false);
    expect(cppReceipt.viewText.includes("#include")).toBe(false);

    const csSource = await readFixture("c-family/sample.cs");
    const csReceipt = buildView("c-family/sample.cs", csSource, false, false);
    expect(csReceipt.viewText.includes("using System;")).toBe(false);
    expect(csReceipt.viewText).toContain(
      '@"C:/path // not a comment"',
    );
    expect(csReceipt.viewText).toContain('"""raw "quoted" text // still raw"""');
    expect(csReceipt.viewText).toContain(
      "using (var stream = new MemoryStream()) {",
    );
    expect(csReceipt.retainedConstructs).not.toContain("import-with-inline-code");
    expect(csReceipt.filterStatus).toBe("filtered");
  }, 30_000);

  it("不完整源码（未闭合块注释）原样返回并报 parse-error", async () => {
    const sourceText = await readFixture("c-family/incomplete.c");
    const receipt = buildView("c-family/incomplete.c", sourceText, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.isFilterable).toBe(false);
    expect(receipt.isViewComplete).toBe(false);
    expect(receipt.limitations.join(" ")).toContain("unterminated-block-comment");
  }, 30_000);
});

describe("READ-FORMAT-02 Python", () => {
  it("井号字符串保留、文档字符串保留、多行导入与尾随注释按需省略", async () => {
    const sourceText = await readFixture("python/sample.py");
    const receipt = buildView("python/sample.py", sourceText, false, false);
    const viewLines = receipt.viewText.split("\n");
    expect(receipt.viewText).not.toContain("模块说明注释");
    expect(viewLines[3]).toBe("");
    expect(viewLines[4]).toBe("");
    expect(viewLines[5]).toBe("");
    expect(viewLines[8]).toBe("");
    expect(viewLines[10]).toBe("");
    expect(receipt.viewText).not.toContain("from collections import OrderedDict");
    expect(receipt.viewText).toContain('"""模块文档字符串：包含 # 井号"""');
    expect(receipt.viewText).toContain('text = "# 字符串里的井号"');
    expect(receipt.viewText).toContain("another = '# 单引号里的井号'");
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "import-statement",
      startLine: 4,
      endLine: 9,
    });
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 1,
      endLine: 2,
    });
  }, 30_000);

  it("同行代码的 import 不删除并标注 partially-filtered", async () => {
    const sourceText = await readFixture("python/sample.py");
    const receipt = buildView("python/sample.py", sourceText, false, false);
    expect(receipt.viewText).toContain("import os; x = 1");
    expect(receipt.retainedConstructs).toContain("import-with-inline-code");
    expect(receipt.filterStatus).toBe("partially-filtered");
    expect(receipt.limitations.join(" ")).toContain("import-with-inline-code");
  }, 30_000);

  it("未闭合三引号字符串原样返回并报 parse-error", async () => {
    const sourceText = await readFixture("python/incomplete.py");
    const receipt = buildView("python/incomplete.py", sourceText, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.limitations.join(" ")).toContain("unterminated-string-literal");
  }, 30_000);
});

describe("READ-FORMAT-02 Rust", () => {
  it("嵌套块注释、文档注释与 use/extern crate 按需省略；原始字符串与字符字面量保留", async () => {
    const sourceText = await readFixture("rust/sample.rs");
    const receipt = buildView("rust/sample.rs", sourceText, false, false);
    expect(receipt.viewText).not.toContain("行注释");
    expect(receipt.viewText).not.toContain("文档注释");
    expect(receipt.viewText).not.toContain("嵌套内层");
    expect(receipt.viewText).not.toContain("use std::collections::HashMap;");
    expect(receipt.viewText).not.toContain("extern crate serde;");
    expect(receipt.viewText).toContain('r#"// raw 里的斜杠不是注释"#');
    expect(receipt.viewText).toContain("&'static str");
    expect(receipt.viewText).toContain("let character = 'a';");
    expect(receipt.viewText).toContain("let value = 1;");
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "import-statement",
      startLine: 3,
      endLine: 8,
    });
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 10,
      endLine: 10,
    });
  }, 30_000);

  it("未闭合嵌套块注释原样返回并报 parse-error", async () => {
    const sourceText = await readFixture("rust/incomplete.rs");
    const receipt = buildView("rust/incomplete.rs", sourceText, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.isFilterable).toBe(false);
  }, 30_000);
});
