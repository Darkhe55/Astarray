/**
 * T10 TUI 组件测试（ink-testing-library + ink renderToString）。
 * 覆盖：多尺寸渲染、DAG/流式/Agent 状态更新、权限弹窗、帮助、无颜色、CJK/emoji、超长内容、ANSI 清洗。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { renderToString } from "ink";

import type { AgentMode } from "../../../packages/core/src/core/types.js";
import { AppState } from "../../../packages/tui/src/ui/state/app-state.js";
import { cyclePanel } from "../../../packages/tui/src/ui/panel-navigation.js";
import { AstarrayApp } from "../../../packages/tui/src/ui/app.js";

const NOOP_CONTROLLER = {
  getActiveMissionIds: () => [],
  queryMissionStatus: async () => {
    throw new Error("无控制器");
  },
  getMetricsSnapshot: () => null,
  handleUserMessage: async () => "ponder",
  cancelMission: async () => {},
  sendSchedulerInstruction: () => {},
  grantSessionAuthorization: async () => {},
  transitionMode: (_mode: AgentMode) => {},
} as never;

function makeState(): AppState {
  return new AppState();
}

function renderAppElement(state: AppState) {
  return createElement(AstarrayApp, {
    state,
    controller: NOOP_CONTROLLER,
    onRequestExit: () => {},
  });
}

/** 指定终端尺寸渲染完整输出（ink renderToString 读取 process.stdout.columns/rows）。 */
function renderAtTerminalSize(
  state: AppState,
  width: number,
  height: number,
): string {
  return withTerminalSize(state, width, height, () =>
    renderToString(renderAppElement(state)),
  );
}

/** 大画布渲染（避免 rows 限制截断底部弹窗）。 */
function renderToStringFull(state: AppState): string {
  return withTerminalSize(state, 120, 60, () =>
    renderToString(renderAppElement(state)),
  );
}

function withTerminalSize<T>(
  _state: AppState,
  width: number,
  height: number,
  renderFn: () => T,
): T {
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "columns", { value: width, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: height, configurable: true });
  try {
    return renderFn();
  } finally {
    if (columnsDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    }
    if (rowsDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "rows", rowsDescriptor);
    }
  }
}

afterEach(() => {
  cleanup();
});

describe("TUI 组件渲染", () => {
  it("80×24：头部包含模式/任务/指标信息", async () => {
    const state = makeState();
    const instance = render(renderAppElement(state));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Astarray");
    expect(frame).toContain("mode: assist");
    expect(frame).toContain("Tasks / DAG");
    expect(frame).toContain("Conversation & Events");
    expect(frame).toContain("Agents / Mailboxes");
    expect(frame).toContain("Input:");
    instance.unmount();
  });

  it("120×40 与低于最小尺寸（60×20）均正常渲染", () => {
    expect(renderAtTerminalSize(makeState(), 120, 40)).toContain("Astarray");
    const smallFrame = renderAtTerminalSize(makeState(), 60, 20);
    expect(smallFrame).toContain("Astarray");
    expect(smallFrame).toContain("Tasks / DAG");
  });

  it("DAG 更新：任务状态变化反映到面板", async () => {
    const state = makeState();
    const instance = render(renderAppElement(state));
    await new Promise((resolve) => setTimeout(resolve, 30));
    state.upsertMission({
      missionId: "mission-1",
      mode: "assist",
      status: "running",
      prompt: "测试任务",
      tasks: [
        {
          id: "T-001",
          description: "任务一",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          assignedAgentId: "worker-1",
          status: "running",
          resultLocation: null,
        },
      ],
    });
    state.setAgentStatus("worker-1", "busy");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("mission-1");
    expect(frame).toContain("T-001");
    expect(frame).toContain("worker-1 busy");
    instance.unmount();
  });

  it("流式内容出现于会话面板（CJK + emoji）", async () => {
    const state = makeState();
    const instance = render(renderAppElement(state));
    await new Promise((resolve) => setTimeout(resolve, 30));
    state.pushConversation("user", "分析这个项目 🚀");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("分析这个项目 🚀");
    instance.unmount();
  });

  it("超长内容不崩溃（truncate）", () => {
    const state = makeState();
    state.pushConversation("tool", "x".repeat(20_000));
    state.upsertMission({
      missionId: "mission-long",
      mode: "assist",
      status: "running",
      prompt: "y".repeat(5_000),
      tasks: [],
    });
    const frame = renderToStringFull(state);
    expect(frame).toContain("mission-long");
    expect(frame).toContain("Tasks / DAG");
  });

  it("权限弹窗渲染工具名与说明（renderToString 确定性）", async () => {
    const state = makeState();
    state.openPermissionAsk({
      missionId: "mission-1",
      taskId: "T-001",
      toolName: "writeFileTemporary",
      argumentsJson: '{"fileName":"a.txt"}',
      explanation: "需要写入临时文件",
    });
    const frame = renderToStringFull(state);
    expect(frame).toContain("writeFileTemporary");
    expect(frame).toContain("[Esc]");
    state.closePermissionAsk();
    const closedFrame = renderToStringFull(state);
    expect(closedFrame).not.toContain("writeFileTemporary");
  });

  it("帮助弹窗切换（renderToString 确定性）", () => {
    const state = makeState();
    expect(renderToStringFull(state)).not.toContain("1/2/3/4/Esc:");
    state.toggleHelp();
    expect(renderToStringFull(state)).toContain("1/2/3/4/Esc:");
    state.toggleHelp();
    expect(renderToStringFull(state)).not.toContain("1/2/3/4/Esc:");
  });

  it("NO_COLOR=1 时输出不含 ANSI 颜色序列", () => {
    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const frame = renderToStringFull(makeState());
      expect(frame).not.toContain(String.fromCharCode(27) + "[");
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("ANSI 注入内容被清洗后渲染", () => {
    const state = makeState();
    state.pushConversation(
      "tool",
      "\u001B]8;;http://evil.example\u0007伪装\u001B]8;;\u0007",
    );
    const frame = renderToStringFull(state);
    expect(frame).not.toContain("evil.example");
  });
});

describe("panel-navigation", () => {
  it("Tab 循环焦点：input → dag → agents → conversation → input", () => {
    expect(cyclePanel("input")).toBe("dag");
    expect(cyclePanel("dag")).toBe("agents");
    expect(cyclePanel("agents")).toBe("conversation");
    expect(cyclePanel("conversation")).toBe("input");
  });
});
