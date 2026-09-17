/**
 * READ-FORMAT-04a：LaTeX 与配置/文档格式反例（真实夹具）。
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

const CONFIG_FIXTURES = [
  "config/sample.tex",
  "config/sample.yaml",
  "config/sample.jsonc",
  "config/sample.toml",
  "config/sample.md",
  "config/sample.txt",
];

describe("READ-FORMAT-04a 注册与默认行为", () => {
  it("扩展名解析到对应策略；默认参数为原文", async () => {
    expect(registry.resolve({ fileName: "a.tex" })?.strategyId).toBe("latex");
    expect(registry.resolve({ fileName: "a.jsonc" })?.strategyId).toBe("jsonc");
    expect(registry.resolve({ fileName: "a.json" })?.strategyId).toBe("json");
    expect(registry.resolve({ fileName: "a.yaml" })?.strategyId).toBe("yaml");
    expect(registry.resolve({ fileName: "a.toml" })?.strategyId).toBe("toml");
    expect(registry.resolve({ fileName: "a.md" })?.strategyId).toBe("markdown");
    expect(registry.resolve({ fileName: "a.txt" })?.strategyId).toBe("plain-text");
    for (const fixture of CONFIG_FIXTURES) {
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

describe("READ-FORMAT-04a LaTeX", () => {
  it("普通注释与 usepackage/input 省略；转义百分号与逐字环境保留", async () => {
    const sourceText = await readFixture("config/sample.tex");
    const receipt = buildView("config/sample.tex", sourceText, false, false);
    expect(receipt.viewText).not.toContain("% 普通注释");
    expect(receipt.viewText).not.toContain("\\usepackage[utf8]");
    expect(receipt.viewText).not.toContain("\\input{sections/intro}");
    // 转义百分号不是注释
    expect(receipt.viewText).toContain("\\newcommand{\\percent}{100\\%}");
    // 逐字环境整体保留
    expect(receipt.viewText).toContain("\\begin{verbatim}");
    expect(receipt.viewText).toContain("% 逐字环境里的百分号不是注释");
    expect(receipt.viewText).toContain("\\usepackage{not-an-import}");
    expect(receipt.viewText).toContain("\\begin{lstlisting}");
    expect(receipt.viewText).toContain("% also verbatim");
    expect(receipt.omittedKinds).toEqual(expect.arrayContaining(["comment", "import-statement"]));
  }, 30_000);

  it("未闭合逐字环境原样返回并报 parse-error", () => {
    const source = "\\begin{verbatim}\n% 未闭合\n";
    const receipt = buildView("inline.tex", source, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
    expect(receipt.limitations.join(" ")).toContain("unterminated-verbatim-environment");
  }, 30_000);
});

describe("READ-FORMAT-04a 配置", () => {
  it("YAML：# 注释省略；URL 片段与引号内 # 保留；imports 标注不适用", async () => {
    const sourceText = await readFixture("config/sample.yaml");
    const receipt = buildView("config/sample.yaml", sourceText, false, false);
    expect(receipt.viewText).not.toContain("# 顶层注释");
    expect(receipt.viewText).not.toContain("# 尾随注释");
    expect(receipt.viewText).toContain("url: https://example.com/a#fragment");
    expect(receipt.viewText).toContain("value # not comment");
    expect(receipt.limitations.join(" ")).toContain("imports-unsupported");
  }, 30_000);

  it("JSONC：行注释与块注释省略，URL 里的双斜杠保留", async () => {
    const sourceText = await readFixture("config/sample.jsonc");
    const receipt = buildView("config/sample.jsonc", sourceText, false, false);
    expect(receipt.viewText).not.toContain("// 行注释");
    expect(receipt.viewText).not.toContain("/* 块注释 */");
    expect(receipt.viewText).toContain("https://example.com/a//b");
  }, 30_000);

  it("TOML：# 注释省略，引号内 # 保留", async () => {
    const sourceText = await readFixture("config/sample.toml");
    const receipt = buildView("config/sample.toml", sourceText, false, false);
    expect(receipt.viewText).not.toContain("# 顶层注释");
    expect(receipt.viewText).not.toContain("# 尾随注释");
    expect(receipt.viewText).toContain("https://example.com/a#fragment");
  }, 30_000);

  it("JSON：无注释能力时不虚报已过滤", () => {
    const source = "{ \"name\": \"sample\" }\n";
    const receipt = buildView("inline.json", source, false, false);
    expect(receipt.viewText).toBe(source);
    expect(receipt.filterStatus).toBe("not-filtered");
    expect(receipt.limitations.join(" ")).toContain("comments-unsupported");
    expect(receipt.limitations.join(" ")).toContain("imports-unsupported");
  }, 30_000);
});

describe("READ-FORMAT-04a Markdown 与纯文本", () => {
  it("Markdown：HTML 注释省略，围栏代码块整体保留", async () => {
    const sourceText = await readFixture("config/sample.md");
    const receipt = buildView("config/sample.md", sourceText, false, false);
    expect(receipt.viewText).not.toContain("文档注释");
    expect(receipt.viewText).not.toContain("行内注释");
    expect(receipt.viewText).toContain("// 围栏代码里的内容不解析");
    expect(receipt.viewText).toContain("https://example.com/a//b");
    expect(receipt.viewText).toContain("```js");
    expect(receipt.viewText).toContain("继续。");
    expect(receipt.limitations.join(" ")).toContain("imports-unsupported");
  }, 30_000);

  it("Markdown 未闭合注释原样返回并报 parse-error", () => {
    const source = "正文\n<!-- 未闭合\n";
    const receipt = buildView("inline.md", source, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
  }, 30_000);

  it("纯文本：无注释能力，原样返回并标注不适用", async () => {
    const sourceText = await readFixture("config/sample.txt");
    const receipt = buildView("config/sample.txt", sourceText, false, false);
    expect(receipt.viewText).toBe(sourceText);
    expect(receipt.filterStatus).toBe("not-filtered");
    expect(receipt.limitations.join(" ")).toContain("comments-unsupported");
    expect(receipt.limitations.join(" ")).toContain("imports-unsupported");
  }, 30_000);
});
