/**
 * GUI-02-04（2026-11-08）：**恢复按钮的界面控件**反例（先红后绿）。
 *
 * 卡内要求：恢复须**显式** + **先对账** + **重新鉴权**。
 * 前几轮已交付：门面方法 + 强制三道门 + `POST /commands/recovery-resume` 路由。
 * 本轮补**界面控件**，使其在页面上真的可用，并钉住三条界面硬约束：
 *
 * ① **不默认选中、不自动恢复**：页面上**不得**有"自动/加载即恢复"的路径
 *   （与既有"不默认选中批准、不提供一键批准全部"同口径）；
 * ② **必须显式**：请求体里 `hasExplicitUserConfirmation` 必须为 `true`，
 *   且该值只能来自用户点击（不是脚本默认填的）；
 * ③ **「还差什么」要显示**：服务端返回的拒绝理由必须**呈现给用户**，
 *   不得静默失败（否则用户只会看到"点了没反应"）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const guiServerSourcePath = path.resolve("packages/gui/src/server/gui-server.ts");

function readGuiServerSource(): string {
  return readFileSync(guiServerSourcePath, "utf8");
}

describe("GUI-02-04：恢复入口的界面控件", () => {
  it("① 恢复区提供**逐 mission** 的恢复按钮容器，不是一个「全部恢复」按钮", () => {
    const sourceText = readGuiServerSource();

    // 恢复区要有结果/提示位
    expect(sourceText).toContain('id="recovery-resume-result"');
    // 逐条渲染（在渲染循环里创建按钮），而不是单个全局按钮
    expect(sourceText).toMatch(/requestMissionResume/);
    // 明确**不得**存在"全部恢复"入口。
    // 注意收紧：首版用 /全部恢复|resume-all|recover-all/i 会**误命中**
    // `expectedOperationFingerprint`（其中含子串 "recover-all"）—— 那是变量名不是入口。
    // 故只匹配"独立标识符/文案"形态：中文短语，或带引号/等号的标识符。
    expect(sourceText).not.toMatch(/全部恢复/);
    expect(sourceText).not.toMatch(/["'`](resume-all|recover-all)["'`]/i);
    expect(sourceText).not.toMatch(/\b(resumeAll|recoverAll)\b/);
  });

  it("② **不默认选中、不自动恢复**：页面初始化路径里不得自动调用恢复", () => {
    const sourceText = readGuiServerSource();

    /**
     * 更强的判定（首版用了宽松正则，会**跨行误命中** —— 已收紧）：
     * 把 `requestMissionResume` 的**每一处调用点**找出来，逐个检查它是否位于
     * 一个 `addEventListener("click", ...)` 回调里。
     * 只要存在"非点击触发"的调用（例如页面初始化时直接调），就必须红。
     */
    const definitionIndex = sourceText.indexOf("function requestMissionResume(");
    expect(definitionIndex).toBeGreaterThan(-1);

    const allMatches = [...sourceText.matchAll(/requestMissionResume\(/g)].map(
      (match) => match.index ?? 0,
    );
    const invocationIndexes = allMatches.filter((index) => index !== definitionIndex);
    expect(invocationIndexes.length, "恢复函数必须有真实调用点").toBeGreaterThan(0);

    for (const index of invocationIndexes) {
      const lookBehind = sourceText.slice(Math.max(0, index - 500), index);
      expect(
        lookBehind.includes('addEventListener("click"'),
        "requestMissionResume 的调用点必须由用户点击触发（位置 " + String(index) + "）",
      ).toBe(true);
    }

    // 且页面初始化段（refreshHistory 首次调用附近）**不得**出现恢复调用
    const bootstrapIndex = sourceText.indexOf("refreshHistory();");
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(sourceText.slice(bootstrapIndex, bootstrapIndex + 400)).not.toContain(
      "requestMissionResume(",
    );
  });

  it("③ **必须显式**：请求体里 `hasExplicitUserConfirmation` 必须为 true", () => {
    const sourceText = readGuiServerSource();

    expect(sourceText).toContain('"/commands/recovery-resume"');
    expect(sourceText).toMatch(/hasExplicitUserConfirmation:\s*true/);
  });

  it("④ 服务端拒绝的**理由必须呈现给用户**（不得静默失败）", () => {
    const sourceText = readGuiServerSource();

    // 要把 outcome / detail 写进结果位
    expect(sourceText).toMatch(/recoveryResumeResultElement\.textContent\s*=/);
    expect(sourceText).toMatch(/outcome/);
    expect(sourceText).toMatch(/detail/);
  });

  it("⑤ 恢复区仍声明**只读 + 三道门**（先对账/重新鉴权不得被界面淡化）", () => {
    const sourceText = readGuiServerSource();
    expect(sourceText).toContain("显式确认");
    expect(sourceText).toContain("先完成对账");
    expect(sourceText).toContain("重新鉴权");
  });
});
