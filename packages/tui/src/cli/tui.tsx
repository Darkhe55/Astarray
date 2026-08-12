/**
 * TUI 启动（T10）。
 * TTY 环境进入全屏 TUI；非 TTY 返回明确错误（headless 走 --json 命令）。
 */
import { render } from "ink";

import { bootstrapCli } from "./bootstrap.js";
import { AppState } from "../ui/state/app-state.js";
import { AstarrayApp } from "../ui/app.js";
import { ThrottledTextCollector } from "../ui/hooks/throttled-text.js";
import { stripAnsiControlSequences } from "../../../core/src/infra/ansi-sanitizer.js";

export async function launchTui(stateDirectory: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "astarray: 非 TTY 环境无法启动 TUI，请使用 headless 命令（如 astarray run \"...\" --json）。\n",
    );
    process.exit(1);
  }

  const state = new AppState();
  const streamThrottle = new ThrottledTextCollector((text) => {
    state.pushConversation("main", stripAnsiControlSequences(text));
  });

  const bootstrap = await bootstrapCli({
    mode: state.mode,
    stateDirectory,
    concurrency: 4,
    failureThreshold: 3,
    maxLoopIterations: 8,
    useFeedbackProcess: true,
    streamOutput: (_missionId, text) => {
      streamThrottle.append(text);
    },
  });

  let isExiting = false;
  const { waitUntilExit, unmount, clear } = render(
    <AstarrayApp
      state={state}
      controller={bootstrap.controller}
      onRequestExit={() => {
        if (isExiting) {
          return;
        }
        isExiting = true;
        streamThrottle.dispose();
        unmount();
        void bootstrap.shutdown().then(() => {
          clear();
          process.exit(0);
        });
      }}
    />,
  );

  const shutdownOnSignal = async (): Promise<void> => {
    if (isExiting) {
      return;
    }
    isExiting = true;
    streamThrottle.dispose();
    unmount();
    await bootstrap.shutdown();
    clear();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdownOnSignal();
  });
  process.once("SIGTERM", () => {
    void shutdownOnSignal();
  });

  await waitUntilExit();
}
