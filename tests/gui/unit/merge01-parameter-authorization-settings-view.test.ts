/**
 * MERGE-01-03 反例（2026-10-10）：**GUI 也必须能看到参数授权设置**（四入口一致的 GUI 一环）。
 *
 * 卡内检查点 03 要求："**CLI/TUI/GUI/SDK 设置一致**与包级执行证据"。
 *
 * 现状缺口（本轮实测）：上一轮交付了 SDK 与 CLI 入口，但**GUI 快照完全没有该设置**
 * ⇒ "四入口一致"里的 GUI 一环不成立（用户无法在 GUI 看出来当前是否关闭了参数细分，
 * 也就无法在"关闭会放宽权限"时被正确提示）。
 *
 * 本片钉住的语义：
 *  - GUI 快照**始终**携带参数授权设置视图（缺省为空视图，**不伪造**条目）；
 *  - 视图**只读**：GUI 不提供写入路径（写入必须经既有确认门禁的 SDK/CLI，
 *    卡内"扩大权限需既有认证用户确认"**不得**被 GUI 旁路）；
 *  - 当"细分已关闭"时，视图必须**明确标注这可能是放宽**（不得显示成中性的"功能已关闭"）；
 *  - 来源不可用时**如实报告未知**，不显示成"默认开启"。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiParameterAuthorizationSettingsView,
  buildGuiSnapshot,
  createGuiTaskTracker,
} from "../../../packages/gui/src/application/gui-read-model.js";

describe("MERGE-01-03：GUI 参数授权设置视图（只读、不得旁路确认）", () => {
  it("① 未提供设置 ⇒ 空视图（不伪造'默认开启'）", () => {
    const view = buildGuiParameterAuthorizationSettingsView(undefined);
    expect(view.isAvailable).toBe(false);
    expect(view.isParameterAuthorizationEnabled).toBeNull();
    expect(view.isParameterRulesEnabled).toBeNull();
    expect(view.displayText).toMatch(/未知|不可用/);
  });

  it("② 提供设置 ⇒ 如实反映两个开关与配置 revision", () => {
    const view = buildGuiParameterAuthorizationSettingsView({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 5,
      ruleCount: 2,
    });
    expect(view.isAvailable).toBe(true);
    expect(view.isParameterAuthorizationEnabled).toBe(true);
    expect(view.isParameterRulesEnabled).toBe(false);
    expect(view.configurationRevision).toBe(5);
    expect(view.ruleCount).toBe(2);
  });

  it("③ 细分已关闭 ⇒ 必须明确标注**可能放宽权限**（不得显示成中性'已关闭'）", () => {
    const view = buildGuiParameterAuthorizationSettingsView({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 5,
      ruleCount: 2,
    });
    expect(view.mayWidenPermissions).toBe(true);
    expect(view.displayText).toMatch(/放宽/);
    // 必须提示需要用户确认才能放宽（GUI 自身不提供写入）
    expect(view.displayText).toMatch(/确认|只读/);
  });

  it("④ 两个开关都开启 ⇒ 不得误报为放宽", () => {
    const view = buildGuiParameterAuthorizationSettingsView({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      configurationRevision: 1,
      ruleCount: 0,
    });
    expect(view.mayWidenPermissions).toBe(false);
    /**
     * 不得**断言**"未放宽"这类否定表述：
     * 文案里"（未放宽）"是**否定**，用 `/放宽/` 取反会误判。
     * 改为断言其**肯定**语义（明确说明两个开关都已启用）。
     */
    expect(view.displayText).toMatch(/已启用/);
  });

  it("⑤ GUI 视图必须显式声明**只读**（不得成为放宽权限的旁路）", () => {
    const view = buildGuiParameterAuthorizationSettingsView({
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 5,
      ruleCount: 2,
    });
    expect(view.isReadOnly).toBe(true);
    expect(view.hasWriteAction).toBe(false);
  });

  it("⑥ 快照必须**始终**携带该视图（缺省为空视图）", () => {
    const snapshot = buildGuiSnapshot({
      sessionId: "session-gui",
      mode: "assist",
      tracker: createGuiTaskTracker(),
      crossProject: { authorizations: [], copyReceipts: [] },
    });
    expect(snapshot.parameterAuthorizationSettings).toBeDefined();
    expect(snapshot.parameterAuthorizationSettings.isAvailable).toBe(false);
  });

  it("⑦ 快照携带设置时与单独构造的视图一致（单一判定点）", () => {
    const settings = {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: false,
      configurationRevision: 7,
      ruleCount: 1,
    };
    const snapshot = buildGuiSnapshot({
      sessionId: "session-gui",
      mode: "assist",
      tracker: createGuiTaskTracker(),
      crossProject: { authorizations: [], copyReceipts: [] },
      parameterAuthorizationSettings: settings,
    });
    expect(snapshot.parameterAuthorizationSettings).toEqual(
      buildGuiParameterAuthorizationSettingsView(settings),
    );
  });
});
