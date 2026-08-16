#!/usr/bin/env node
import { Command } from "commander";

import packageMetadata from "../../../package.json" with { type: "json" };
import { defaultStateDirectory } from "./cli/run-command.js";
import { executeRunCommand } from "./cli/run-command.js";
import {
  executeCancelCommand,
  executeConfigInitCommand,
  executeConfigInstallEnabledCommand,
  executeDoctorCommand,
  executeResumeCommand,
  executeStatusCommand,
} from "./cli/commands.js";

const program = new Command();

program
  .name("astarray")
  .description("TUI agent orchestration tool with Ponder / Assist / Devolve modes")
  .version(packageMetadata.version, "-v, --version")
  .action(async () => {
    const { launchTui } = await import("./cli/tui.js");
    await launchTui(defaultStateDirectory());
  });

program
  .command("run <prompt>")
  .description("运行一个任务")
  .option("--mode <mode>", "运行模式: ponder | assist | devolve")
  .option("--runtime <runtime>", "运行时: mock | openai-compatible")
  .option("--json", "输出机器可解析 JSON")
  .action(async (prompt: string, options: { mode?: string; runtime?: string; json?: boolean }) => {
    process.exitCode = await executeRunCommand({
      prompt,
      mode: options.mode,
      runtime: options.runtime,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

program
  .command("resume <mission-id>")
  .description("恢复一个任务")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeResumeCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

program
  .command("status [mission-id]")
  .description("查询任务状态")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string | undefined, options: { json?: boolean }) => {
    process.exitCode = await executeStatusCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

program
  .command("cancel <mission-id>")
  .description("取消一个任务")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeCancelCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

const configCommand = program.command("config").description("配置管理");
configCommand
  .command("init")
  .description("初始化配置")
  .action(async () => {
    process.exitCode = await executeConfigInitCommand({
      stateDirectory: defaultStateDirectory(),
    });
  });
configCommand
  .command("install-enabled")
  .description("设置 Assist 安装独立开关（true/false；开启不等于授权）")
  .argument("<enabled>", "true 或 false")
  .action(async (enabled: string) => {
    if (enabled.toLowerCase() !== "true" && enabled.toLowerCase() !== "false") {
      process.stderr.write("install-enabled 参数必须为 true 或 false\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeConfigInstallEnabledCommand({
      stateDirectory: defaultStateDirectory(),
      isEnabled: enabled.toLowerCase() === "true",
    });
  });

program
  .command("doctor")
  .description("诊断环境")
  .option("--json", "输出机器可解析 JSON")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeDoctorCommand({
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

await program.parseAsync(process.argv);
