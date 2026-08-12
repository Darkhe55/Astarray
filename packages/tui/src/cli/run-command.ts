/**
 * run 命令（T11）。
 * 流程：解析配置 → 引导 → 创建 mission → 轮询至终态 → 输出 JSON。
 */
import path from "node:path";

import { bootstrapCli } from "./bootstrap.js";
import { EXIT_CODES, failWith, logToStderr, printJson } from "./json-output.js";
import { runConfigSchema } from "../../../core/src/core/schemas.js";

export interface RunCommandOptions {
  prompt: string;
  mode: string | undefined;
  runtime: string | undefined;
  isJsonOutput: boolean;
  stateDirectory: string;
}

export async function executeRunCommand(options: RunCommandOptions): Promise<number> {
  const parsedConfig = runConfigSchema.safeParse({
    mode: options.mode,
    runtime: options.runtime,
  });
  if (!parsedConfig.success) {
    failWith(
      new Error(`配置非法: ${parsedConfig.error.message}`),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const runConfig = parsedConfig.data;
  if (runConfig.runtime !== "mock") {
    failWith(
      new Error(`--runtime ${runConfig.runtime} 尚未支持（v0.1 仅 mock）`),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (!options.isJsonOutput) {
    failWith(
      new Error("headless run 必须使用 --json（或 TTY 下使用 TUI）"),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const bootstrap = await bootstrapCli({
    mode: runConfig.mode,
    stateDirectory: options.stateDirectory,
    concurrency: runConfig.concurrency,
    failureThreshold: runConfig.toolFailureThreshold,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    streamOutput: (_missionId, text) => {
      logToStderr(text);
    },
  });
  try {
    const missionId = await bootstrap.controller.handleUserMessage(options.prompt);
    const finalStatus = await waitForTerminalStatus(bootstrap, missionId);
    printJson({
      missionId,
      mode: runConfig.mode,
      status: finalStatus,
      prompt: options.prompt,
    });
    return finalStatus === "done" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  } finally {
    await bootstrap.shutdown();
  }
}

async function waitForTerminalStatus(
  bootstrap: Awaited<ReturnType<typeof bootstrapCli>>,
  missionId: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const missionStatus = await bootstrap.controller.queryMissionStatus(missionId);
    const summaryStatus = missionStatus.summary?.status ?? "running";
    if (summaryStatus === "done" || summaryStatus === "cancelled") {
      return summaryStatus;
    }
    const taskChain = missionStatus.taskChain;
    if (taskChain !== null) {
      const hasBlockedTask = taskChain.tasks.some(
        (task) => task.status === "blocked" || task.status === "failed",
      );
      if (hasBlockedTask) {
        return "blocked";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "running";
}

export function defaultStateDirectory(): string {
  return path.join(process.cwd(), ".astarray");
}
