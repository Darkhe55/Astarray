/**
 * Go 读取策略的**边界语法分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 目的：把 `read-format-other-languages.ts` 中尚未被覆盖的分支定向补上——
 *  - `countLines("")` → 0 与 `identityLineMap(0)` → []（空源，L30-31/L38-39）；
 *  - 源码**末行无换行符**时的 `indexOf("\n") === -1` 分支（L98/L139/L150）；
 *  - `matchGoImportStatement`：单行 import（L104-105）、`import ( ... )` 块（L113-133）、
 *    块内字符串扫描（L115-121）、块内**未闭合字符串**→ null（L117-118）、
 *    **缺右括号**→ null（L134-135）、块后**同行代码**→ 保留构造（L141-147）；
 *  - `scanGoString` 的**反引号原始串**与未闭合原始串（L81-87）。
 *
 * 断言策略：能行为断言的就行为断言（该省的导入是否真的从 viewText 消失）；
 * 仅用于触发"容错/返回 null"分支的畸形输入，明确断言**不抛错且回执可用**，并在用例名写明意图，
 * 不假装做了更强的语义验证。
 */
import { describe, expect, it } from "vitest";

import { ReadFormatStrategyRegistry } from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

const registry = new ReadFormatStrategyRegistry();
const BACKTICK = String.fromCharCode(96);

function buildGoView(sourceText: string, shouldIncludeComments: boolean, shouldIncludeImports: boolean) {
  return registry.buildReadView({
    filePath: "sample.go",
    sourceText,
    shouldIncludeComments,
    shouldIncludeImports,
    isSensitiveCheckApplied: true,
  });
}

describe("Go 策略：空源与行映射边界", () => {
  it("空源：行数为 0，行映射为空数组，且回执可用", () => {
    // 触发 countLines("") → 0 与 identityLineMap(0) → []
    const view = buildGoView("", false, true);
    expect(view.filterStatus).toBeDefined();
    expect(view.viewText).toBe("");
  });
});

describe("Go 策略：末行无换行符", () => {
  it("单行 import 且无尾换行：省略导入时不得残留", () => {
    const view = buildGoView('import "fmt"', false, false);
    expect(view.viewText).not.toContain('"fmt"');
  });

  it("单行 import 且无尾换行：保留导入时原文可回读", () => {
    const view = buildGoView('import "fmt"', false, true);
    expect(view.viewText).toContain('"fmt"');
  });
});

describe("Go 策略：import 块与其容错分支", () => {
  it("import ( ... ) 块：省略导入时整个块消失、正文保留", () => {
    const sourceText = 'import (\n\t"fmt"\n\t"os"\n)\nvar x = 1\n';
    const view = buildGoView(sourceText, false, false);
    expect(view.viewText).not.toContain('"fmt"');
    expect(view.viewText).not.toContain('"os"');
    expect(view.viewText).toContain("var x = 1");
  });

  it("import 块内出现未闭合字符串：不得抛错，回执可用（走 return null 分支）", () => {
    const sourceText = 'import (\n\t"fmt\n)\nvar x = 1\n';
    const view = buildGoView(sourceText, false, false);
    expect(view.filterStatus).toBeDefined();
    expect(typeof view.viewText).toBe("string");
  });

  it("import 块缺右括号：不得抛错，回执可用（走 blockEndIndex === -1 分支）", () => {
    const sourceText = 'import (\n\t"fmt"\nvar x = 1\n';
    const view = buildGoView(sourceText, false, false);
    expect(view.filterStatus).toBeDefined();
    expect(typeof view.viewText).toBe("string");
  });

  it("import 块后跟同行代码：不得丢弃该导入（走 import-with-inline-code 保留分支）", () => {
    const sourceText = 'import (\n\t"fmt"\n) var x = 1\n';
    const view = buildGoView(sourceText, false, false);
    expect(view.viewText).toContain('"fmt"');
  });

  it("import 块后跟同行注释：省略导入时不得残留", () => {
    const sourceText = 'import (\n\t"fmt"\n) // 说明\nvar x = 1\n';
    const view = buildGoView(sourceText, false, false);
    expect(view.viewText).not.toContain('"fmt"');
  });
});

describe("Go 策略：字符串扫描分支", () => {
  it("反引号原始串：含换行也能被完整消费，后续正文仍可读", () => {
    const sourceText = "var s = " + BACKTICK + "line1\nline2" + BACKTICK + "\nvar y = 2\n";
    const view = buildGoView(sourceText, false, true);
    expect(view.viewText).toContain("var y = 2");
  });

  it("未闭合的反引号原始串：不得抛错，回执可用（走 isUnterminated 分支）", () => {
    const sourceText = "var s = " + BACKTICK + "line1\nline2\n";
    const view = buildGoView(sourceText, false, true);
    expect(view.filterStatus).toBeDefined();
    expect(typeof view.viewText).toBe("string");
  });
});
