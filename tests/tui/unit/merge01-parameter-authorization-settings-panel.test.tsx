/**
 * MERGE-01-03 反例（2026-10-10）：**TUI 内也要能看懂参数授权设置**。
 *
 * 卡内检查点 03 要求"**CLI/TUI/GUI/SDK 设置一致**"。GUI 侧已交付只读视图，
 * 但 **TUI 侧完全没有**该状态 ⇒ 用户在 TUI 里看不出参数细分是否关闭，
 * 也就无法在"关闭会放宽权限"时被正确提示。
 *
 * 本片钉住的语义（与 GUI 视图同口径，避免两套说法）：
 *  - TUI 状态**始终**可查询该视图（未提供 ⇒ **如实"未知"**，不伪装默认开启）；
 *  - 细分关闭 ⇒ 明确提示**可能放宽权限**（不是中性的"已关闭"）；
 *  - **TUI 只读**：不提供写入/快捷键（放宽需认证用户确认，走 SDK/CLI）。
 *
 * 只跑纯函数与状态容器，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import React from "react";
import { render } from "ink-testing-library";

import { AppState } from "../../../packages/tui/src/ui/state/app-state.js";
import { ParameterAuthorizationSettingsPanel } from "../../../packages/tui/src/ui/components/panels.js";

describe("MERGE-01-03：TUI 参数授权设置视图", () => {
  it("① 未提供设置 ⇒ 如实「未知」（不伪装默认开启）", () => {
    const state = new AppState();
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.isAvailable).toBe(false);
    expect(view.isParameterRulesEnabled).toBeNull();
    expect(view.displayText).toMatch(/未知|不可用/);
    expect(view.mayWidenPermissions).toBe(false);
  });

  it("② 提供设置 ⇒ 逐字段如实反映", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 3,
      ruleCount: 2,
    });
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.isAvailable).toBe(true);
    expect(view.isParameterAuthorizationEnabled).toBe(true);
    expect(view.isParameterRulesEnabled).toBe(false);
    expect(view.configurationRevision).toBe(3);
    expect(view.ruleCount).toBe(2);
  });

  it("③ 细分关闭 ⇒ 明确提示**可能放宽权限**", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 1,
      ruleCount: 0,
    });
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.mayWidenPermissions).toBe(true);
    expect(view.displayText).toMatch(/放宽/);
  });

  it("④ 两个开关都开 ⇒ 不得误报放宽", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      configurationRevision: 1,
      ruleCount: 0,
    });
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.mayWidenPermissions).toBe(false);
    expect(view.displayText).toMatch(/已启用/);
  });

  it("⑤ TUI 只读：不得提供写入能力", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 1,
      ruleCount: 0,
    });
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.isReadOnly).toBe(true);
    expect(view.hasWriteAction).toBe(false);
  });

  it("⑥ 清空后必须回到**未知**（不得残留上一份数据）", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 1,
      ruleCount: 0,
    });
    state.clearParameterAuthorizationSettings();
    const view = state.getParameterAuthorizationSettingsView();
    expect(view.isAvailable).toBe(false);
    expect(view.isParameterRulesEnabled).toBeNull();
  });

  it("⑦ 与 GUI 视图**同口径**（同一字段集，避免两套说法）", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 9,
      ruleCount: 4,
    });
    const view = state.getParameterAuthorizationSettingsView();
    expect(Object.keys(view).sort()).toEqual(
      [
        "configurationRevision",
        "displayText",
        "hasWriteAction",
        "isAvailable",
        "isParameterAuthorizationEnabled",
        "isParameterRulesEnabled",
        "isReadOnly",
        "mayWidenPermissions",
        "ruleCount",
      ].sort(),
    );
  });
});

describe("MERGE-01-03：TUI 面板必须真的渲染出放宽提示", () => {
  it("⑧ 细分关闭时面板必须显示「可能放宽权限」，且声明只读", () => {
    const state = new AppState();
    state.setParameterAuthorizationSettings({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 2,
      ruleCount: 1,
    });
    const { lastFrame } = render(
      <ParameterAuthorizationSettingsPanel
        view={state.getParameterAuthorizationSettingsView()}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("放宽");
    expect(frame).toContain("只读");
  });

  it("⑨ 不可用时面板必须显示「未知」（不得显示成默认开启）", () => {
    const state = new AppState();
    const { lastFrame } = render(
      <ParameterAuthorizationSettingsPanel
        view={state.getParameterAuthorizationSettingsView()}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("未知");
    // 不得伪装成默认开启
    expect(frame).not.toContain("总开关 true");
  });
});