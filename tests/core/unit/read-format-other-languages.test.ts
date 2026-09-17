/**
 * READ-FORMAT-04b：Go、Shell、SQL 反例（真实夹具）。
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

const OTHER_FIXTURES = ["config/sample.go", "config/sample.sh", "config/sample.sql"];

describe("READ-FORMAT-04b 注册与默认行为", () => {
  it("go/sh/bash/sql 解析到对应策略；默认参数为原文", async () => {
    expect(registry.resolve({ fileName: "a.go" })?.strategyId).toBe("go");
    expect(registry.resolve({ fileName: "a.sh" })?.strategyId).toBe("shell");
    expect(registry.resolve({ fileName: "a.bash" })?.strategyId).toBe("shell");
    expect(registry.resolve({ fileName: "a.sql" })?.strategyId).toBe("sql");
    for (const fixture of OTHER_FIXTURES) {
      const sourceText = await readFixture(fixture);
      const receipt = registry.buildReadView({
        filePath: fixture,
        sourceText,
        isSensitiveCheckApplied: true,
      });
      expect(receipt.viewText).toBe(sourceText);
      expect(receipt.filterStatus).toBe("not-filtered");
    }
  }, 60_000);
});

describe("READ-FORMAT-04b Go", () => {
  it("import 单条与块省略；解释/原始字符串与符文不误删", async () => {
    const sourceText = await readFixture("config/sample.go");
    const receipt = buildView("config/sample.go", sourceText, false, false);
    expect(receipt.viewText).not.toContain("import \"fmt\"");
    expect(receipt.viewText).not.toContain("example.com/mod/pkg");
    expect(receipt.viewText).not.toContain("// 行注释");
    expect(receipt.viewText).not.toContain("跨行");
    expect(receipt.viewText).toContain("https://example.com/a//b");
    expect(receipt.viewText).toContain("`// 原始字符串里的双斜杠不是注释`");
    expect(receipt.viewText).toContain("var runeValue = '/'");
    expect(receipt.viewText).toContain("he said");
    expect(receipt.omittedKinds).toEqual(expect.arrayContaining(["comment", "import-statement"]));
  }, 30_000);
});

describe("READ-FORMAT-04b Shell", () => {
  it("# 注释省略；heredoc 与引号内容保留；静态 source 省略、动态 source 保留标注", async () => {
    const sourceText = await readFixture("config/sample.sh");
    const receipt = buildView("config/sample.sh", sourceText, false, false);
    expect(receipt.viewText).not.toContain("# 顶层注释");
    expect(receipt.viewText).not.toContain("# 尾随注释");
    expect(receipt.viewText).not.toContain("source ./lib/common.sh");
    expect(receipt.viewText).not.toContain(". ./lib/other.sh");
    // heredoc 整体保留
    expect(receipt.viewText).toContain("# heredoc 里的井号不是注释");
    expect(receipt.viewText).toContain("url=https://example.com/c//d");
    // 引号内容保留
    expect(receipt.viewText).toContain("single='# 单引号里的井号'");
    expect(receipt.viewText).toContain('url="https://example.com/a//b"');
    // 动态 source 保留并标注
    expect(receipt.viewText).toContain('source "$(dirname "$0")/lib/dynamic.sh"');
    expect(receipt.retainedConstructs).toContain("dynamic-import");
    expect(receipt.filterStatus).toBe("partially-filtered");
    expect(receipt.limitations.join(" ")).toContain("dynamic-import");
  }, 30_000);

  it("未闭合 heredoc 原样返回并报 parse-error", () => {
    const source = "cat <<EOF\n# 未闭合\n";
    const receipt = buildView("inline.sh", source, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
    expect(receipt.limitations.join(" ")).toContain("unterminated-heredoc");
  }, 30_000);
});

describe("READ-FORMAT-04b SQL", () => {
  it("-- 与块注释省略；字符串/标识符里的注释标记保留；imports 标注不适用", async () => {
    const sourceText = await readFixture("config/sample.sql");
    const receipt = buildView("config/sample.sql", sourceText, false, false);
    expect(receipt.viewText).not.toContain("-- 行注释");
    expect(receipt.viewText).not.toContain("/* 块注释 */");
    expect(receipt.viewText).not.toContain("-- 尾随注释");
    expect(receipt.viewText).toContain("'it''s -- not a comment'");
    expect(receipt.viewText).toContain('"quoted -- identifier"');
    expect(receipt.viewText).toContain('"col//name"');
    expect(receipt.viewText).toContain("'https://example.com/a//b'");
    expect(receipt.limitations.join(" ")).toContain("imports-unsupported");
    expect(receipt.limitations.join(" ")).toContain("dialect-comment-variants");
  }, 30_000);
});

describe("READ-FORMAT-04b 边界", () => {
  it("Shell <<- 与带引号定界符的 heredoc 保留", () => {
    const source = "cat <<-'EOF'\n# not comment\nEOF\n";
    const receipt = buildView("inline.sh", source, false, false);
    expect(receipt.viewText).toBe(source);
  }, 30_000);

  it("Shell 动态 source 保留标注；静态 source 带尾注释可省略", () => {
    const dynamicSource = "source $LIB_DIR/a.sh\n";
    const dynamicReceipt = buildView("inline.sh", dynamicSource, true, false);
    expect(dynamicReceipt.viewText).toContain("source $LIB_DIR/a.sh");
    expect(dynamicReceipt.retainedConstructs).toContain("dynamic-import");

    const staticSource = "source ./lib/a.sh  # comment\n";
    const staticReceipt = buildView("inline.sh", staticSource, true, false);
    expect(staticReceipt.viewText).not.toContain("source ./lib/a.sh");
  }, 30_000);

  it("Shell 分号后的 # 注释省略；反引号内的 # 保留", () => {
    const source = "echo a; # comment\nvalue=`echo '# not comment'`\n";
    const receipt = buildView("inline.sh", source, false, false);
    expect(receipt.viewText).not.toContain("# comment");
    expect(receipt.viewText).toContain("`echo '# not comment'`");
  }, 30_000);

  it("Shell 未闭合引号原样返回并报 parse-error", () => {
    const singleQuoteSource = "echo 'unterminated\n";
    const doubleQuoteSource = 'echo "unterminated\n';
    const backtickSource = "echo `unterminated\n";
    for (const source of [singleQuoteSource, doubleQuoteSource, backtickSource]) {
      const receipt = buildView("inline.sh", source, false, false);
      expect(receipt.filterStatus).toBe("parse-error");
      expect(receipt.viewText).toBe(source);
    }
  }, 30_000);

  it("Go import 块后同行代码保留标注；未闭合原始字符串 parse-error", () => {
    const inlineCode = 'import (\n  "fmt"\n); var x = 1\n';
    const inlineReceipt = buildView("inline.go", inlineCode, true, false);
    expect(inlineReceipt.viewText).toContain('import (');
    expect(inlineReceipt.retainedConstructs).toContain("import-with-inline-code");

    const brokenRawString = "var raw = `unterminated\n";
    const brokenReceipt = buildView("inline.go", brokenRawString, true, true);
    expect(brokenReceipt.filterStatus).toBe("parse-error");
  }, 30_000);

  it("SQL 未闭合字符串与块注释 parse-error", () => {
    const brokenString = "SELECT 'unterminated\n";
    expect(buildView("inline.sql", brokenString, true, true).filterStatus).toBe("parse-error");
    const brokenComment = "SELECT 1 /* unterminated\n";
    expect(buildView("inline.sql", brokenComment, false, true).filterStatus).toBe("parse-error");
  }, 30_000);
});
