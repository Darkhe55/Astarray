/**
 * S8：TUI 启动路径测试。
 * 用 mock 的 ink render 与 bootstrapCli 驱动 launchTui 的完整渲染/退出路径，
 * 避免 PTY 依赖；真实键盘交互由 PTY/人工验证。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderedCalls: Array<{ tree: unknown }> = [];
const unmountMock = vi.fn();
const clearMock = vi.fn();
const shutdownMock = vi.fn(async () => {});

vi.mock("ink", () => ({
  render: (tree: unknown) => {
    renderedCalls.push({ tree });
    return {
      waitUntilExit: async () => {},
      unmount: unmountMock,
      clear: clearMock,
    };
  },
}));

vi.mock("../../../packages/tui/src/cli/bootstrap.js", () => ({
  bootstrapCli: async () => ({
    controller: {},
    missionManager: {},
    taskStore: {},
    supervisor: null,
    feedbackClient: null,
    shutdown: shutdownMock,
  }),
}));

describe("launchTui 渲染路径", () => {
  beforeEach(() => {
    renderedCalls.length = 0;
    unmountMock.mockClear();
    clearMock.mockClear();
    shutdownMock.mockClear();
    // 确保非 TTY 守卫通过：launchTui 在 isTTY 时进入渲染
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("TTY 环境进入 render 并渲染 AstarrayApp", async () => {
    const { launchTui } = await import("../../../packages/tui/src/cli/tui.js");
    await launchTui("C:/tmp/astarray-state");
    expect(renderedCalls).toHaveLength(1);
  });

  it("SIGINT 触发优雅关闭（unmount + shutdown + clear）", async () => {
    const { launchTui } = await import("../../../packages/tui/src/cli/tui.js");
    // 先安装信号监听捕获，再启动 launchTui
    const signalListeners = new Set<(signal: string) => void>();
    const originalOn = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation(
      (event: string, listener: (signal: string) => void) => {
        if (event === "SIGINT") {
          signalListeners.add(listener);
        }
        return originalOn(event, listener as never);
      },
    );
    const launchPromise = launchTui("C:/tmp/astarray-state");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 记录 process.exit 调用而不真实退出（不抛错，避免未处理拒绝）
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // 记录退出码；不终止测试进程
    }) as never);
    for (const listener of signalListeners) {
      listener("SIGINT");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unmountMock).toHaveBeenCalled();
    expect(shutdownMock).toHaveBeenCalled();
    expect(clearMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.restoreAllMocks();
    void launchPromise;
  });
});
