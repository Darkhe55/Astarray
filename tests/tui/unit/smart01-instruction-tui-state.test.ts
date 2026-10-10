/**
 * SMART-01-04 反例（2026-10-10）：指令窗口的 **TUI 入口**必须能展示窗口状态，
 * 且**不得把"已派发"渲染成"工作成果完成"**。
 *
 * 卡内检查点明确："UI 状态不冒充成果完成"，且 §3 要求 UI **必须区分"已派发"与"工作成果完成"**。
 * 本文件钉住 TUI 状态层最窄闭环：
 *  - `AppState` 能持有指令窗口快照（窗口内 / 排队），并给出可渲染的逐条标签；
 *  - 处于"已派发/等待澄清/排队"的指令，其 `isWorkCompleted` 必须为 **false**；
 *  - 只有终态（completed / failed）才允许显示为"成果完成"，且排队与窗口内必须可分辨。
 *
 * 实现前：`AppState.setInstructionWindow` 等不存在 ⇒ 本文件必须失败。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "ink";

import { AppState } from "../../../packages/tui/src/ui/state/app-state.js";
import { InstructionWindowPanel } from "../../../packages/tui/src/ui/components/panels.js";

function renderPanelAtWidth(state: AppState, width: number): string {
  const originalColumns = process.stdout.columns;
  (process.stdout as unknown as { columns: number }).columns = width;
  try {
    return renderToString(createElement(InstructionWindowPanel, { window: state.getInstructionWindowView() }));
  } finally {
    (process.stdout as unknown as { columns: number | undefined }).columns = originalColumns;
  }
}

describe("SMART-01-04：TUI 指令窗口状态（不冒充成果完成）", () => {
  it("① 窗口内指令必须是「已派发」，不得显示为「成果完成」", () => {
    const state = new AppState();
    state.setInstructionWindow({
      windowCapacity: 3,
      activeInstructions: [
        {
          instructionIdentifier: "i-1",
          instructionText: "第一条",
          state: "dispatched",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
      queuedInstructions: [],
    });
    const view = state.getInstructionWindowView();
    expect(view.capacity).toBe(3);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.stateLabel).toBe("已派发");
    expect(view.rows[0]?.isWorkCompleted).toBe(false);
    expect(view.rows[0]?.isQueued).toBe(false);
  });

  it("② 排队指令必须与窗口内可分辨，且同样不得显示为「成果完成」", () => {
    const state = new AppState();
    state.setInstructionWindow({
      windowCapacity: 3,
      activeInstructions: [
        {
          instructionIdentifier: "i-1",
          instructionText: "窗口内",
          state: "dispatched",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
      queuedInstructions: [
        {
          instructionIdentifier: "i-4",
          instructionText: "排队中",
          state: "accepted",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
    });
    const view = state.getInstructionWindowView();
    expect(view.rows).toHaveLength(2);
    const queuedRow = view.rows.find((row) => row.instructionIdentifier === "i-4");
    expect(queuedRow?.isQueued).toBe(true);
    expect(queuedRow?.stateLabel).toBe("排队");
    expect(queuedRow?.isWorkCompleted).toBe(false);
    expect(view.queuedCount).toBe(1);
    expect(view.activeCount).toBe(1);
  });

  it("③ 等待澄清必须是「等待澄清」而非完成；终态才允许「成果完成」", () => {
    const state = new AppState();
    state.setInstructionWindow({
      windowCapacity: 3,
      activeInstructions: [
        {
          instructionIdentifier: "i-clarify",
          instructionText: "待澄清",
          state: "awaiting-clarification",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
        {
          instructionIdentifier: "i-done",
          instructionText: "已完成",
          state: "completed",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
      queuedInstructions: [],
    });
    const view = state.getInstructionWindowView();
    const clarifyRow = view.rows.find((row) => row.instructionIdentifier === "i-clarify");
    const doneRow = view.rows.find((row) => row.instructionIdentifier === "i-done");
    expect(clarifyRow?.stateLabel).toBe("等待澄清");
    expect(clarifyRow?.isWorkCompleted).toBe(false);
    expect(doneRow?.stateLabel).toBe("成果完成");
    expect(doneRow?.isWorkCompleted).toBe(true);
  });

  it("④ 清空窗口后不得残留旧行（避免展示过期状态）", () => {
    const state = new AppState();
    state.setInstructionWindow({
      windowCapacity: 3,
      activeInstructions: [
        {
          instructionIdentifier: "i-1",
          instructionText: "第一条",
          state: "dispatched",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
      queuedInstructions: [],
    });
    expect(state.getInstructionWindowView().rows).toHaveLength(1);
    state.clearInstructionWindow();
    expect(state.getInstructionWindowView().rows).toHaveLength(0);
    expect(state.getInstructionWindowView().capacity).toBe(0);
  });

  it("⑤ 面板渲染必须区分「已派发」与「成果完成」，并显示排队计数", () => {
    const state = new AppState();
    state.setInstructionWindow({
      windowCapacity: 3,
      activeInstructions: [
        {
          instructionIdentifier: "i-1",
          instructionText: "窗口内指令",
          state: "dispatched",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
        {
          instructionIdentifier: "i-2",
          instructionText: "已完成指令",
          state: "completed",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
      queuedInstructions: [
        {
          instructionIdentifier: "i-4",
          instructionText: "排队指令",
          state: "accepted",
          admittedAtIso: "2026-10-10T00:00:00.000Z",
        },
      ],
    });
    const rendered = renderPanelAtWidth(state, 120);
    expect(rendered).toContain("2/3");
    expect(rendered).toContain("已派发");
    expect(rendered).toContain("成果完成");
    expect(rendered).toContain("排队");
    expect(rendered).toContain("排队指令");
    // 已派发的一条不得被渲染成"成果完成"：按行核对，不做整串包含判断。
    const dispatchedLine = rendered
      .split("\n")
      .find((line) => line.includes("窗口内指令"));
    expect(dispatchedLine).toBeDefined();
    expect(dispatchedLine).toContain("已派发");
    expect(dispatchedLine).not.toContain("成果完成");
  });
});
