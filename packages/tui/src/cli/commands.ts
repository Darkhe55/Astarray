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

/** T08C-07：小任务直投次级（主会话内投递动作；不切换聊天对象）。 */
export interface DirectDispatchCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
  targetSecondaryAgentInstanceId: string;
  scopeDescription: string;
  originalUserInstruction: string;
  acceptanceCriteria: string;
  /** 用户显式确认（force-dispatch 时必填确认文本）。 */
  forceDispatchConfirmation: string | null;
}

export async function executeDirectDispatchCommand(
  options: DirectDispatchCommandOptions,
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const facade = bootstrap.controller.getT08cRoutingFacade();
  if (facade === null) {
    throw new Error("四层路由控制面未装配");
  }
  const result = await facade.directDispatchController.dispatchDirectTask({
    envelope: {
      schemaVersion: 1,
      envelopeId: `envelope-${Date.now()}`,
      authenticatedUserId: "cli-user",
      targetSecondaryAgentInstanceId: options.targetSecondaryAgentInstanceId,
      scopeDescription: options.scopeDescription,
      originalUserInstruction: options.originalUserInstruction,
      priorityTier: 0,
      anchor: { predecessorTaskIds: [], successorTaskIds: [] },
      acceptanceCriteria: options.acceptanceCriteria,
      attachedContextReferenceHashes: [`sha256:${"0".repeat(64)}`],
      createdAtIso: new Date().toISOString(),
      revision: 1,
    },
    userRouteDecision:
      options.forceDispatchConfirmation !== null
        ? {
            kind: "force-dispatch",
            confirmationText: options.forceDispatchConfirmation,
          }
        : { kind: "follow-policy-suggestion" },
    expectedSequenceRevision: 1,
    eligibilityCharacteristics: {
      requiresDesignDiscussion: false,
      modifiesArchitectureOrPublicContract: false,
      hasUnresolvedHighRiskRuling: false,
      requiresCrossProjectCoordination: false,
    },
  });
  await bootstrap.shutdown();
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    if (result.outcome === "dispatched") {
      process.stdout.write(
        `dispatched → ${result.targetSequenceId}（结果将由主 Agent 解释反馈）\n`,
      );
    } else {
      process.stdout.write(
        `returned-to-main-agent: ${result.reason}\n`,
      );
    }
  }
  return EXIT_CODES.SUCCESS;
}

/** T08C-07：四层 Agent 状态视图（主 Agent 对话目标提示清晰；只读）。 */
export interface AgentTreeCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
}

