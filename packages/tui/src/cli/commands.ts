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

/** B6R-04：认证用户设置控制面——权限组生命周期命令（Headless 契约）。 */

export interface ProfileCommandOptions {
  stateDirectory: string;
  isJsonOutput?: boolean;
}

function failWithCode(message: string, exitCode = 2): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  throw new Error(message);
}

async function loadProfileInfra(stateDirectory: string) {
  const { PermissionCapabilityCatalog } = await import(
    "../../../core/src/tools/permission-capability-catalog.js"
  );
  const { PermissionProfileStore } = await import(
    "../../../core/src/tools/permission-profile-store.js"
  );
  const { CustomPermissionProfileController } = await import(
    "../../../core/src/tools/custom-permission-profile-controller.js"
  );
  const { CurrentPermissionSelectionStore } = await import(
    "../../../core/src/tools/current-permission-selection.js"
  );
  const catalog = new PermissionCapabilityCatalog();
  const profileStore = new PermissionProfileStore({
    baseDirectory: stateDirectory,
    catalog,
  });
  const controller = new CustomPermissionProfileController(profileStore, catalog);
  const selectionStore = new CurrentPermissionSelectionStore({
    baseDirectory: stateDirectory,
  });
  return { catalog, profileStore, controller, selectionStore };
}

