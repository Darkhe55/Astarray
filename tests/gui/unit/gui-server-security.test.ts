/**
 * GUI-01-R-02 单元测试：HTML 转义与用户输入清洗（本地确定性策略）。
 */
import { describe, expect, it } from "vitest";

import {
  escapeHtmlText,
  sanitizeUserInput,
} from "../../../packages/gui/src/server/gui-server.js";

describe("escapeHtmlText", () => {
  it("转义全部 HTML 元字符", () => {
    expect(escapeHtmlText('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("普通文本保持不变并保留中文", () => {
    expect(escapeHtmlText("生成周报 v2")).toBe("生成周报 v2");
  });

  it("先替换 & 再替换其他字符，不产生二次转义", () => {
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;");
  });
});

describe("sanitizeUserInput", () => {
  it("去控制字符并去首尾空白", () => {
    expect(sanitizeUserInput("  生成\u0007报告 <b>x</b>  ")).toBe(
      "生成报告 <b>x</b>",
    );
  });

  it("保留换行与制表符（语义不变）", () => {
    expect(sanitizeUserInput("第一行\n第二行\t结束")).toBe(
      "第一行\n第二行\t结束",
    );
  });

  it("超长输入截断到 4000 字符", () => {
    expect(sanitizeUserInput("a".repeat(5000)).length).toBe(4000);
  });

  it("纯空白输入归一为空字符串", () => {
    expect(sanitizeUserInput(" \u0000 \t ")).toBe("");
  });
});
