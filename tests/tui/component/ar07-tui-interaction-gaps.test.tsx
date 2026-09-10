/**
 * AR-07 批次 11：TUI 交互测试补齐。
 * 用 ink-testing-library 驱动真实 useInput 键盘路径，覆盖权限弹窗
 * allow-once / allow-session / deny / modify / Esc 五条决策分支
 * （此前仅有 renderToString 静态渲染断言）。
 */
import { createElement } from "react";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";

import { AppState } from "../../../packages/tui/src/ui/state/app-state.js";
import { AstarrayApp } from "../../../packages/tui/src/ui/app.js";

function makeController() {
  return {
    getActiveMissionIds: () => [],
    queryMissionStatus: async () => {
      throw new Error("无可用任务");
    },
    getMetricsSnapshot: () => null,
    handleUserMessage: async () => "ponder",
    cancelMission: async () => {},
    sendSchedulerInstruction: vi.fn(),
    grantSessionAuthorization: vi.fn(async () => {}),
    transitionMode: vi.fn(),
    getCurrentPermissionProfileReference: async () => null,
    listPermissionProfiles: async () => ({ profiles: [], total: 0, page: 1, pageSize: 20 }),
    switchPermissionProfile: async () => {},
  };
}

function openPermissionAsk(state: AppState): void {
  state.openPermissionAsk({
    missionId: "mission-1",
    taskId: "T-001",
    toolName: "writeFileTemporary",
    argumentsJson: '{"fileName":"a.txt"}',
    explanation: "需要写入临时文件",
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function setup() {
  const state = new AppState();
  const controller = makeController();
  openPermissionAsk(state);
  const instance = render(
    createElement(AstarrayApp, {
      state,
      controller: controller as never,
      onRequestExit: () => {},
    }),
  );
  return { state, controller, instance };
}

afterEach(() => {
  cleanup();
});

describe("AR-07 批次11：TUI 权限弹窗交互", () => {
  it("初始渲染展示工具名与参数", async () => {
    const { instance } = setup();
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("writeFileTemporary");
    expect(frame).toContain("[Esc]");
  });

  it("按 1（allow-once）：授权 + 解除阻塞 + 关闭弹窗", async () => {
    const { state, controller, instance } = setup();
    await flush();
    instance.stdin.write("1");
    await flush();
    expect(state.permissionAsk).toBeNull();
    expect(controller.grantSessionAuthorization).toHaveBeenCalledWith(
      "writeFileTemporary",
      '{"fileName":"a.txt"}',
      expect.any(Number),
    );
    expect(controller.sendSchedulerInstruction).toHaveBeenCalledWith(
      "mission-1",
      JSON.stringify({ action: "unblock", taskId: "T-001" }),
    );
    expect((instance.lastFrame() ?? "").includes("已授权调用 writeFileTemporary")).toBe(true);
  });

  it("按 2（allow-session）：同样授权并解除阻塞", async () => {
    const { state, controller, instance } = setup();
    await flush();
    instance.stdin.write("2");
    await flush();
    expect(state.permissionAsk).toBeNull();
    expect(controller.grantSessionAuthorization).toHaveBeenCalledTimes(1);
    expect(controller.sendSchedulerInstruction).toHaveBeenCalledTimes(1);
  });

  it("按 3（deny）：不授权、不解除阻塞、记录拒绝", async () => {
    const { state, controller, instance } = setup();
    await flush();
    instance.stdin.write("3");
    await flush();
    expect(state.permissionAsk).toBeNull();
    expect(controller.grantSessionAuthorization).not.toHaveBeenCalled();
    expect(controller.sendSchedulerInstruction).not.toHaveBeenCalled();
    expect(state.conversation.at(-1)?.text).toContain("已拒绝权限调用 writeFileTemporary");
  });

  it("按 4（modify）：授权并显示已修改参数", async () => {
    const { state, controller, instance } = setup();
    await flush();
    instance.stdin.write("4");
    await flush();
    expect(state.permissionAsk).toBeNull();
    expect(controller.grantSessionAuthorization).toHaveBeenCalledTimes(1);
    expect(state.conversation.at(-1)?.text).toContain(
      "已修改参数并授权调用 writeFileTemporary",
    );
  });

  it("Esc：只关闭弹窗，不产生授权或调度副作用", async () => {
    const { state, controller, instance } = setup();
    await flush();
    instance.stdin.write("\u001B");
    await flush();
    expect(state.permissionAsk).toBeNull();
    expect(controller.grantSessionAuthorization).not.toHaveBeenCalled();
    expect(controller.sendSchedulerInstruction).not.toHaveBeenCalled();
  });
});
