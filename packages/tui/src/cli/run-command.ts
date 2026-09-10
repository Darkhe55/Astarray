/**
 * run 命令（T11 / T07D-R1-04）。
 * 通过公共应用服务（AstarrayApplicationFacade）提交与查询任务，
 * 与 SDK 消费者使用同一入口、同一状态源（不再直接调用内部控制器）。
 */
import path from "node:path";

import { AstarrayApplicationFacade } from "../../../core/src/public-sdk.js";
import { runConfigSchema } from "../../../core/src/core/schemas.js";
import { EXIT_CODES, failWith, logToStderr, printJson } from "./json-output.js";

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
      new Error("配置非法: " + parsedConfig.error.message),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  const runConfig = parsedConfig.data;
  if (runConfig.runtime !== "mock") {
    failWith(
      new Error("--runtime " + runConfig.runtime + " 尚未支持（v0.1 仅 mock）"),
      EXIT_CODES.USAGE_ERROR,
    );
  }
  if (!options.isJsonOutput) {
    failWith(
      new Error("headless run 必须使用 --json（或 TTY 下使用 TUI）"),
      EXIT_CODES.USAGE_ERROR,
    );
  }

  const application = await AstarrayApplicationFacade.create({
    stateDirectory: options.stateDirectory,
    mode: runConfig.mode,
    runtime: "mock",
    concurrency: runConfig.concurrency,
    failureThreshold: runConfig.toolFailureThreshold,
    maximumLoopIterations: 8,
    statusPollIntervalMilliseconds: 25,
    streamOutput: (_missionIdentifier, text) => {
      logToStderr(text);
    },
  });
  try {
    application.createSession({ sessionId: "cli-run", mode: runConfig.mode });
    const accepted = await application.submitTask({
      sessionId: "cli-run",
      taskIdentifier: "cli-task",
      prompt: options.prompt,
    });
    const finalStatus = await waitForTerminalStatus(
      application,
      "cli-run",
      "cli-task",
    );
    printJson({
      missionId: accepted.missionIdentifier,
      mode: runConfig.mode,
      status: finalStatus,
      prompt: options.prompt,
    });
    return finalStatus === "done" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  } finally {
    await application.shutdown();
  }
}

async function waitForTerminalStatus(
  application: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await application.queryTask({ sessionId, taskIdentifier });
    if (result.status === "done" || result.status === "cancelled") {
      return result.status;
    }
    if (result.status === "blocked" || result.status === "failed") {
      return "blocked";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "running";
}

export function defaultStateDirectory(): string {
  return path.join(process.cwd(), ".astarray");
}
