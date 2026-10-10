/**
 * NODECTX-01-03 反例（2026-10-10）：四态展示与"不把'不在上下文'显示成删除"。
 *
 * 卡内检查点 03 明文：
 *  "展示 **active / 暂存 / 永久关闭 / 待追认**及**暂存原因**，
 *   **不把"不在上下文"显示成删除**"；
 *  §2.1/§2.2：永久关闭**不代表物理删除**、可显式回访；待追认节点**仍带不确定标记**。
 *
 * 现状缺口：02 已实现状态机，但**没有任何展示层**（TUI/GUI 都取不到），
 * 且"不在上下文 ≠ 删除"这条**界面纪律**没有任何可执行断言。
 *
 * 本片钉住的语义：
 *  - 四种展示态必须齐备且**与内部状态一一对应**；
 *  - "不在上下文"的文案**绝不得**出现"删除/移除/丢弃"等字样，
 *    并须**明确**说明原文仍在、可回访；
 *  - **暂存原因**必须随视图给出（用户要知道为什么它不在上下文里）；
 *  - **待追认**必须带不确定标记，且不得显示为已完成（核验否决会阻断后继）；
 *  - 业务完成与否**只由业务状态决定**（不得因为有可见性标签就宣称 done）。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  CONTEXT_VISIBILITY_DISPLAY_STATES,
  buildContextVisibilityDisplayRows,
} from "../../../packages/core/src/toolkit/context-visibility-view.js";

function buildRowInput(overrides: Record<string, unknown> = {}) {
  return {
    nodeIdentifier: "node-1",
    visibilityState: "active" as const,
    businessStatus: "pending" as const,
    stagingReason: null,
    isPendingRatification: false,
    ...overrides,
  };
}

describe("NODECTX-01-03：四态展示", () => {
  it("① 四种展示态必须齐备", () => {
    expect([...CONTEXT_VISIBILITY_DISPLAY_STATES]).toEqual([
      "active",
      "staged",
      "permanently-closed",
      "pending-ratification",
    ]);
  });

  it("② 四种展示态与内部状态一一对应，且都给出人工可读标签", () => {
    const rows = buildContextVisibilityDisplayRows([
      buildRowInput({ nodeIdentifier: "n-active", visibilityState: "active" }),
      buildRowInput({ nodeIdentifier: "n-staged", visibilityState: "temporarily-closed" }),
      buildRowInput({
        nodeIdentifier: "n-closed",
        visibilityState: "permanently-closed",
      }),
      buildRowInput({
        nodeIdentifier: "n-pending",
        visibilityState: "temporarily-closed",
        isPendingRatification: true,
      }),
    ]);
    expect(rows.map((row) => row.displayState)).toEqual([
      "active",
      "staged",
      "permanently-closed",
      "pending-ratification",
    ]);
    for (const row of rows) {
      expect(row.displayStateLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("NODECTX-01-03：不把「不在上下文」显示成删除", () => {
  it("③ 暂存/永久关闭的文案**不得**出现删除类字样，且须说明原文仍在可回访", () => {
    const forbiddenWords = ["删除", "已移除", "丢弃", "清除", "销毁"];
    const rows = buildContextVisibilityDisplayRows([
      buildRowInput({ nodeIdentifier: "n-staged", visibilityState: "temporarily-closed" }),
      buildRowInput({
        nodeIdentifier: "n-closed",
        visibilityState: "permanently-closed",
      }),
    ]);
    for (const row of rows) {
      for (const word of forbiddenWords) {
        expect(
          row.displayText.includes(word),
          "文案不得包含「" + word + "」: " + row.displayText,
        ).toBe(false);
      }
      // 必须明确"原文仍在 + 可回访"
      expect(row.displayText).toMatch(/原文|存档/);
      expect(row.isContentRetainedOnDisk).toBe(true);
      expect(row.isExplicitRecallAllowed).toBe(true);
      expect(row.isShownAsDeleted).toBe(false);
    }
  });

  it("④ 暂存原因必须随视图给出（缺原因即 fail-closed 标注）", () => {
    const withReason = buildContextVisibilityDisplayRows([
      buildRowInput({
        nodeIdentifier: "n-staged",
        visibilityState: "temporarily-closed",
        stagingReason: "当前不需要且非紧急，待窗口释放后自动补回",
      }),
    ]);
    expect(withReason[0]?.stagingReason).toContain("待窗口释放");

    const withoutReason = buildContextVisibilityDisplayRows([
      buildRowInput({ nodeIdentifier: "n-staged", visibilityState: "temporarily-closed" }),
    ]);
    // 没有原因时不得留白：必须显式标注"原因未记录"
    expect(String(withoutReason[0]?.stagingReason)).toMatch(/未记录|原因缺失/);
  });
});

describe("NODECTX-01-03：待追认必须带不确定标记", () => {
  it("⑤ 待追认必须显式标注不确定，且**不得**显示为已完成", () => {
    const rows = buildContextVisibilityDisplayRows([
      buildRowInput({
        nodeIdentifier: "n-pending",
        visibilityState: "temporarily-closed",
        businessStatus: "completed",
        isPendingRatification: true,
      }),
    ]);
    const row = rows[0];
    expect(row?.isPendingRatification).toBe(true);
    expect(row?.displayText).toMatch(/待追认|不确定/);
    // 即便业务状态是 completed，待追认也**不得**呈现为"已完成成果"
    expect(row?.isShownAsCompleted).toBe(false);
  });
});

describe("NODECTX-01-03：业务完成只由业务状态决定", () => {
  it("⑥ 可见性标签不得让节点被当作完成", () => {
    const rows = buildContextVisibilityDisplayRows([
      buildRowInput({ nodeIdentifier: "n1", visibilityState: "active", businessStatus: "pending" }),
      buildRowInput({
        nodeIdentifier: "n2",
        visibilityState: "permanently-closed",
        businessStatus: "pending",
      }),
      buildRowInput({
        nodeIdentifier: "n3",
        visibilityState: "active",
        businessStatus: "completed",
      }),
    ]);
    expect(rows[0]?.isBusinessCompleted).toBe(false);
    expect(rows[1]?.isBusinessCompleted).toBe(false);
    expect(rows[2]?.isBusinessCompleted).toBe(true);
    // 只有业务完成的才可显示为完成
    expect(rows[0]?.isShownAsCompleted).toBe(false);
    expect(rows[2]?.isShownAsCompleted).toBe(true);
  });

  it("⑦ 空输入 ⇒ 空视图（不伪造行）", () => {
    expect(buildContextVisibilityDisplayRows([])).toEqual([]);
  });
});