/** profile list：分页列出全部权限组（含内置；无产品数量上限）。 */
export async function executeProfileListCommand(
  options: ProfileCommandOptions & { page?: number; pageSize?: number },
): Promise<number> {
  const { profileStore, selectionStore } = await loadProfileInfra(
    options.stateDirectory,
  );
  const builtinProfiles = ["ponder", "assist", "devolve"].map((profileId) =>
    profileStore.buildBuiltinProfile(profileId as "ponder" | "assist" | "devolve"),
  );
  const customProfiles = await profileStore.listCustomProfiles();
  const allProfiles = [...builtinProfiles, ...customProfiles];
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, options.pageSize ?? 50);
  const pageItems = allProfiles.slice((page - 1) * pageSize, page * pageSize);
  const currentSelection = await selectionStore.readSelection();
  if (options.isJsonOutput === true) {
    process.stdout.write(
      JSON.stringify({
        profiles: pageItems.map((profile) => ({
          permissionProfileId: profile.permissionProfileId,
          displayName: profile.displayName,
          isBuiltin: profile.isBuiltin,
          revision: profile.revision,
        })),
        page,
        pageSize,
        total: allProfiles.length,
        currentSelection: currentSelection?.selectedReference ?? null,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    pageItems
      .map((profile) => {
        const isCurrent =
          currentSelection !== null &&
          currentSelection.selectedReference.kind ===
            (profile.isBuiltin ? "builtin" : "custom") &&
          ((profile.isBuiltin &&
            currentSelection.selectedReference.kind === "builtin" &&
            currentSelection.selectedReference.profileId ===
              profile.permissionProfileId) ||
            (!profile.isBuiltin &&
              currentSelection.selectedReference.kind === "custom" &&
              currentSelection.selectedReference.profileId ===
                profile.permissionProfileId));
        return `${isCurrent ? "*" : " "} ${profile.permissionProfileId}\t${profile.displayName}\trevision=${profile.revision}`;
      })
      .join("\n") + "\n",
  );
  return 0;
}

/** profile create：创建自定义组（来源：blank/assist/devolve/ponder/custom:<id>）。 */
export async function executeProfileCreateCommand(
  options: ProfileCommandOptions & { displayName: string; source: string },
): Promise<number> {
  const { controller } = await loadProfileInfra(options.stateDirectory);
  const source = parseProfileSource(options.source);
  const profile = await controller.createProfile({
    displayName: options.displayName,
    source,
  });
  process.stdout.write(
    `created ${profile.permissionProfileId}\t${profile.displayName}\n`,
  );
  return 0;
}

/** profile rename / copy / reset / set-capability。 */
export async function executeProfileRenameCommand(
  options: ProfileCommandOptions & {
    permissionProfileId: string;
    newDisplayName: string;
  },
): Promise<number> {
  const { profileStore, controller } = await loadProfileInfra(options.stateDirectory);
  const document = await profileStore.readCustomProfile(options.permissionProfileId);
  if (document === null) {
    failWithCode(`权限组不存在: ${options.permissionProfileId}`);
  }
  await controller.renameProfile({
    permissionProfileId: options.permissionProfileId,
    newDisplayName: options.newDisplayName,
    expectedRevision: document.revision,
  });
  process.stdout.write(`renamed ${options.permissionProfileId}\n`);
  return 0;
}

export async function executeProfileCopyCommand(
  options: ProfileCommandOptions & {
    permissionProfileId: string;
    newDisplayName: string;
  },
): Promise<number> {
  const { controller } = await loadProfileInfra(options.stateDirectory);
  const profile = await controller.createProfile({
    displayName: options.newDisplayName,
    source: { kind: "custom", permissionProfileId: options.permissionProfileId },
  });
  process.stdout.write(`copied ${profile.permissionProfileId}\t${profile.displayName}\n`);
  return 0;
}

export async function executeProfileResetCommand(
  options: ProfileCommandOptions & {
    permissionProfileId: string;
    source: string;
  },
): Promise<number> {
  const { profileStore, controller } = await loadProfileInfra(options.stateDirectory);
  const document = await profileStore.readCustomProfile(options.permissionProfileId);
  if (document === null) {
    failWithCode(`权限组不存在: ${options.permissionProfileId}`);
  }
  await controller.resetProfile({
    permissionProfileId: options.permissionProfileId,
    source: parseProfileSource(options.source),
    expectedRevision: document.revision,
  });
  process.stdout.write(`reset ${options.permissionProfileId}\n`);
  return 0;
}

export async function executeProfileSetCapabilityCommand(
  options: ProfileCommandOptions & {
    permissionProfileId: string;
    capabilityId: string;
    decision: "allow" | "ask" | "deny";
  },
): Promise<number> {
  const { profileStore, controller } = await loadProfileInfra(options.stateDirectory);
  const document = await profileStore.readCustomProfile(options.permissionProfileId);
  if (document === null) {
    failWithCode(`权限组不存在: ${options.permissionProfileId}`);
  }
  await controller.updateCapabilityDecision({
    permissionProfileId: options.permissionProfileId,
    capabilityId: options.capabilityId,
    decision: options.decision,
    expectedRevision: document.revision,
  });
  process.stdout.write(
    `set ${options.capabilityId}=${options.decision} @ ${options.permissionProfileId}\n`,
  );
  return 0;
}

/** profile export：只导出公开可配置字段（剥离内部字段）。 */
export async function executeProfileExportCommand(
  options: ProfileCommandOptions & {
    reference: string;
    outputPath: string | null;
  },
): Promise<number> {
  const { controller } = await loadProfileInfra(options.stateDirectory);
  const reference = parseProfileReference(options.reference);
  const exported = await controller.exportProfile(reference);
  if (options.outputPath !== null) {
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    try {
      await fs.copyFile(options.outputPath, `${options.outputPath}.bak`);
    } catch {
      // 目标不存在
    }
    await fs.writeFile(
      options.outputPath,
      `${JSON.stringify(exported.exportedDocument, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`exported → ${options.outputPath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(exported.exportedDocument, null, 2)}\n`);
  }
  return 0;
}

/** profile import：只接受公开可配置字段。 */
export async function executeProfileImportCommand(
  options: ProfileCommandOptions & { inputPath: string },
): Promise<number> {
  const { controller } = await loadProfileInfra(options.stateDirectory);
  const rawContent = await fs.readFile(options.inputPath, "utf8");
  const exportedDocument = JSON.parse(rawContent) as Record<string, unknown>;
  const profile = await controller.importProfile({ exportedDocument });
  process.stdout.write(`imported ${profile.permissionProfileId}\t${profile.displayName}\n`);
  return 0;
}

/** profile delete：当前使用组必须先切换。 */
export async function executeProfileDeleteCommand(
  options: ProfileCommandOptions & { permissionProfileId: string },
): Promise<number> {
  const { controller, selectionStore } = await loadProfileInfra(
    options.stateDirectory,
  );
  const currentSelection = await selectionStore.readSelection();
  const isCurrentlyActive =
    currentSelection !== null &&
    currentSelection.selectedReference.kind === "custom" &&
    currentSelection.selectedReference.profileId === options.permissionProfileId;
  if (isCurrentlyActive) {
    failWithCode("当前使用中的权限组不能直接删除，请先 switch 到其他组");
  }
  await controller.deleteProfile({
    permissionProfileId: options.permissionProfileId,
    isCurrentlyActive: false,
  });
  process.stdout.write(`deleted ${options.permissionProfileId}\n`);
  return 0;
}

/** profile switch：认证用户选择当前权限组（持久化）。 */
export async function executeProfileSwitchCommand(
  options: ProfileCommandOptions & { reference: string },
): Promise<number> {
  const { selectionStore } = await loadProfileInfra(options.stateDirectory);
  const reference = parseProfileReference(options.reference);
  const current = await selectionStore.readSelection();
  const selection = await selectionStore.switchSelection({
    selectedReference: reference,
    expectedRevision: current?.revision ?? 0,
  });
  process.stdout.write(
    `switched → ${JSON.stringify(selection.selectedReference)}\n`,
  );
  return 0;
}

/** profile show：当前/指定 profile 详情（公开字段）。 */
export async function executeProfileShowCommand(
  options: ProfileCommandOptions & { reference: string | null },
): Promise<number> {
  const { profileStore, selectionStore } = await loadProfileInfra(options.stateDirectory);
  let reference;
  if (options.reference !== null) {
    reference = parseProfileReference(options.reference);
  } else {
    const currentSelection = await selectionStore.readSelection();
    if (currentSelection === null) {
      failWithCode("未选择权限组（请先 profile switch）");
    }
    reference = currentSelection.selectedReference;
  }
  const profile = await profileStore.readProfile(reference);
  if (options.isJsonOutput === true) {
    process.stdout.write(
      JSON.stringify({
        permissionProfileId: profile.permissionProfileId,
        displayName: profile.displayName,
        isBuiltin: profile.isBuiltin,
        revision: profile.revision,
        capabilityDecisions: profile.capabilityDecisions,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `${profile.permissionProfileId}\t${profile.displayName}\trevision=${profile.revision}\n` +
      Object.entries(profile.capabilityDecisions)
        .map(([capabilityId, decision]) => `  ${capabilityId}=${decision}`)
        .join("\n") +
      "\n",
  );
  return 0;
}

function parseProfileSource(source: string) {
  if (source === "blank") {
    return { kind: "blank" as const };
  }
  if (source === "assist" || source === "devolve" || source === "ponder") {
    return {
      kind: "builtin" as const,
      profileId: source as "assist" | "devolve" | "ponder",
    };
  }
  if (source.startsWith("custom:")) {
    return { kind: "custom" as const, permissionProfileId: source.slice(7) };
  }
  failWithCode(`非法来源: ${source}（blank|assist|devolve|ponder|custom:<id>）`);
}

function parseProfileReference(reference: string) {
  if (reference === "ponder" || reference === "assist" || reference === "devolve") {
    return {
      kind: "builtin" as const,
      profileId: reference as "ponder" | "assist" | "devolve",
    };
  }
  if (reference.startsWith("custom:")) {
    return { kind: "custom" as const, profileId: reference.slice(7) };
  }
  return { kind: "custom" as const, profileId: reference };
}

/** B6R-06：会话提升控制面与关闭导出（认证设置控制面；非模型工具）。 */
async function loadSessionInfra(stateDirectory: string) {
  const { MainController } = await import(
    "../../../core/src/orchestration/main-controller.js"
  );
  void MainController;
  const { bootstrapCli } = await import("./bootstrap.js");
  return bootstrapCli({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 3,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
}

/** session elevation-list：查看会话级/个体级提升。 */
export async function executeSessionElevationListCommand(
  options: ProfileCommandOptions & { sessionId: string },
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const elevations = await bootstrap.controller.listSessionElevations(options.sessionId);
  if (options.isJsonOutput === true) {
    process.stdout.write(`${JSON.stringify(elevations)}\n`);
  } else {
    process.stdout.write(
      elevations.length === 0
        ? "（无提升）\n"
        : elevations
            .map(
              (elevation) =>
                `${elevation.elevationId}\t${elevation.capabilityId}\t${elevation.originalDecision}→${elevation.elevatedDecision}\t${elevation.scope.scope}`,
            )
            .join("\n") + "\n",
    );
  }
  await bootstrap.shutdown();
  return 0;
}

/** session elevate：认证用户创建会话/个体提升（不提供提升主 Agent）。 */
export async function executeSessionElevateCommand(
  options: ProfileCommandOptions & {
    sessionId: string;
    capabilityId: string;
    elevatedDecision: "allow" | "ask";
    agentInstanceId: string | null;
    expiresAtIso: string | null;
  },
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const result = await bootstrap.controller.createSessionElevation({
    sessionId: options.sessionId,
    agentInstanceId: options.agentInstanceId,
    capabilityId: options.capabilityId,
    resourceScope: "workspace",
    elevatedDecision: options.elevatedDecision,
    expiresAtIso: options.expiresAtIso,
    userDecisionReference: `cli-elevate-${Date.now()}`,
    currentSessionPermissionRevision: 1,
  });
  process.stdout.write(
    `elevated ${result.elevationId}\t${options.capabilityId}\t${result.originalDecision}→${result.elevatedDecision}\n`,
  );
  await bootstrap.shutdown();
  return 0;
}

/** session revoke-elevation：撤销指定提升。 */
export async function executeSessionRevokeElevationCommand(
  options: ProfileCommandOptions & { sessionId: string; elevationId: string },
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const revoked = await bootstrap.controller.revokeSessionElevation({
    sessionId: options.sessionId,
    elevationId: options.elevationId,
  });
  process.stdout.write(revoked ? `revoked ${options.elevationId}\n` : "（未找到）\n");
  await bootstrap.shutdown();
  return 0;
}

/** session shutdown：收敛 → 可选导出（受控备份）→ 无条件撤销全部提升。 */
export async function executeSessionShutdownCommand(
  options: ProfileCommandOptions & {
    sessionId: string;
    exportPath: string | null;
  },
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const result = await bootstrap.controller.shutdownSession({
    sessionId: options.sessionId,
    exportPath: options.exportPath,
  });
  if (options.isJsonOutput === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `closed=${result.closed} revoked=${result.revokedElevationCount} exportWrote=${result.exportWrote}` +
        (result.exportFailedReason !== null
          ? ` exportFailed=${result.exportFailedReason}`
          : "") +
        "\n",
    );
  }
  await bootstrap.shutdown();
  return 0;
}

/** B6R-02：认证用户设置控制面——独立安装开关（默认 false；不授予安装）。 */export interface ConfigInstallEnabledCommandOptions {
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
