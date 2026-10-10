/**
 * SMART-01-04 反例（2026-10-10）：指令窗口必须进入 **GUI 只读快照**，且不得冒充成果完成。
 *
 * 卡内检查点要求"SDK/CLI/TUI/GUI 入口"；GUI 只读视图此前**完全不含**指令窗口，
 * 因此 GUI 侧看不到"第 4 条排队 / 超期 / 等待澄清"，也无法区分"已派发"与"工作成果完成"。
 *
 * 本文件钉住 GUI 读模型最窄闭环：
 *  - `buildGuiSnapshot` 输出 `instructions`（容量、计数、逐条标签与 `isWorkCompleted`）；
 *  - `dispatched`（已派发）与排队**不得**为成果完成；只有 `completed` 才为 true；
 *  - 快照仍是**脱敏只读 JSON**：不含凭据、不含内部绝对路径。
 *
 * 实现前：`instructions` 不存在 ⇒ 本文件必须失败。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiSnapshot,
  createGuiTaskTracker,
} from "../../../packages/gui/src/application/gui-read-model.js";

function snapshotWithInstructions() {
  return buildGuiSnapshot({
    sessionId: "gui-session",
    mode: "assist",
    tracker: createGuiTaskTracker(),
    instructionWindow: {
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
        {
          instructionIdentifier: "i-3",
          instructionText: "待澄清指令",
          state: "awaiting-clarification",
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
    },
  });
}

describe("SMART-01-04：GUI 只读快照中的指令窗口", () => {
  it("① 快照必须携带指令窗口容量与计数（窗口内 / 排队）", () => {
    const snapshot = snapshotWithInstructions();
    expect(snapshot.instructions.capacity).toBe(3);
    expect(snapshot.instructions.activeCount).toBe(3);
    expect(snapshot.instructions.queuedCount).toBe(1);
    expect(snapshot.instructions.rows).toHaveLength(4);
  });

  it("② 已派发 / 等待澄清 / 排队一律不得为「成果完成」；只有 completed 为 true", () => {
    const rows = snapshotWithInstructions().instructions.rows;
    const byIdentifier = new Map(rows.map((row) => [row.instructionIdentifier, row]));
    expect(byIdentifier.get("i-1")?.stateLabel).toBe("已派发");
    expect(byIdentifier.get("i-1")?.isWorkCompleted).toBe(false);
    expect(byIdentifier.get("i-3")?.stateLabel).toBe("等待澄清");
    expect(byIdentifier.get("i-3")?.isWorkCompleted).toBe(false);
    expect(byIdentifier.get("i-4")?.stateLabel).toBe("排队");
    expect(byIdentifier.get("i-4")?.isWorkCompleted).toBe(false);
    expect(byIdentifier.get("i-4")?.isQueued).toBe(true);
    expect(byIdentifier.get("i-2")?.stateLabel).toBe("成果完成");
    expect(byIdentifier.get("i-2")?.isWorkCompleted).toBe(true);
  });

  it("③ 未提供指令窗口时快照仍可用（向后兼容，不伪造指令）", () => {
    const snapshot = buildGuiSnapshot({
      sessionId: "gui-session",
      mode: "assist",
      tracker: createGuiTaskTracker(),
    });
    expect(snapshot.sessionId).toBe("gui-session");
    expect(snapshot.instructions.rows).toHaveLength(0);
    expect(snapshot.instructions.capacity).toBe(0);
  });

  it("④ 快照保持脱敏：序列化后不得含凭据或内部绝对路径", () => {
    const serialized = JSON.stringify(snapshotWithInstructions());
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain(".env");
  });
});
