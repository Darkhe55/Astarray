/**
 * READ-FORMAT-03b：CSS/SCSS/Less、HTML 与 Vue/Svelte 区段分派反例（真实夹具）。
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

const ALL_FIXTURES = [
  "frontend/sample.css",
  "frontend/sample.scss",
  "frontend/sample.html",
  "frontend/sample.vue",
  "frontend/sample.svelte",
];

describe("READ-FORMAT-03b 注册与默认行为", () => {
  it("css/scss/html/vue/svelte 解析到对应策略；默认参数为原文", async () => {
    expect(registry.resolve({ fileName: "a.css" })?.strategyId).toBe("style-sheet");
    expect(registry.resolve({ fileName: "a.scss" })?.strategyId).toBe("style-sheet");
    expect(registry.resolve({ fileName: "a.html" })?.strategyId).toBe("html");
    expect(registry.resolve({ fileName: "a.vue" })?.strategyId).toBe("vue");
    expect(registry.resolve({ fileName: "a.svelte" })?.strategyId).toBe("svelte");
    for (const fixture of ALL_FIXTURES) {
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

describe("READ-FORMAT-03b 样式", () => {
  it("CSS：@import 省略、注释省略、url 与字符串保留", async () => {
    const sourceText = await readFixture("frontend/sample.css");
    const receipt = buildView("frontend/sample.css", sourceText, false, false);
    expect(receipt.viewText).not.toContain("@import");
    expect(receipt.viewText).not.toContain("/* 块注释 */");
    expect(receipt.viewText).not.toContain("尾随注释");
    expect(receipt.viewText).toContain("url(https://example.com/a//b.png)");
    expect(receipt.viewText).toContain("字符串里的块注释标记");
    expect(receipt.viewText).toContain(".card {");
  }, 30_000);

  it("SCSS：行注释/块注释与 @use/@import 省略，url 保留", async () => {
    const sourceText = await readFixture("frontend/sample.scss");
    const receipt = buildView("frontend/sample.scss", sourceText, false, false);
    expect(receipt.viewText).not.toContain("行注释");
    expect(receipt.viewText).not.toContain("@use");
    expect(receipt.viewText).not.toContain("@import");
    expect(receipt.viewText).toContain("url(https://example.com/x//y.png)");
    expect(receipt.viewText).toContain(".a { color: red;");
  }, 30_000);

  it("仅省略注释时 @import 保留；仅省略导入时注释保留", async () => {
    const sourceText = await readFixture("frontend/sample.css");
    const commentsOnly = buildView("frontend/sample.css", sourceText, false, true);
    expect(commentsOnly.viewText).toContain("@import");
    expect(commentsOnly.viewText).not.toContain("/* 块注释 */");

    const importsOnly = buildView("frontend/sample.css", sourceText, true, false);
    expect(importsOnly.viewText).not.toContain("@import");
    expect(importsOnly.viewText).toContain("/* 块注释 */");
  }, 30_000);
});

describe("READ-FORMAT-03b HTML 与区段分派", () => {
  it("HTML：注释与静态资源标签省略；嵌入脚本/样式按区段分派且代码保留", async () => {
    const sourceText = await readFixture("frontend/sample.html");
    const receipt = buildView("frontend/sample.html", sourceText, false, false);
    expect(receipt.viewText).not.toContain("头部注释");
    expect(receipt.viewText).not.toContain("a//b.css");
    expect(receipt.viewText).not.toContain("app.js");
    expect(receipt.viewText).not.toContain("嵌入样式注释");
    expect(receipt.viewText).toContain("url(https://example.com/i//j.png)");
    expect(receipt.viewText).not.toContain("嵌入脚本注释");
    expect(receipt.viewText).toContain("https://example.com/k//l");
    expect(receipt.viewText).toContain("document.body.dataset.url = url;");
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 8,
      endLine: 8,
    });
    expect(receipt.omittedLineRanges).toContainEqual({
      kind: "comment",
      startLine: 14,
      endLine: 14,
    });
    expect(receipt.lineMap).toEqual([
      { returnedStartLine: 1, sourceStartLine: 1, lineCount: 19 },
    ]);
  }, 30_000);

  it("HTML 未闭合注释原样返回并报 parse-error", () => {
    const source = "<div>\n<!-- 未闭合\n";
    const receipt = buildView("inline.html", source, false, false);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
    expect(receipt.isFilterable).toBe(false);
  }, 30_000);
});