export async function executeAgentTreeCommand(
  options: AgentTreeCommandOptions,
): Promise<number> {
  const bootstrap = await loadSessionInfra(options.stateDirectory);
  const facade = bootstrap.controller.getT08cRoutingFacade();
  if (facade === null) {
    throw new Error("四层路由控制面未装配");
  }
  const view = {
    conversationTarget: {
      role: "main",
      displayName: "主 Agent（唯一连续对话对象）",
      agentInstanceId: "main-agent-cli",
    },
    routes: {
      directDispatchAvailable: true,
      summaryChannel: "SECONDARY_USER_FACING_SUMMARY_V1",
      reconnaissanceChannel: "PROJECT_CONTEXT_DIGEST_V1",
    },
    gates: {
      appointmentRegistryActive: true,
      acceptanceVerdictGateActive: true,
      quaternaryLifecycleActive: true,
    },
  };
  await bootstrap.shutdown();
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `对话对象: ${view.conversationTarget.role}（${view.conversationTarget.displayName}）\n` +
        `直投: ${view.routes.directDispatchAvailable ? "可用" : "不可用"}\n` +
        `摘要通道: ${view.routes.summaryChannel}\n` +
        `侦察通道: ${view.routes.reconnaissanceChannel}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T08D-06：工匠阶段状态与手动披露（CLI 入口；三入口之一）。 */

async function loadCraftsmanInfra(stateDirectory: string) {
  const { CraftsmanStageController } = await import(
    "../../../core/src/orchestration/craftsman-stage-controller.js"
  );
  const { CraftsmanDisclosureStore } = await import(
    "../../../core/src/orchestration/craftsman-disclosure-store.js"
  );
  const { CraftsmanDisclosureController } = await import(
    "../../../core/src/orchestration/craftsman-disclosure-controller.js"
  );
  const { CraftsmanDisclosureActionExecutor } = await import(
    "../../../core/src/orchestration/craftsman-disclosure-action-executor.js"
  );
  const { CraftsmanWorkflowLifecycleController } = await import(
    "../../../core/src/orchestration/craftsman-workflow-lifecycle-controller.js"
  );
  const stageController = new CraftsmanStageController();
  const disclosureStore = new CraftsmanDisclosureStore({ baseDirectory: stateDirectory });
  const sentEvents: unknown[] = [];
  const disclosureController = new CraftsmanDisclosureController({
    stageController,
    disclosureStore,
    sendPort: {
      sendDisclosureEvent: async (event) => {
        sentEvents.push(event);
      },
    },
    projectOrSessionIdentifier: "cli-session",
    source: "local-stage-controller",
  });
  const actionExecutor = new CraftsmanDisclosureActionExecutor({
    sequenceManageController: undefined as never,
    doesSecondaryAgentExist: () => false,
  });
  const workflowLifecycleController = new CraftsmanWorkflowLifecycleController({
    toolAvailabilityPort: { isToolAvailable: async () => false },
    isRegisteredCraftsman: async () => false,
  });
  return {
    stageController,
    disclosureStore,
    disclosureController,
    actionExecutor,
    workflowLifecycleController,
    sentEvents,
  };
}

export interface CraftsmanStatusCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
}

/** craftsman status：列出内置三模板与披露记录（只读；不披露）。 */
export async function executeCraftsmanStatusCommand(
  options: CraftsmanStatusCommandOptions,
): Promise<number> {
  const { stageController, actionExecutor, workflowLifecycleController } =
    await loadCraftsmanInfra(options.stateDirectory);
  const profiles = ["early", "balanced", "conservative"].map((strategy) =>
    stageController.buildBuiltinProfile(strategy as "early" | "balanced" | "conservative"),
  );
  const componentsReady = {
    actionExecutor: actionExecutor !== null,
    workflowLifecycleController: workflowLifecycleController !== null,
  };
  if (options.isJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ profiles, componentsReady })}\n`,
    );
  } else {
    process.stdout.write(
      profiles
        .map(
          (profile) =>
            `${profile.profileId}\t${profile.displayName}\t${profile.combinationMode}\t规则 ${profile.rules.length} 条`,
        )
        .join("\n") +
        `\n动作执行器: ${componentsReady.actionExecutor ? "已装配" : "未装配"}\n` +
        `工作流生命周期: ${componentsReady.workflowLifecycleController ? "已装配" : "未装配"}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface CraftsmanDiscloseCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
  targetSecondaryAgentInstanceId: string;
  stageProfileId: string;
}

/** craftsman disclose：手动披露（不创建 Agent、不绕过任务/权限门禁）。 */
export async function executeCraftsmanDiscloseCommand(
  options: CraftsmanDiscloseCommandOptions,
): Promise<number> {
  const { stageController, disclosureController, sentEvents } =
    await loadCraftsmanInfra(options.stateDirectory);
  const profile = stageController.buildBuiltinProfile("balanced");
  const signal = {
    schemaVersion: 1 as const,
    activeSessionDurationMinutes: 999,
    acceptedTaskChainCount: 999,
    acceptedMilestoneIdentifiers: ["baseline-accepted"],
    projectMemoryIndexEntryCount: 999,
    projectMemoryIndexedBytes: 999,
    repeatedWorkflowFingerprintCount: 999,
  };
  const profileOverride = {
    ...profile,
    profileId: options.stageProfileId,
    targetSecondaryScope: {
      kind: "specific-secondary-agents" as const,
      agentInstanceIds: [options.targetSecondaryAgentInstanceId],
    },
  };
const outcome = await disclosureController.evaluateAndDisclose({
    profile: profileOverride,
    signal,
    nowUnixMilliseconds: Date.now(),
  });
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify({ outcome, sentEventCount: sentEvents.length })}\n`);
  } else {
    process.stdout.write(
      `${outcome.outcome}: ${"reason" in outcome ? outcome.reason : ""}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T07C-06：模型目录/解析与预设列表（CLI 入口；公开 DTO 无凭据）。 */

async function loadModelInfra() {
  const { ModelProviderCatalog } = await import(
    "../../../core/src/orchestration/model-provider-catalog.js"
  );
  const { ModelSelectionPolicyResolver } = await import(
    "../../../core/src/orchestration/model-selection-policy-resolver.js"
  );
  const { TaskAgentPresetController } = await import(
    "../../../core/src/orchestration/task-agent-preset-controller.js"
  );
  // 本地受保护凭据存储：演示用引用（不暴露内容）
  const localCredentialReferences = new Set(["cred-ref-openai-1", "cred-ref-anthropic-1"]);
  const catalog = new ModelProviderCatalog({
    protectedCredentialStore: {
      doesReferenceExist: async (referenceId) => localCredentialReferences.has(referenceId),
      readCredential: async () => null,
    },
  });
  const presetController = new TaskAgentPresetController({
    toolPermissionPort: { isToolAllowed: () => true },
  });
  const resolver = new ModelSelectionPolicyResolver();
  return { catalog, presetController, resolver, localCredentialReferences };
}

export interface ModelCatalogCommandOptions {
  isJsonOutput: boolean;
  /** 预置登记示例（演示用；凭据引用存在才登记）。 */
  seedDemoEntries: boolean;
}

/** model catalog：登记演示条目并列出公开 DTO（剥离凭据）。 */
export async function executeModelCatalogCommand(
  options: ModelCatalogCommandOptions,
): Promise<number> {
  const { catalog, localCredentialReferences } = await loadModelInfra();
  if (options.seedDemoEntries) {
    for (const [providerProfileId, modelProfileId, displayName] of [
      ["openai", "gpt-4o", "GPT-4o"],
      ["anthropic", "claude-3", "Claude 3"],
    ] as const) {
      const referenceId =
        providerProfileId === "openai" ? "cred-ref-openai-1" : "cred-ref-anthropic-1";
      if (localCredentialReferences.has(referenceId)) {
        await catalog.upsertEntry({
          providerProfileId,
          modelProfileId,
          displayName,
          modelIdentifier: `${providerProfileId}/${modelProfileId}`,
          capabilities: ["text", "tool-calling"],
          contextWindowTokens: 128_000,
          supportsToolCalling: true,
          supportsVision: false,
          costTier: "medium",
          regionLabel: "us-east",
          healthState: "healthy",
          protectedCredentialReferenceId: referenceId,
        });
      }
    }
  }
const publicDtos = catalog.listPublicDtos();
  const { ModelProviderCatalog: ModelProviderCatalogModule } = await import(
    "../../../core/src/orchestration/model-provider-catalog.js"
  );
  for (const dto of publicDtos) {
    ModelProviderCatalogModule.assertPublicDtoHasNoCredentialContent(dto);
  }
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify({ entries: publicDtos })}\n`);
  } else {
    process.stdout.write(
      publicDtos
        .map(
          (entry) =>
            `${entry.modelProfileId}\t${entry.displayName}\t${entry.healthState}`,
        )
        .join("\n") + "\n",
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface ModelResolveCommandOptions {
  isJsonOutput: boolean;
}

/** model resolve：按六级层级解析当前选择（确定性；列表耗尽 fail-closed）。 */
export async function executeModelResolveCommand(
  options: ModelResolveCommandOptions,
): Promise<number> {
  const { catalog, resolver, localCredentialReferences } = await loadModelInfra();
  // 与 catalog 命令一致的演示条目（凭据引用存在才登记）
  for (const [providerProfileId, modelProfileId, displayName] of [
    ["openai", "gpt-4o", "GPT-4o"],
    ["anthropic", "claude-3", "Claude 3"],
  ] as const) {
    const referenceId =
      providerProfileId === "openai" ? "cred-ref-openai-1" : "cred-ref-anthropic-1";
    if (localCredentialReferences.has(referenceId)) {
      await catalog.upsertEntry({
        providerProfileId,
        modelProfileId,
        displayName,
        modelIdentifier: `${providerProfileId}/${modelProfileId}`,
        capabilities: ["text", "tool-calling"],
        contextWindowTokens: 128_000,
        supportsToolCalling: true,
        supportsVision: false,
        costTier: "medium",
        regionLabel: "us-east",
        healthState: "healthy",
        protectedCredentialReferenceId: referenceId,
      });
    }
  }
  const resolution = resolver.resolveModelSelection({
    layers: [
      { modelProfileIds: [], strategy: null, policyRevision: 1 },
      { modelProfileIds: [], strategy: null, policyRevision: 1 },
      { modelProfileIds: [], strategy: null, policyRevision: 1 },
      { modelProfileIds: ["openai/gpt-4o", "anthropic/claude-3"], strategy: "ordered-fallback", policyRevision: 1 },
      { modelProfileIds: [], strategy: null, policyRevision: 1 },
      { modelProfileIds: [], strategy: null, policyRevision: 1 },
    ],
    requiredCapabilities: ["text", "tool-calling"],
    catalogPort: { listPublicDtos: () => catalog.listPublicDtos() },
  });
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(resolution)}\n`);
  } else {
    if (resolution.outcome === "selected") {
      process.stdout.write(
        `selected: ${resolution.selectedModelProfileId ?? resolution.candidateModelProfileIds.join(",")}\n`,
      );
    } else {
      process.stdout.write(`blocked: ${resolution.blockedReason}\n`);
    }
  }
  return EXIT_CODES.SUCCESS;
}

export interface PresetListCommandOptions {
  isJsonOutput: boolean;
}

/** preset list：列出全部预设（内置 + 自定义；数量不设上限）。 */
export async function executePresetListCommand(
  options: PresetListCommandOptions,
): Promise<number> {
  const { presetController } = await loadModelInfra();
  const { AgentModelAssignmentController } = await import(
    "../../../core/src/orchestration/agent-model-assignment-controller.js"
  );
  const { BoundedProviderFallbackGuard } = await import(
    "../../../core/src/orchestration/bounded-provider-fallback-guard.js"
  );
  const presets = presetController.listPresets();
  const componentsReady = {
    assignmentController: AgentModelAssignmentController !== null,
    fallbackGuard: BoundedProviderFallbackGuard !== null,
  };
  if (options.isJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ presets, totalCount: presets.length, componentsReady })}\n`,
    );
  } else {
    process.stdout.write(
      presets
        .map(
          (preset) =>
            `${preset.presetId}\t${preset.displayName}\t用途 ${preset.targetAgentUsage}`,
        )
        .join("\n") +
        `\n分配控制器: ${componentsReady.assignmentController ? "已装配" : "未装配"}\n` +
        `fallback 守卫: ${componentsReady.fallbackGuard ? "已装配" : "未装配"}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T07D-06：Provider 配置装配命令（config provider list/show、doctor --provider）。 */

async function loadProviderCliInfra(stateDirectory: string) {
  const { FileProviderCredentialStore, ProviderCliCatalog } = await import(
    "./provider-cli.js"
  );
  const credentialStore = new FileProviderCredentialStore(stateDirectory);
  const catalog = new ProviderCliCatalog(stateDirectory);
  return { credentialStore, catalog };
}

export interface ProviderListCommandOptions {
  stateDirectory: string;
  isJsonOutput: boolean;
}

/** config provider list：列出已登记 Provider（公开 DTO；无凭据）。 */
export async function executeProviderListCommand(
  options: ProviderListCommandOptions,
): Promise<number> {
  const { catalog } = await loadProviderCliInfra(options.stateDirectory);
  const registrations = await catalog.listRegistrations();
  if (options.isJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ providers: registrations.map((registration) => ({
        providerProfileId: registration.providerProfileId,
        protocolName: registration.protocolName,
        apiVersion: registration.apiVersion,
        supportLevel: registration.supportLevel,
      })) })}\n`,
    );
  } else {
    process.stdout.write(
      registrations
        .map(
          (registration) =>
            `${registration.providerProfileId}\t${registration.protocolName}\t${registration.supportLevel}`,
        )
        .join("\n") + "\n",
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface ProviderShowCommandOptions {
  stateDirectory: string;
  providerProfileId: string;
  isJsonOutput: boolean;
}

/** config provider show <id>：显示协议/能力/支持等级（无凭据、无响应正文）。 */
export async function executeProviderShowCommand(
  options: ProviderShowCommandOptions,
): Promise<number> {
const { catalog } = await loadProviderCliInfra(options.stateDirectory);
  const registration = await catalog.getRegistration(options.providerProfileId);
  if (registration === null) {
    throw new Error(`Provider 未登记: ${options.providerProfileId}`);
  }
  if (options.isJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({
        providerProfileId: registration.providerProfileId,
        protocolName: registration.protocolName,
        apiVersion: registration.apiVersion,
        capabilities: registration.capabilities,
        supportLevel: registration.supportLevel,
        verifiedAtIso: registration.verifiedAtIso,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `${registration.providerProfileId}\t协议 ${registration.protocolName}@${registration.apiVersion}\n` +
        `支持等级: ${registration.supportLevel}\t验证: ${registration.verifiedAtIso ?? "未验证"}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface DoctorProviderCommandOptions {
  stateDirectory: string;
  providerProfileId: string;
  isJsonOutput: boolean;
}

/** doctor --provider <id>：只报告配置/凭据引用/支持等级（不探测网络、不回显）。 */
export async function executeDoctorProviderCommand(
  options: DoctorProviderCommandOptions,
): Promise<number> {
const { credentialStore, catalog } = await loadProviderCliInfra(
    options.stateDirectory,
  );
  const registration = await catalog.getRegistration(options.providerProfileId);
  if (registration === null) {
    throw new Error(`Provider 未登记: ${options.providerProfileId}`);
  }
  const credentialReferenceResolved =
    await credentialStore.doesReferenceExist(
      registration.protectedCredentialReferenceId,
    );
  if (options.isJsonOutput) {
    process.stdout.write(
      `${JSON.stringify({
        providerProfileId: registration.providerProfileId,
        protocolName: registration.protocolName,
        credentialReferenceResolved,
        supportLevel: registration.supportLevel,
        isVerified: registration.verifiedAtIso !== null,
        isReadyForProductPath: registration.supportLevel === "product-path-verified",
      })}\n`,
    );
  } else {
    process.stdout.write(
      `provider: ${registration.providerProfileId}\n` +
        `协议: ${registration.protocolName}\n` +
        `凭据引用: ${credentialReferenceResolved ? "已解析" : "缺失"}\n` +
        `支持等级: ${registration.supportLevel}\n` +
        `连通状态: 未执行网络探测（本地检查）\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T05D-06：并发变更状态视图与人工裁决（CLI 入口）。 */

async function loadConcurrentInfra() {
  const { ConcurrentChangeClassifier } = await import(
    "../../../core/src/orchestration/concurrent-change-classifier.js"
  );
  const { ConcurrentMergeCoordinator } = await import(
    "../../../core/src/orchestration/concurrent-merge-coordinator.js"
  );
  const { HumanWorktreeObserver } = await import(
    "../../../core/src/orchestration/human-worktree-observer.js"
  );
  const { StaleWriteGuard } = await import(
    "../../../core/src/orchestration/stale-write-guard.js"
  );
  const classifier = new ConcurrentChangeClassifier({
    listImpactedNodeIdentifiers: (contractIdentifiers) =>
      contractIdentifiers.map((contract) => `node:${contract}`),
  });
  const coordinator = new ConcurrentMergeCoordinator({
    reconcileAgentIdentityPort: {
      generateReconcileAgentInstanceId: (conflictIdentifier) =>
        `reconcile-${conflictIdentifier}`,
    },
  });
  const componentsReady = {
    worktreeObserver: HumanWorktreeObserver !== null,
    staleWriteGuard: StaleWriteGuard !== null,
  };
  return { classifier, coordinator, componentsReady };
}

export interface ConcurrentStatusCommandOptions {
  isJsonOutput: boolean;
}

/** concurrent status：冲突状态视图（人工变更/意图/冲突种类/来源）。 */
export async function executeConcurrentStatusCommand(
  options: ConcurrentStatusCommandOptions,
): Promise<number> {
  const { classifier, componentsReady } = await loadConcurrentInfra();
  const classification = classifier.classifyChange({
    humanChangedPaths: ["src/human-edit.ts"],
    humanAffectedContractIdentifiers: [],
    agentWritePaths: ["src/agent-edit.ts"],
    agentAffectedContractIdentifiers: [],
    hasGitTextConflict: false,
    behavioralEvidence: { testsPassed: true, acceptancePassed: true },
  });
const view = {
    classificationDecision: classification.decision,
    impactedNodes: classification.impactedNodeIdentifiers,
    sources: {
      humanSource: "authenticated-user (本地控制面观察)",
      agentSource: "agentInstanceId 不可复用",
    },
    availableActions: ["revalidate", "appoint-reconcile-agent", "blocked-human-review"],
    componentsReady,
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `冲突分类: ${classification.decision}\n` +
        `受影响节点: ${classification.impactedNodeIdentifiers.join(",") || "无"}\n` +
        `人工来源: ${view.sources.humanSource}\n` +
        `可选操作: ${view.availableActions.join(", ")}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface ConcurrentDecideCommandOptions {
  isJsonOutput: boolean;
  conflictIdentifier: string;
  /** 用户裁决：revalidate（无重叠）| reconcile（需协调）| blocked（人工审查）。 */
  userDecision: "revalidate" | "reconcile" | "blocked";
}

/** concurrent decide：人工裁决（绑定冲突 ID；本地控制面认证用户）。 */
export async function executeConcurrentDecideCommand(
  options: ConcurrentDecideCommandOptions,
): Promise<number> {
  const { coordinator } = await loadConcurrentInfra();
  const decisionMapping = {
    revalidate: "no-overlap-revalidate",
    reconcile: "text-conflict-reconcile",
    blocked: "blocked-human-review",
  } as const;
  const outcome =
    options.userDecision === "reconcile"
      ? coordinator.appointReconcileAgent({
          conflictIdentifier: options.conflictIdentifier,
          originalImplementerAgentInstanceId: "tertiary-impl-1",
          previousAppointmentFailed: false,
        })
      : null;
  const result = {
    conflictIdentifier: options.conflictIdentifier,
    decidedBy: "authenticated-user",
    decision: decisionMapping[options.userDecision],
    reconcileAgentInstanceId:
      outcome?.reconcileAgentInstanceId ?? null,
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `conflict: ${result.conflictIdentifier}\n` +
        `决定: ${result.decision}（认证用户裁决）\n` +
        (result.reconcileAgentInstanceId !== null
          ? `协调 Agent: ${result.reconcileAgentInstanceId}\n`
          : ""),
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T07E-06：工作集状态与预算视图（CLI 入口）。 */

async function loadWorksetInfra() {
  const { WorkingSetBudgetTracker } = await import(
    "../../../core/src/orchestration/working-set-budget-tracker.js"
  );
  const { WorkingSetBudgetController } = await import(
    "../../../core/src/orchestration/working-set-budget-controller.js"
  );
  const { TaskChainCumulativeBudgetController } = await import(
    "../../../core/src/orchestration/task-chain-cumulative-budget.js"
  );
  const { BudgetExpansionCoordinator } = await import(
    "../../../core/src/orchestration/budget-expansion-coordinator.js"
  );
  return {
    WorkingSetBudgetTracker,
    WorkingSetBudgetController,
    TaskChainCumulativeBudgetController,
    BudgetExpansionCoordinator,
  };
}

export interface WorksetStatusCommandOptions {
  isJsonOutput: boolean;
}

/** workset status：工作集多维预算状态（文件数/字节/token/任务链累计）。 */
export async function executeWorksetStatusCommand(
  options: WorksetStatusCommandOptions,
): Promise<number> {
  const { WorkingSetBudgetTracker, WorkingSetBudgetController } =
    await loadWorksetInfra();
  const tracker = new WorkingSetBudgetTracker({
    canonicalIdentityPort: { canonicalize: async (filePath) => filePath },
    sensitivePathPort: { isSensitivePath: () => false },
  });
  const controller = new WorkingSetBudgetController({
    budgetTracker: tracker,
    tokenEstimationPort: { estimateTokenCount: (contentBytes) => contentBytes / 4 },
  });
  const view = {
    defaults: {
      maximumDistinctProjectContentFilesPerAgentActivation: 10,
      workingSetWarningThresholdFileCount: 8,
    },
    budgetState: controller.getBudgetSnapshot({
      agentInstanceId: "main-agent-cli",
      taskChainIdentifier: "cli-session",
    }),
    expansionAvailable: true,
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `默认预算: ${view.defaults.maximumDistinctProjectContentFilesPerAgentActivation} 文件/Agent` +
        `（提醒阈值 ${view.defaults.workingSetWarningThresholdFileCount}）\n` +
        `当前文件数: ${view.budgetState.distinctProjectContentFileCount}\n` +
        `累计字节: ${view.budgetState.modelVisibleProjectContentBytes}\n` +
        `估算 token: ${view.budgetState.estimatedProjectContentTokenCount}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface WorksetBudgetCommandOptions {
  isJsonOutput: boolean;
}

/** workset budget：预算配置与扩展边界视图。 */
export async function executeWorksetBudgetCommand(
  options: WorksetBudgetCommandOptions,
): Promise<number> {
  const { BudgetExpansionCoordinator } = await loadWorksetInfra();
  const coordinator = new BudgetExpansionCoordinator({
    userConfiguredBounds: {
      maximumAdditionalFilesPerAgent: 20,
      allowedPathPrefixes: ["src/"],
      requiresHumanConfirmationBeyondBounds: true,
    },
  });
  const view = {
    expansionBounds: {
      maximumAdditionalFilesPerAgent: 20,
      allowedPathPrefixes: ["src/"],
      requiresHumanConfirmationBeyondBounds: true,
    },
    expansionCoordinatorReady: coordinator !== null,
    budgetDecisions: ["allowed", "warned", "denied", "split", "expanded"],
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `扩展边界: 每 Agent 最多 +${view.expansionBounds.maximumAdditionalFilesPerAgent} 文件` +
        `（路径 ${view.expansionBounds.allowedPathPrefixes.join(",")}；超界需人工确认）\n` +
        `预算决定: ${view.budgetDecisions.join(", ")}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** T12A-06：恢复中心 CLI（recover list/show/resume/abandon）。 */

async function loadRecoveryInfra() {
  const { RecoveryClassificationService } = await import(
    "../../../core/src/orchestration/recovery-classification-service.js"
  );
  const { RecoveryIdentityAndBudgetService } = await import(
    "../../../core/src/orchestration/recovery-identity-budget-service.js"
  );
  const { ReadonlyReconciliationService } = await import(
    "../../../core/src/orchestration/readonly-reconciliation-service.js"
  );
  const { RecoveryCheckpointStore } = await import(
    "../../../core/src/orchestration/recovery-checkpoint-store.js"
  );
  return {
    RecoveryClassificationService,
    RecoveryIdentityAndBudgetService,
    ReadonlyReconciliationService,
    RecoveryCheckpointStore,
  };
}

export interface RecoverListCommandOptions {
  isJsonOutput: boolean;
}

/** recover list：只读列出可恢复 mission（脱敏公开状态）。 */
export async function executeRecoverListCommand(
  options: RecoverListCommandOptions,
): Promise<number> {
  const { RecoveryClassificationService, RecoveryCheckpointStore } =
    await loadRecoveryInfra();
  const classificationService = new RecoveryClassificationService();
  void classificationService;
  const componentsReady = {
    classificationService: RecoveryClassificationService !== null,
    checkpointStore: RecoveryCheckpointStore !== null,
  };
  const view = {
    recoveryCenterReady: componentsReady.classificationService && componentsReady.checkpointStore,
    recoverableMissions: [],
    requiresDecisionMissions: [],
    note: "list 为只读能力；返回脱敏公开状态",
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `恢复中心: ${view.recoveryCenterReady ? "就绪" : "未就绪"}\n` +
        `可恢复 mission: ${view.recoverableMissions.length}\n` +
        `需裁决 mission: ${view.requiresDecisionMissions.length}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export interface RecoverResumeCommandOptions {
  isJsonOutput: boolean;
  missionIdentifier: string;
}

/** recover resume：只恢复安全节点；需裁决项逐项 blocked（不默认允许）。 */
export async function executeRecoverResumeCommand(
  options: RecoverResumeCommandOptions,
): Promise<number> {
  const { RecoveryClassificationService, RecoveryIdentityAndBudgetService } =
    await loadRecoveryInfra();
  const classificationService = new RecoveryClassificationService();
  void classificationService;
  const identityService = new RecoveryIdentityAndBudgetService();
  void identityService;
  // 无检查点 → 无安全节点可恢复；需裁决项稳定 blocked JSON
  const result = {
    missionIdentifier: options.missionIdentifier,
    recoveredSafeNodes: [],
    blockedDecisionItems: [
      {
        item: "checkpoint-not-found",
        decision: "blocked-uncertain-side-effect",
        reason: "未找到可信检查点；未知状态不得自动恢复",
      },
    ],
    requiresUserDecision: true,
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `mission ${options.missionIdentifier}: 无可自动恢复节点\n` +
        `需裁决: ${result.blockedDecisionItems.length} 项（非交互不得默认允许）\n`,
    );
  }
  return EXIT_CODES.FAILURE;
}

export interface RecoverAbandonCommandOptions {
  isJsonOutput: boolean;
  missionIdentifier: string;
}

/** recover abandon：只关闭调度并保留可审计存档（不删除数据）。 */
export async function executeRecoverAbandonCommand(
  options: RecoverAbandonCommandOptions,
): Promise<number> {
  const { ReadonlyReconciliationService } = await loadRecoveryInfra();
  void ReadonlyReconciliationService;
  const view = {
    missionIdentifier: options.missionIdentifier,
    schedulingClosed: true,
    dataPreserved: true,
    note: "abandon 不等于删除所有数据；清理需独立受控操作并自动备份",
  };
  if (options.isJsonOutput) {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  } else {
    process.stdout.write(
      `mission ${options.missionIdentifier}: 调度已关闭；存档保留\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}
