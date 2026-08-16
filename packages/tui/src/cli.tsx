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
  executeProfileCopyCommand,
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileImportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileSetCapabilityCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
  executeResumeCommand,
  executeSessionElevateCommand,
  executeSessionElevationListCommand,
  executeSessionRevokeElevationCommand,
  executeSessionShutdownCommand,
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

// B6R-04：认证用户设置控制面——权限组生命周期
const profileCommand = program.command("profile").description("权限组管理（认证设置控制面）");
profileCommand
  .command("list")
  .description("列出全部权限组（分页；无产品数量上限）")
  .option("--json", "JSON 输出")
  .option("--page <n>", "页码", "1")
  .option("--page-size <n>", "每页数量", "50")
  .action(async (options: { json?: boolean; page?: string; pageSize?: string }) => {
    process.exitCode = await executeProfileListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
      page: Number.parseInt(options.page ?? "1", 10),
      pageSize: Number.parseInt(options.pageSize ?? "50", 10),
    });
  });
profileCommand
  .command("create")
  .description("创建自定义权限组（来源 blank/assist/devolve/ponder/custom:<id>）")
  .argument("<name>", "显示名称")
  .option("--from <source>", "创建来源", "blank")
  .action(async (name: string, options: { from?: string }) => {
    process.exitCode = await executeProfileCreateCommand({
      stateDirectory: defaultStateDirectory(),
      displayName: name,
      source: options.from ?? "blank",
    });
  });
profileCommand
  .command("rename")
  .description("重命名自定义权限组（ID 不变）")
  .argument("<profileId>", "权限组 ID")
  .argument("<newName>", "新名称")
  .action(async (profileId: string, newName: string) => {
    process.exitCode = await executeProfileRenameCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      newDisplayName: newName,
    });
  });
profileCommand
  .command("copy")
  .description("复制自定义权限组")
  .argument("<profileId>", "权限组 ID")
  .argument("<newName>", "新名称")
  .action(async (profileId: string, newName: string) => {
    process.exitCode = await executeProfileCopyCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      newDisplayName: newName,
    });
  });
profileCommand
  .command("reset")
  .description("重置为来源（blank/assist/devolve/ponder/custom:<id>）")
  .argument("<profileId>", "权限组 ID")
  .option("--to <source>", "重置来源", "blank")
  .action(async (profileId: string, options: { to?: string }) => {
    process.exitCode = await executeProfileResetCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      source: options.to ?? "blank",
    });
  });
profileCommand
  .command("set-capability")
  .description("逐项三态设置（allow/ask/deny）")
  .argument("<profileId>", "权限组 ID")
  .argument("<capabilityId>", "权限 ID")
  .argument("<decision>", "allow|ask|deny")
  .action(async (profileId: string, capabilityId: string, decision: string) => {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      process.stderr.write("decision 必须为 allow|ask|deny\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeProfileSetCapabilityCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      capabilityId,
      decision,
    });
  });
profileCommand
  .command("export")
  .description("导出公开可配置字段（剥离内部字段；覆盖前自动备份）")
  .argument("<reference>", "builtin 或 profile ID")
  .option("--out <path>", "输出文件")
  .action(async (reference: string, options: { out?: string }) => {
    process.exitCode = await executeProfileExportCommand({
      stateDirectory: defaultStateDirectory(),
      reference,
      outputPath: options.out ?? null,
    });
  });
profileCommand
  .command("import")
  .description("导入公开配置（只接受可配置目录字段）")
  .argument("<file>", "JSON 文件")
  .action(async (file: string) => {
    process.exitCode = await executeProfileImportCommand({
      stateDirectory: defaultStateDirectory(),
      inputPath: file,
    });
  });
profileCommand
  .command("delete")
  .description("删除自定义权限组（当前使用组必须先切换）")
  .argument("<profileId>", "权限组 ID")
  .action(async (profileId: string) => {
    process.exitCode = await executeProfileDeleteCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
    });
  });
profileCommand
  .command("switch")
  .description("认证用户选择当前权限组（持久化；写入自动备份）")
  .argument("<reference>", "builtin 或 profile ID")
  .action(async (reference: string) => {
    process.exitCode = await executeProfileSwitchCommand({
      stateDirectory: defaultStateDirectory(),
      reference,
    });
  });
profileCommand
  .command("show")
  .description("显示当前/指定权限组公开详情")
  .argument("[reference]", "builtin 或 profile ID（缺省为当前选择）")
  .option("--json", "JSON 输出")
  .action(async (reference: string | undefined, options: { json?: boolean }) => {
    process.exitCode = await executeProfileShowCommand({
      stateDirectory: defaultStateDirectory(),
      reference: reference ?? null,
      isJsonOutput: options.json === true,
    });
  });

// B6R-06：会话提升控制面（认证设置控制面；不提供"提升主 Agent"）
const sessionCommand = program.command("session").description("会话提升与关闭导出（认证设置控制面）");
sessionCommand
  .command("elevation-list")
  .description("查看会话级/个体级临时提升")
  .argument("<sessionId>", "会话 ID")
  .option("--json", "JSON 输出")
  .action(async (sessionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeSessionElevationListCommand({
      stateDirectory: defaultStateDirectory(),
      sessionId,
      isJsonOutput: options.json === true,
    });
  });
sessionCommand
  .command("elevate")
  .description("认证用户创建会话/个体提升（不提供提升主 Agent）")
  .argument("<sessionId>", "会话 ID")
  .argument("<capabilityId>", "权限 ID")
  .argument("<decision>", "allow|ask（提升方向必须更宽）")
  .option("--agent <agentInstanceId>", "具体次级 Agent（缺省=会话级）")
  .option("--ttl-seconds <n>", "到期秒数（缺省=不过期）")
  .action(
    async (
      sessionId: string,
      capabilityId: string,
      decision: string,
      options: { agent?: string; ttlSeconds?: string },
    ) => {
      if (decision !== "allow" && decision !== "ask") {
        process.stderr.write("decision 必须为 allow|ask\n");
        process.exitCode = 2;
        return;
      }
      const ttlSeconds = options.ttlSeconds;
      const expiresAtIso =
        ttlSeconds === undefined
          ? null
          : new Date(Date.now() + Number.parseInt(ttlSeconds, 10) * 1000).toISOString();
      process.exitCode = await executeSessionElevateCommand({
        stateDirectory: defaultStateDirectory(),
        sessionId,
        capabilityId,
        elevatedDecision: decision,
        agentInstanceId: options.agent ?? null,
        expiresAtIso,
      });
    },
  );
sessionCommand
  .command("revoke-elevation")
  .description("撤销指定临时提升")
  .argument("<sessionId>", "会话 ID")
  .argument("<elevationId>", "提升 ID")
  .action(async (sessionId: string, elevationId: string) => {
    process.exitCode = await executeSessionRevokeElevationCommand({
      stateDirectory: defaultStateDirectory(),
      sessionId,
      elevationId,
    });
  });
sessionCommand
  .command("shutdown")
  .description("关闭会话：收敛 → 可选导出（受控备份）→ 无条件撤销全部提升")
  .argument("<sessionId>", "会话 ID")
  .option("--export <path>", "导出公开有效配置路径")
  .option("--json", "JSON 输出")
  .action(
    async (sessionId: string, options: { export?: string; json?: boolean }) => {
      process.exitCode = await executeSessionShutdownCommand({
        stateDirectory: defaultStateDirectory(),
        sessionId,
        exportPath: options.export ?? null,
        isJsonOutput: options.json === true,
      });
    },
  );

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
