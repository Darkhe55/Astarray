/**
 * status / resume / cancel / doctor / config init 命令（T11）。
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runConfigSchema } from "../../../core/src/core/schemas.js";
import { bootstrapCli } from "./bootstrap.js";
import { EXIT_CODES, failWith, printJson } from "./json-output.js";
import { defaultStateDirectory } from "./run-command.js";

export interface StatusCommandOptions {
  missionId: string | undefined;
  isJsonOutput: boolean;
  stateDirectory: string;
}

export async function executeStatusCommand(
  options: StatusCommandOptions,
): Promise<number> {
  const bootstrap = await bootstrapCli({
    mode: "assist",
    stateDirectory: options.stateDirectory,
    concurrency: 4,
    failureThreshold: 3,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
  try {
    if (options.missionId === undefined) {
      const missionIds = await bootstrap.missionManager.listMissionIds();
      if (!options.isJsonOutput) {
        process.stdout.write(`${missionIds.join("\n")}\n`);
        return EXIT_CODES.SUCCESS;
      }
      printJson({ missions: missionIds });
      return EXIT_CODES.SUCCESS;
    }
    const missionStatus = await bootstrap.controller.queryMissionStatus(
      options.missionId,
    );
    if (!options.isJsonOutput) {
      const summary = missionStatus.summary;
      process.stdout.write(
        `mission: ${missionStatus.missionId}\n` +
          `mode: ${summary?.mode ?? "未知"}\n` +
          `status: ${summary?.status ?? "未知"}\n` +
          `tasks: ${missionStatus.taskChain?.tasks.length ?? 0}\n`,
      );
      return EXIT_CODES.SUCCESS;
    }
    printJson({
      missionId: missionStatus.missionId,
      mode: missionStatus.summary?.mode,
      status: missionStatus.summary?.status,
      prompt: missionStatus.summary?.prompt,
      tasks: missionStatus.taskChain?.tasks ?? [],
    });
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    failWith(error as Error, EXIT_CODES.USAGE_ERROR);
  } finally {
    await bootstrap.shutdown();
  }
}

export interface CancelCommandOptions {
  missionId: string;
  isJsonOutput: boolean;
  stateDirectory: string;
}

export async function executeCancelCommand(
  options: CancelCommandOptions,
): Promise<number> {
  const bootstrap = await bootstrapCli({
    mode: "assist",
    stateDirectory: options.stateDirectory,
    concurrency: 4,
    failureThreshold: 3,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
  try {
    // 校验 mission 存在（不存在时 failWith 退出码 2）
    await bootstrap.controller.queryMissionStatus(options.missionId);
    await bootstrap.controller.cancelMission(options.missionId);
    if (!options.isJsonOutput) {
      process.stdout.write(`cancelled: ${options.missionId}\n`);
      return EXIT_CODES.SUCCESS;
    }
    printJson({ missionId: options.missionId, status: "cancelled" });
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    failWith(error as Error);
  } finally {
    await bootstrap.shutdown();
  }
}

export interface ResumeCommandOptions {
  missionId: string;
  isJsonOutput: boolean;
  stateDirectory: string;
}

export async function executeResumeCommand(
  options: ResumeCommandOptions,
): Promise<number> {
  const bootstrap = await bootstrapCli({
    mode: "assist",
    stateDirectory: options.stateDirectory,
    concurrency: 4,
    failureThreshold: 3,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
  try {
    const missionStatus = await bootstrap.controller.queryMissionStatus(
      options.missionId,
    );
    const chain = missionStatus.taskChain;
    if (chain === null) {
      failWith(new Error(`任务不存在: ${options.missionId}`), EXIT_CODES.USAGE_ERROR);
    }
    const hasIncompleteTask = chain.tasks.some(
      (task) => task.status !== "done",
    );
    if (!hasIncompleteTask) {
      if (!options.isJsonOutput) {
        process.stdout.write(`already-complete: ${options.missionId}\n`);
        return EXIT_CODES.SUCCESS;
      }
      printJson({ missionId: options.missionId, status: "done", resumed: false });
      return EXIT_CODES.SUCCESS;
    }
    await bootstrap.controller.handleUserMessage(
      `恢复任务 ${options.missionId}`,
    );
    const finalStatus = await waitForResumeResult(bootstrap, options.missionId);
    if (!options.isJsonOutput) {
      process.stdout.write(`resumed: ${options.missionId} (${finalStatus})\n`);
      return EXIT_CODES.SUCCESS;
    }
    printJson({ missionId: options.missionId, status: finalStatus, resumed: true });
    return finalStatus === "done" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  } finally {
    await bootstrap.shutdown();
  }
}

async function waitForResumeResult(
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "running";
}

export interface DoctorCommandOptions {
  isJsonOutput: boolean;
  stateDirectory: string;
}

export async function executeDoctorCommand(
  options: DoctorCommandOptions,
): Promise<number> {
  const nodeMajorVersion = Number(process.versions.node.split(".")[0] ?? 0);
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const feedbackEntryCandidates = [
    path.join(moduleDirectory, "feedback-process-entry.js"),
    path.join(
      moduleDirectory,
      "..",
      "..",
      "..",
      "..",
      "dist",
      "feedback-process-entry.js",
    ),
    path.join(process.cwd(), "dist", "feedback-process-entry.js"),
  ];
  const feedbackEntryPath = feedbackEntryCandidates.find((candidatePath) =>
    existsSync(candidatePath),
  );
  const checks = {
    nodeVersionSupported: nodeMajorVersion >= 20,
    stateDirectoryWritable: await isDirectoryWritable(options.stateDirectory),
    feedbackProcessEntryExists: feedbackEntryPath !== undefined,
    workingDirectoryWritable: await isDirectoryWritable(process.cwd()),
  };
  const isHealthy = Object.values(checks).every(Boolean);
  if (!options.isJsonOutput) {
    process.stdout.write(
      `node: ${process.versions.node}\n` +
        `node-version-supported: ${checks.nodeVersionSupported}\n` +
        `state-directory-writable: ${checks.stateDirectoryWritable}\n` +
        `feedback-entry-exists: ${checks.feedbackProcessEntryExists}\n` +
        `working-directory-writable: ${checks.workingDirectoryWritable}\n` +
        `health: ${isHealthy ? "ok" : "failed"}\n`,
    );
    return isHealthy ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  }
  printJson({
    nodeVersion: process.versions.node,
    checks,
    health: isHealthy ? "ok" : "failed",
  });
  return isHealthy ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
}

/**
 * 只读可写性探测：使用随机唯一文件名 + 排他创建（wx），
 * 绝不覆盖或删除用户已有文件（审计发现：固定 .write-probe 曾可能销毁同名用户文件）。
 */
