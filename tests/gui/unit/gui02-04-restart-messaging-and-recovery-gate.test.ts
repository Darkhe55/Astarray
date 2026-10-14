/**
 * GUI-02-04（2026-11-08）：**重启后界面不误导** + **恢复须显式 + 先对账 + 重新鉴权** —— 反例先行。
 *
 * ## 卡内检查点原文
 *
 * > **GUI-02-04** | **重启与包级验收** —— 重启后界面不误导（明确"会话视图为空"≠数据丢失）；
 * > **恢复须显式 + 先对账 + 重新鉴权**；隔离 tarball 打开 GUI 复验
 *
 * ## 本轮钉住两件事
 *
 * ### ① 空会话视图**必须解释自己**（不能只是"什么都没有"）
 *
 * `/state` 的任务列表是**本会话视图**，进程重启后它**必然为空**。
 * 实测现状：`renderTasks` 对空数组**只清空列表、不写任何文字**
 * ⇒ 用户看到"任务栏空白"，极易理解为"数据丢了"。这是**界面误导**，卡内明确禁止。
 *
 * ### ② 恢复必须过**三道门**，且每道门都有可测的拒绝理由
 *
 * 核心层 `resumeMission()` 已自带若干前置（损坏/终态/可信检查点/对账），
 * 但**"显式"这一道**（用户主动确认，而不是点开就恢复）与**"重新鉴权"**需要在
 * 恢复入口处**明确表达并强制**。本文件用一个**纯函数闸门**把这三道门钉死，
 * 使 GUI 与核心层之间有一个可测的契约，而不是靠界面自觉。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiTaskListView,
  evaluateGuiRecoveryGate,
  GUI_SESSION_VIEW_EMPTY_EXPLANATION,
} from "../../../packages/gui/src/application/gui-read-model.js";

describe("GUI-02-04：重启后空会话视图**必须解释自己**（不得让用户以为数据丢了）", () => {
  it("① 空任务列表 ⇒ 必须给出明确说明，且说明里点出「不是数据丢失」", () => {
    const view = buildGuiTaskListView([]);

    expect(view.isEmpty).toBe(true);
    expect(view.emptyExplanation).toBe(GUI_SESSION_VIEW_EMPTY_EXPLANATION);
    // 关键：必须明确"这不代表数据丢失"，并指向可核对的地方
    expect(view.emptyExplanation).toContain("不代表数据丢失");
    expect(view.emptyExplanation).toContain("恢复中心");
  });

  it("② 非空列表 ⇒ 不得显示那句空态说明（避免噪音与误读）", () => {
    const view = buildGuiTaskListView([
      { taskIdentifier: "t1", status: "running", revision: 2 },
    ]);

    expect(view.isEmpty).toBe(false);
    expect(view.emptyExplanation).toBeNull();
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.rowText).toContain("t1");
    expect(view.rows[0]?.rowText).toContain("running");
  });

  it("③ 该说明是**稳定常量**（界面与测试引用同一份文案，避免两处漂移）", () => {
    expect(typeof GUI_SESSION_VIEW_EMPTY_EXPLANATION).toBe("string");
    expect(GUI_SESSION_VIEW_EMPTY_EXPLANATION.length).toBeGreaterThan(0);
  });
});

describe("GUI-02-04：恢复必须**显式 + 先对账 + 重新鉴权**（三道门）", () => {
  it("④ **未显式确认** ⇒ 拒绝恢复（「点开就恢复」是禁止的）", () => {
    const decision = evaluateGuiRecoveryGate({
      hasExplicitUserConfirmation: false,
      isReconciliationSatisfied: true,
      isReauthorizationSatisfied: true,
    });

    expect(decision.isAllowed).toBe(false);
    expect(decision.blockedGate).toBe("explicit-confirmation");
    expect(decision.reasonText).toContain("显式");
  });

  it("⑤ **对账未完成** ⇒ 拒绝恢复（且理由指向「先对账」）", () => {
    const decision = evaluateGuiRecoveryGate({
      hasExplicitUserConfirmation: true,
      isReconciliationSatisfied: false,
      isReauthorizationSatisfied: true,
    });

    expect(decision.isAllowed).toBe(false);
    expect(decision.blockedGate).toBe("reconciliation");
    expect(decision.reasonText).toContain("对账");
  });

  it("⑥ **未重新鉴权** ⇒ 拒绝恢复", () => {
    const decision = evaluateGuiRecoveryGate({
      hasExplicitUserConfirmation: true,
      isReconciliationSatisfied: true,
      isReauthorizationSatisfied: false,
    });

    expect(decision.isAllowed).toBe(false);
    expect(decision.blockedGate).toBe("reauthorization");
    expect(decision.reasonText).toContain("鉴权");
  });

  it("⑦ 三道门**全部满足**才允许恢复", () => {
    const decision = evaluateGuiRecoveryGate({
      hasExplicitUserConfirmation: true,
      isReconciliationSatisfied: true,
      isReauthorizationSatisfied: true,
    });

    expect(decision.isAllowed).toBe(true);
    expect(decision.blockedGate).toBeNull();
    expect(decision.reasonText).toBeNull();
  });

  it("⑧ 检查顺序是**确定**的：显式 → 对账 → 鉴权（多个未满足时先报第一道）", () => {
    const decision = evaluateGuiRecoveryGate({
      hasExplicitUserConfirmation: false,
      isReconciliationSatisfied: false,
      isReauthorizationSatisfied: false,
    });

    // 顺序固定 ⇒ 用户先看到"需要显式确认"，而不是一上来被两三个理由同时砸
    expect(decision.blockedGate).toBe("explicit-confirmation");
    expect(decision.allBlockedGates).toEqual([
      "explicit-confirmation",
      "reconciliation",
      "reauthorization",
    ]);
  });
});
