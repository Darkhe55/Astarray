/**
 * C 系读取策略的**边界分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 目的：把 `read-format-strategies.ts` 中尚未被覆盖的分支定向补上——
 *  - `resolveCFamilyLanguageKind` 的扩展名 switch：`.java`(L122)、`.m`/`.mm`(L124-125)、
 *    `.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh`(L127-131)、`default`(L133)；
 *  - `buildLineImportMatch` / `buildImportWithInlineCodeMatch` 的
 *    **源码末行没有换行符**分支（`newlineIndex === -1`，L145/L152/L163）——这是真实存在的输入
 *    （读取无尾换行的文件），此前没被任何用例触发。
 *
 * 断言策略：能用行为断言的就用行为断言（导入被过滤后不应再出现在 viewText 中）；
 * 仅用于触发 switch 分支的情形，明确断言回执可用（不得抛错、字段齐备），并在用例名里写明意图，
 * 不假装做了更强的行为验证。
 */
import { describe, expect, it } from "vitest";

import { ReadFormatStrategyRegistry } from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

const registry = new ReadFormatStrategyRegistry();

function buildView(
  filePath: string,
  sourceText: string,
  shouldIncludeComments: boolean,
  shouldIncludeImports: boolean,
) {
  return registry.buildReadView({
    filePath,
    sourceText,
    shouldIncludeComments,
    shouldIncludeImports,
    isSensitiveCheckApplied: true,
  });
}

/** 全部 C 系后缀（含 switch 各分支与 default）。 */
const C_FAMILY_FILE_NAMES = [
  "a.c",
  "a.h",
  "a.cc",
  "a.cpp",
  "a.cxx",
  "a.hpp",
  "a.hh",
  "a.m",
  "a.mm",
  "a.cs",
  "a.java",
];

describe("C 系策略：扩展名 switch 分支", () => {
  it("每个 C 系后缀都解析到 c-family 策略，且能产出可用回执（触发 switch 各分支）", () => {
    for (const fileName of C_FAMILY_FILE_NAMES) {
      expect(registry.resolve({ fileName })?.strategyId).toBe("c-family");
      const view = buildView(fileName, "#include <stdio.h>\nint main(void) { return 0; }\n", false, true);
      // 仅触发分支：断言回执可用，不做更强的行为声明
      expect(typeof view.viewText).toBe("string");
      expect(view.filterStatus).toBeDefined();
      expect(typeof view.isFilterable).toBe("boolean");
    }
  });

  it("C/C++/ObjC 系后缀都能过滤掉导入行（行为断言：过滤后不得再出现该导入）", () => {
    // 只对 `#include`/`#import` 确为真实导入语法的语言做行为断言。
    // C#/Java 用 `using`/`import` 语法，策略按语言类型分模式，`#include` 不是其导入语法，
    // 因此不对它们声称"会过滤"——那会是不真实的断言（首版就是这样写错并被实测打回的）。
    const includeSyntaxFileNames = ["a.c", "a.h", "a.cc", "a.cpp", "a.cxx", "a.hpp", "a.hh", "a.m", "a.mm"];
    for (const fileName of includeSyntaxFileNames) {
      const view = buildView(fileName, "#include <stdio.h>\nint main(void) { return 0; }\n", false, false);
      expect(view.viewText).not.toContain("#include <stdio.h>");
      expect(view.viewText).toContain("int main(void)");
    }
  });

  it("C#/Java 后缀：按各自导入语法产出可用回执（不断言 # 语法被过滤）", () => {
    const csharpView = buildView("A.cs", "using System;\nclass A {}\n", false, false);
    expect(typeof csharpView.viewText).toBe("string");
    expect(csharpView.viewText).toContain("class A");
    const javaView = buildView("A.java", "import java.util.List;\nclass A {}\n", false, false);
    expect(typeof javaView.viewText).toBe("string");
    expect(javaView.viewText).toContain("class A");
  });
});

describe("C 系策略：源码末行无换行符的边界", () => {
  it("末行导入且无尾换行：仍被识别为导入并过滤，且不越界", () => {
    // 无尾换行 → 走 newlineIndex === -1 分支（L145/L152）
    const sourceText = "#include <stdio.h>";
    const view = buildView("a.c", sourceText, false, false);
    expect(view.viewText).not.toContain("#include <stdio.h>");
  });

  it("末行导入且无尾换行：保留导入时不得截断（endIndex 取整段长度）", () => {
    const sourceText = "#include <stdio.h>";
    const view = buildView("a.c", sourceText, false, true);
    expect(view.viewText).toContain("#include <stdio.h>");
  });

  it("首行导入后仍有正文（对照）：带尾换行的常规输入不得受影响", () => {
    const sourceText = "#include <stdio.h>\nint main(void) { return 0; }\n";
    const withImports = buildView("a.c", sourceText, false, true);
    const withoutImports = buildView("a.c", sourceText, false, false);
    expect(withImports.viewText).toContain("#include <stdio.h>");
    expect(withoutImports.viewText).not.toContain("#include <stdio.h>");
    expect(withoutImports.viewText).toContain("int main(void)");
  });

  it("导入与代码同行且无尾换行：走 import-with-inline-code 分支（L163），不得抛错", () => {
    const sourceText = "#include <stdio.h> int main(void) { return 0; }";
    const view = buildView("a.c", sourceText, false, false);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("导入与代码同行且无尾换行：保留导入时原文可回读", () => {
    const sourceText = "#include <stdio.h> int main(void) { return 0; }";
    const view = buildView("a.c", sourceText, false, true);
    expect(view.viewText).toContain("#include <stdio.h>");
  });
});