async function isDirectoryWritable(directoryPath: string): Promise<boolean> {
  const { randomUUID } = await import("node:crypto");
  try {
    await fs.mkdir(directoryPath, { recursive: true });
    const probeFilePath = path.join(
      directoryPath,
      `.astarray-write-probe-${randomUUID()}`,
    );
    const fileHandle = await fs.open(probeFilePath, "wx");
    try {
      await fileHandle.writeFile("probe", "utf8");
    } finally {
      await fileHandle.close();
    }
    await fs.rm(probeFilePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface ConfigInitCommandOptions {
  stateDirectory: string;
}

export async function executeConfigInitCommand(
  options: ConfigInitCommandOptions,
): Promise<number> {
  const configPath = path.join(options.stateDirectory, "config.json");
  const defaultConfig = {
    schemaVersion: 1,
    mode: "assist",
    concurrency: 4,
    toolFailureThreshold: 3,
    runtime: "mock",
  };
  const parsed = runConfigSchema.safeParse(defaultConfig);
  if (!parsed.success) {
    failWith(new Error(`默认配置非法: ${parsed.error.message}`));
  }
  await fs.mkdir(options.stateDirectory, { recursive: true });
  const { BackupVault } = await import(
    "../../../core/src/tools/backup-vault.js"
  );
  // S7：覆盖已有 config.json 前必须走自动备份层（不经过模型），并在写入前做 TOCTOU 校验
  const vault = new BackupVault({ baseDirectory: options.stateDirectory });
  await vault.initialize();
  const { existsSync } = await import("node:fs");
  if (existsSync(configPath)) {
    const receipt = await vault.createPreMutationBackup({
      toolName: "config-init",
      targetPath: configPath,
      mutationKind: "overwrite",
    });
    const targetIsUnchanged = await vault.verifyTargetUnchanged(
      configPath,
      receipt.targetFingerprintBeforeMutation,
    );
    if (!targetIsUnchanged) {
      failWith(new Error("config init 中止：配置在备份后被修改（TOCTOU 防护）"));
    }
  }
  await fs.writeFile(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`written: ${configPath}\n`);
  return EXIT_CODES.SUCCESS;
}

export { defaultStateDirectory };

/** B6R-02：认证用户设置控制面——独立安装开关（默认 false；不授予安装）。 */
export interface ConfigInstallEnabledCommandOptions {
  stateDirectory: string;
  isEnabled: boolean;
}

export async function executeConfigInstallEnabledCommand(
  options: ConfigInstallEnabledCommandOptions,
): Promise<number> {
  const { AssistInstallationSettingsStore } = await import(
    "../../../core/src/tools/assist-installation-gate.js"
  );
  const settingsStore = new AssistInstallationSettingsStore({
    baseDirectory: options.stateDirectory,
  });
  const current = await settingsStore.readSettings();
  const next = await settingsStore.updateInstallationEnabled({
    expectedRevision: current.revision,
    isAssistInstallationEnabled: options.isEnabled,
  });
  process.stdout.write(
    `assist-installation-enabled=${next.isAssistInstallationEnabled} revision=${next.revision}\n`,
  );
  return EXIT_CODES.SUCCESS;
}
