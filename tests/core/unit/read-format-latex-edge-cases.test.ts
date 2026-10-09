/**
 * LaTeX 读取扫描器的**边界分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 先逐行读了实现（`read-format-latex.ts` L28-155）再写用例，目标分支：
 *  - L35/L43：空源 → 行数 0、行映射为空；
 *  - L39：源码末行**无换行符**；
 *  - L62：省略行**不连续**时必须产生第二段范围（不得合并成一段）；
 *  - L98/L118：`findCommandEnd` 中命令名后的空格、以及括号内遇到换行即停止；
 *  - L135/L143/L145/L149：导入行判定里的 `indexOf("\n") === -1`，以及
 *    **行尾还有内容（非注释）时必须整行保留**（否则会删掉真实正文）。
 *
 * 断言原则：能行为断言的就行为断言（导入是否真的从 viewText 消失、范围是否分成两段）；
 * 仅用于触发容错分支的畸形输入只断言**不抛错且回执可用**，并注明意图。
 */
import { describe, expect, it } from "vitest";

import { scanLatexView } from "../../../packages/core/src/tools/read-format/read-format-latex.js";

function scan(sourceText: string, shouldIncludeComments: boolean, shouldIncludeImports: boolean) {
  return scanLatexView({ sourceText, shouldIncludeComments, shouldIncludeImports });
}

describe("LaTeX 扫描器：空源与行映射", () => {
  it("空源：视图为空且行映射为空（触发 countLines('')/identityLineMap(0)）", () => {
    const view = scan("", false, true);
    expect(view.viewText).toBe("");
    expect(view.lineMap).toHaveLength(0);
    expect(view.filterStatus).toBeDefined();
  });
});

describe("LaTeX 扫描器：导入行判定", () => {
  it("整行导入且无尾换行：省略导入后不得残留（触发 indexOf('\\n') === -1）", () => {
    const view = scan("\\usepackage{amsmath}", false, false);
    expect(view.viewText).not.toContain("usepackage");
  });

  it("整行导入且带尾换行：省略导入后不得残留（对照）", () => {
    const view = scan("\\usepackage{amsmath}\n\\section{标题}\n", false, false);
    expect(view.viewText).not.toContain("usepackage");
    expect(view.viewText).toContain("\\section{标题}");
  });

  it("导入行尾还有正文：必须整行保留（否则会删掉真实正文）", () => {
    const view = scan("\\usepackage{amsmath} \\section{标题}\n", false, false);
    expect(view.viewText).toContain("\\section{标题}");
  });

  it("导入行尾只有注释：属于可安全省略，省略后不得残留导入", () => {
    const view = scan("\\usepackage{amsmath} % 说明\n\\section{标题}\n", false, false);
    expect(view.viewText).not.toContain("usepackage");
    expect(view.viewText).not.toContain("说明");
  });

  it("命令名与参数之间有空格：不得抛错且回执可用（触发空格跳过分支）", () => {
    const view = scan("\\usepackage {amsmath}", false, false);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });

  it("括号内遇到换行（未闭合）：不得抛错且回执可用（触发换行停止分支）", () => {
    const view = scan("\\usepackage{\namsmath}\n", false, false);
    expect(typeof view.viewText).toBe("string");
    expect(view.filterStatus).toBeDefined();
  });
});

describe("LaTeX 扫描器：省略行范围", () => {
  it("两处不连续的导入行：必须产生两段省略范围（不得合并）", () => {
    const sourceText = [
      "\\usepackage{amsmath}",
      "\\section{正文}",
      "\\usepackage{graphicx}",
      "\\section{结尾}",
      "",
    ].join("\n");
    const view = scan(sourceText, false, false);
    expect(view.omittedLineRanges.length).toBeGreaterThanOrEqual(2);
  });

  it("连续两行导入：可合并为一段范围", () => {
    const sourceText = ["\\usepackage{amsmath}", "\\usepackage{graphicx}", "\\section{正文}", ""].join(
      "\n",
    );
    const view = scan(sourceText, false, false);
    expect(view.omittedLineRanges.length).toBe(1);
  });
});
