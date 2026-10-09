/**
 * 前端脚本读取扫描器的边界补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 该文件（`read-format-frontend-script.ts`）只有**一个导出** `scanFrontendScriptView`，
 * 因此不存在前两轮那种"调错导出"的风险；本轮用**表驱动**覆盖各类脚本形态，
 * 再以前后对照测量真实产出（不预设能拿多少）。
 *
 * 断言原则：能行为断言的就行为断言（注释/导入是否真的被省略、真实代码是否保留）；
 * 畸形输入（未闭合字符串、未闭合模版串）只断言**不抛错且回执可用**，并注明意图。
 */
import { describe, expect, it } from "vitest";

import { scanFrontendScriptView } from "../../../packages/core/src/tools/read-format/read-format-frontend-script.js";

const BACKTICK = String.fromCharCode(96);

function scan(
  sourceText: string,
  shouldIncludeComments: boolean,
  shouldIncludeImports: boolean,
  supportsJsx = false,
) {
  return scanFrontendScriptView({
    sourceText,
    shouldIncludeComments,
    shouldIncludeImports,
    supportsJsx,
  });
}

describe("前端脚本扫描器：空源与注释", () => {
  it("空源：视图为空且不抛错", () => {
    const view = scan("", false, true);
    expect(view.viewText).toBe("");
    expect(view.filterStatus).toBeDefined();
  });

  it("行注释：省略注释时不得残留注释文本", () => {
    const view = scan("// 说明\nconst a = 1;\n", false, true);
    expect(view.viewText).not.toContain("说明");
    expect(view.viewText).toContain("const a = 1");
  });

  it("块注释：省略注释时不得残留注释文本", () => {
    const view = scan("/* 说明 */\nconst a = 1;\n", false, true);
    expect(view.viewText).not.toContain("说明");
    expect(view.viewText).toContain("const a = 1");
  });

  it("保留注释时注释必须还在（对照）", () => {
    const view = scan("// 说明\nconst a = 1;\n", true, true);
    expect(view.viewText).toContain("说明");
  });
});

describe("前端脚本扫描器：导入语句", () => {
  it("普通 import：省略导入后不得残留模块名", () => {
    const view = scan('import x from "mod-a";\nconst a = 1;\n', false, false);
    expect(view.viewText).not.toContain("mod-a");
    expect(view.viewText).toContain("const a = 1");
  });

  it("import type：省略导入后不得残留模块名", () => {
    const view = scan('import type { A } from "mod-b";\nconst a = 1;\n', false, false);
    expect(view.viewText).not.toContain("mod-b");
  });

  it("import 后同行还有代码：必须整行保留（不得删掉真实代码）", () => {
    const view = scan('import x from "mod-c"; const a = 1;\n', false, false);
    expect(view.viewText).toContain("const a = 1");
  });

  it("无尾换行的 import：省略导入后不得残留（触发无换行分支）", () => {
    const view = scan('import x from "mod-d";', false, false);
    expect(view.viewText).not.toContain("mod-d");
  });

  it("动态 import()：不得当作可省略的静态导入而破坏代码", () => {
    const view = scan('const m = await import("mod-e");\n', false, false);
    expect(view.viewText).toContain("mod-e");
  });
});

describe("前端脚本扫描器：JSX 与畸形输入", () => {
  it("JSX（supportsJsx）：JSX 注释被省略时标签内容仍可用", () => {
    const view = scan("const a = <div>{/* 说明 */}hi</div>;\n", false, true, true);
    expect(view.viewText).toContain("div");
    expect(view.viewText).not.toContain("说明");
  });

  it("未闭合字符串：不得抛错且回执可用", () => {
    const view = scan('const a = "unterminated\nconst b = 2;\n', false, true);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("未闭合模版字符串：不得抛错且回执可用", () => {
    const view = scan("const t = " + BACKTICK + "line1\nline2\n", false, true);
    expect(typeof view.viewText).toBe("string");
  });

  it("无尾换行的普通脚本：不得抛错", () => {
    const view = scan("const a = 1;", false, true);
    expect(typeof view.viewText).toBe("string");
  });
});