describe("READ-FORMAT-03b Vue/Svelte 混合区段", () => {
  it("Vue：模板/脚本/样式区段分别过滤，表达式与字符串保留", async () => {
    const sourceText = await readFixture("frontend/sample.vue");
    const receipt = buildView("frontend/sample.vue", sourceText, false, false);
    expect(receipt.viewText).not.toContain("模板注释");
    expect(receipt.viewText).not.toContain("脚本注释");
    expect(receipt.viewText).not.toContain("样式注释");
    expect(receipt.viewText).toContain("data-url=");
    expect(receipt.viewText).toContain("{{ count }}");
    expect(receipt.viewText).toContain("https://example.com/m//n");
    expect(receipt.viewText).toContain("url(https://example.com/o//p.png)");
  }, 30_000);

  it("Svelte：模板/脚本/样式注释省略，表达式保留", async () => {
    const sourceText = await readFixture("frontend/sample.svelte");
    const receipt = buildView("frontend/sample.svelte", sourceText, false, false);
    expect(receipt.viewText).not.toContain("脚本注释");
    expect(receipt.viewText).not.toContain("模板注释");
    expect(receipt.viewText).not.toContain("样式注释");
    expect(receipt.viewText).toContain("<div data-url={url}>{count}</div>");
    expect(receipt.viewText).toContain("https://example.com/q//r");
    expect(receipt.viewText).toContain("url(https://example.com/s//t.png)");
  }, 30_000);

  it("Vue/Svelte 默认参数不改动内容（与原文逐字节一致）", async () => {
    for (const fixture of ["frontend/sample.vue", "frontend/sample.svelte"]) {
      const sourceText = await readFixture(fixture);
      const receipt = buildView(fixture, sourceText, true, true);
      expect(receipt.viewText).toBe(sourceText);
    }
  }, 30_000);
});

describe("READ-FORMAT-03b 边界", () => {
  it("@forward 省略；导入后同行代码保留并标注", () => {
    const source = '@forward "src/list"; @debug 1;\n';
    const receipt = buildView("inline.scss", source, true, false);
    expect(receipt.viewText).toContain('@forward "src/list"; @debug 1;');
    expect(receipt.retainedConstructs).toContain("import-with-inline-code");
  }, 30_000);

  it("未闭合块注释原样返回并报 parse-error", () => {
    const source = "/* 未闭合\n.a { color: red; }\n";
    const receipt = buildView("inline.css", source, false, true);
    expect(receipt.filterStatus).toBe("parse-error");
    expect(receipt.viewText).toBe(source);
  }, 30_000);

  it("style lang=scss 区段按 SCSS 行注释过滤", () => {
    const source = "<template>\n<div>ok</div>\n</template>\n<style lang=\"scss\">\n// 行注释\n.a { color: red; }\n</style>\n";
    const receipt = buildView("inline.vue", source, false, true);
    expect(receipt.viewText).not.toContain("行注释");
    expect(receipt.viewText).toContain(".a { color: red; }");
  }, 30_000);

  it("资源标签后同行代码保留并标注", () => {
    const source = "<link rel=\"stylesheet\" href=\"a.css\"> <img src=\"x.png\">\n";
    const receipt = buildView("inline.html", source, true, false);
    expect(receipt.viewText).toContain("a.css");
    expect(receipt.retainedConstructs).toContain("import-with-inline-code");
  }, 30_000);
});
