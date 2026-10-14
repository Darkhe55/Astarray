/**
 * GUI-02-03（2026-11-08）：**三视图进入页面**（架构守卫 + 行为反例）。
 *
 * 前几轮交付了数据层、只读路由、读模型三视图；本轮把它们**接进真实页面**。
 * 本文件是**源码级**断言（与既有 `gui02-02-permission-ask-ui-constraints` 同口径）：
 * 直接读 `gui-server.ts` 的页面模板与脚本，钉住"界面真的有三视图、且三视图遵守同一硬约束"。
 *
 * 卡内要求（GUI-02-03）：三视图；分页按需加载；**历史状态与运行状态分离**；
 * 查看不恢复、不调模型、不注入上下文；损坏明确处理。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const guiServerSourcePath = path.resolve("packages/gui/src/server/gui-server.ts");

function readGuiServerSource(): string {
  return readFileSync(guiServerSourcePath, "utf8");
}

describe("GUI-02-03：历史三视图必须真的进入页面", () => {
  it("① 页面有历史区，且**三个视图**都有各自容器", () => {
    const sourceText = readGuiServerSource();

    // 历史区标题
    expect(sourceText).toContain('id="history-heading"');
    expect(sourceText).toContain('aria-labelledby="history-heading"');
    // 三视图容器
    expect(sourceText).toContain('id="history-list"');
    expect(sourceText).toContain('id="history-detail"');
    expect(sourceText).toContain('id="history-raw"');
  });

  it("② 分页控件存在（上一页/下一页 + 页码说明），且不提供「全部加载」入口", () => {
    const sourceText = readGuiServerSource();

    expect(sourceText).toContain('id="history-previous-page"');
    expect(sourceText).toContain('id="history-next-page"');
    expect(sourceText).toContain('id="history-paging"');
    // **不得**提供"一次加载全部"的入口（卡内明令不得全量加载）
    expect(sourceText).not.toContain("history-load-all");
    expect(sourceText).not.toMatch(/最多显示全部|加载全部历史/);
  });

  it("③ 三视图切换：详情/原始是**独立**视图，不是把列表行展开", () => {
    const sourceText = readGuiServerSource();

    expect(sourceText).toContain('id="history-show-detail"');
    expect(sourceText).toContain('id="history-show-raw"');
    expect(sourceText).toContain('id="history-back-to-list"');
    // 三个视图的显隐由 class/attribute 控制
    expect(sourceText).toMatch(/history-view/);
  });

  it("④ 界面**明确分列**历史状态与运行状态（重启前 running 不得看起来在运行）", () => {
    const sourceText = readGuiServerSource();

    // 表头两列都要在
    expect(sourceText).toContain("最后状态（当时记录）");
    expect(sourceText).toContain("运行状态（现在）");
    // 脚本必须使用读模型的运行态标签函数产物，而不是自己另编一套
    expect(sourceText).toContain("runtimeStateText");
    expect(sourceText).toContain("recordedStatusText");
  });

  it("⑤ 损坏记录在界面上**明确标注**（有对应文案），不静默隐藏", () => {
    const sourceText = readGuiServerSource();
    expect(sourceText).toContain("history-corrupted");
  });

  it("⑥ 只读：历史区**不得**出现任何写动作入口（无恢复/无模型/无上下文注入）", () => {
    const sourceText = readGuiServerSource();
    // 历史区附近不得有 POST 到恢复或模型类命令
    expect(sourceText).not.toContain("/commands/history-restore");
    expect(sourceText).not.toMatch(/history[^"']*restore/i);
    // 页面脚本里历史相关只允许 GET /mission-history
    expect(sourceText).toContain('"/mission-history"');
  });

  it("⑦ 原始视图用 `pre` 原样呈现（供核对），不是把原文塞进可执行位置", () => {
    const sourceText = readGuiServerSource();
    expect(sourceText).toContain('id="history-raw-text"');
    // 原始文本必须走 textContent（不是 innerHTML），避免当作 HTML 执行
    expect(sourceText).toMatch(/historyRawTextElement\.textContent/);
  });
});
