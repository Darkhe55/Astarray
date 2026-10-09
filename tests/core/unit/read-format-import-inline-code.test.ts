/**
 * 导入与代码同行（`import-with-inline-code`）的定向补测
 * （E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 为什么单独测这个：`read-format-strategies.ts` 的
 * `buildImportWithInlineCodeMatch`（含 `newlineIndex === -1` 分支，L163）
 * **只被 C#(`using`) 与 Java(`import`) 路径调用**（L296/L316），
 * 而上一轮我用 C 系 `#include` 补测，根本走不到它——实测 L163 仍未覆盖。
 *
 * 语义：导入语句**同一行后面还跟着代码**时，该行不能整行丢弃（否则会删掉真实代码），
 * 必须作为 `import-with-inline-code` 保留。这里对这一行为做**行为断言**：
 * 保留导入模式下该行仍在；省略导入模式下该行也**不得被删掉**（因为行内有代码）。
 */
import { describe, expect, it } from "vitest";

import { ReadFormatStrategyRegistry } from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

const registry = new ReadFormatStrategyRegistry();

function buildView(filePath: string, sourceText: string, shouldIncludeImports: boolean) {
  return registry.buildReadView({
    filePath,
    sourceText,
    shouldIncludeComments: false,
    shouldIncludeImports,
    isSensitiveCheckApplied: true,
  });
}

describe("导入与代码同行：C# (`using`)", () => {
  it("同行有代码且带尾换行：省略导入时该行不得被删除", () => {
    const view = buildView("A.cs", "using System; var x = 1;\n", false);
    expect(view.viewText).toContain("using System");
    expect(view.viewText).toContain("var x = 1");
  });

  it("同行有代码且无尾换行：省略导入时该行不得被删除（触发 newlineIndex === -1）", () => {
    const view = buildView("A.cs", "using System; var x = 1;", false);
    expect(view.viewText).toContain("using System");
  });

  it("对照：整行都是导入且带尾换行时，省略导入应当移除该行", () => {
    const view = buildView("A.cs", "using System;\nvar x = 1;\n", false);
    expect(view.viewText).not.toContain("using System");
    expect(view.viewText).toContain("var x = 1");
  });

  it("对照：保留导入时该行必须还在", () => {
    const view = buildView("A.cs", "using System;\nvar x = 1;\n", true);
    expect(view.viewText).toContain("using System");
  });
});

describe("导入与代码同行：Java (`import`)", () => {
  it("同行有代码且带尾换行：省略导入时该行不得被删除", () => {
    const view = buildView("A.java", "import java.util.List; class A {}\n", false);
    expect(view.viewText).toContain("import java.util.List");
    expect(view.viewText).toContain("class A");
  });

  it("同行有代码且无尾换行：省略导入时该行不得被删除（触发 newlineIndex === -1）", () => {
    const view = buildView("A.java", "import java.util.List; class A {}", false);
    expect(view.viewText).toContain("import java.util.List");
  });

  it("对照：整行都是导入时，省略导入应当移除该行", () => {
    const view = buildView("A.java", "import java.util.List;\nclass A {}\n", false);
    expect(view.viewText).not.toContain("import java.util.List");
    expect(view.viewText).toContain("class A");
  });
});
