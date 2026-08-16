/**
 * CLI 引导（T11）：组装反馈进程、任务存储、工具注册表与主控制器。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ModeMachine } from "../../../core/src/core/mode-machine.js";
import { SessionAuthorizationManager } from "../../../core/src/core/permission-policy.js";
import { PermissionDecider } from "../../../core/src/core/permission-policy.js";
import { TaskStore } from "../../../core/src/infra/task-store.js";
import { ToolRegistry } from "../../../core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../core/src/tools/builtins.js";
import { PolicyWrapper } from "../../../core/src/tools/policy-wrapper.js";
import { WorkspaceBoundary } from "../../../core/src/tools/workspace-boundary.js";
import { ScriptedRuntime } from "../../../core/src/runtime/scripted-runtime.js";
import { MainController } from "../../../core/src/orchestration/main-controller.js";
import { MissionManager } from "../../../core/src/orchestration/mission-manager.js";
import { FeedbackProcessSupervisor } from "../../../core/src/feedback-process/process-supervisor.js";
import type { ForkFeedbackClient } from "../../../core/src/feedback-process/transport.js";
import type { TaskDependencyNode } from "../../../core/src/core/types.js";
import {
  BackupDeletionAuditLog,
  BackupDeletionAuthorizationController,
  BackupVault,
} from "../../../core/src/tools/backup-vault.js";
import { ProtectedStoragePolicy } from "../../../core/src/tools/protected-storage-policy.js";
import { AgentWorkArchiveStore } from "../../../core/src/orchestration/work-archive-store.js";
import { InteractiveBackupDeletionAuthorizationPort } from "./backup-deletion-port.js";
import { InteractiveInstallationGatePort } from "./install-decision-port.js";
import { InstallationOperationClassifier } from "../../../core/src/tools/installation-operation-classifier.js";
import {
  AssistInstallationAuthorizationController,
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
} from "../../../core/src/tools/assist-installation-gate.js";
import { InstallationGateGuard } from "../../../core/src/tools/installation-gate-guard.js";

export interface CliBootstrap {
  controller: MainController;
  missionManager: MissionManager;
  taskStore: TaskStore;
  supervisor: FeedbackProcessSupervisor | null;
  feedbackClient: ForkFeedbackClient | null;
  shutdown: () => Promise<void>;
}

export interface BootstrapOptions {
  mode: "ponder" | "assist" | "devolve";
  stateDirectory: string;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  /** 是否启动独立反馈进程（headless 单命令场景可关闭）。 */
  useFeedbackProcess: boolean;
  streamOutput: (missionId: string | null, text: string) => void;
}

export async function bootstrapCli(
  options: BootstrapOptions,
): Promise<CliBootstrap> {
  const stateDirectory = options.stateDirectory;
  const taskStore = new TaskStore({ baseDirectory: stateDirectory });
  const missionManager = new MissionManager(taskStore, stateDirectory);
  const modeMachine = new ModeMachine(options.mode);
  const sessionManager = new SessionAuthorizationManager();
  const permissionDecider = new PermissionDecider(modeMachine, sessionManager);
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  const workspaceRoot = process.cwd();
  const workspaceBoundary = new WorkspaceBoundary(workspaceRoot);
  const temporaryDirectoryPath = path.join(stateDirectory, "temp");

  let supervisor: FeedbackProcessSupervisor | null = null;
  let feedbackClient: ForkFeedbackClient | null = null;
  if (options.useFeedbackProcess) {
    supervisor = new FeedbackProcessSupervisor({
      baseDirectory: stateDirectory,
      modulePath: resolveFeedbackEntryPath(),
    });
    feedbackClient = await supervisor.start();
  }

  // T06A：自动备份库与删除授权控制器
  const backupVault = new BackupVault({ baseDirectory: stateDirectory });
  await backupVault.initialize();
  const backupDeletionAuditLog = new BackupDeletionAuditLog(stateDirectory);
  // AR-01：受保护存储策略（普通工具不得访问保管库与审计存储）
  const protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: stateDirectory,
  });
  // S5：交互式授权通道（警告→暂停→等待用户决定）；非 TTY 环境 fail-closed
  const interactiveDeletionPort = new InteractiveBackupDeletionAuthorizationPort({
    warnOutput: process.stderr,
  });
  const backupDeletionController = new BackupDeletionAuthorizationController({
    mode: () => modeMachine.getCurrentMode(),
    controlPort: interactiveDeletionPort,
    auditLog: backupDeletionAuditLog,
    readCurrentVaultRevision: () => backupVault.getManifestRevision(),
  });
  // T05A：Agent 工作存档
  const workArchiveStore = new AgentWorkArchiveStore({
    baseDirectory: stateDirectory,
  });

  // B6R-02：T06E 安装门禁（分类器/设置/询问/逐次授权 + 交互端口）
  const installationClassifier = new InstallationOperationClassifier();
  const installationSettingsStore = new AssistInstallationSettingsStore({
    baseDirectory: stateDirectory,
  });
  const installationInquiryController = new ExistingResourceInquiryController(null);
  const installationAuthorizationController =
    new AssistInstallationAuthorizationController({
      settingsStore: installationSettingsStore,
    });
  const interactiveInstallationPort = new InteractiveInstallationGatePort({
    isInteractive: () => process.stdin.isTTY === true,
  });
  const installationGateGuard = new InstallationGateGuard({
    classifier: installationClassifier,
    inquiryController: installationInquiryController,
    authorizationController: installationAuthorizationController,
    userPort: interactiveInstallationPort,
    authenticatedUserId: "cli-user",
    getCurrentMode: () => modeMachine.getCurrentMode(),
  });

  const controller = new MainController({
    modeMachine,
    sessionManager,
    taskStore,
    missionManager,
    registry,
    feedbackTransport: feedbackClient ?? createNoopFeedbackTransport(),
    workspaceBoundary,
    temporaryDirectoryPath,
    concurrency: options.concurrency,
    failureThreshold: options.failureThreshold,
    maxLoopIterations: options.maxLoopIterations,
    backupVault,
    backupDeletionController,
    workArchiveStore,
    mainRuntimeFactory: () =>
      new ScriptedRuntime([
        {
          type: "text",
          text: "（主 Agent 应答）任务已受理。",
        },
        { type: "finish", reason: "success", detail: "受理完成" },
      ]),
    workerRuntimeFactory: (): ScriptedRuntime =>
      new ScriptedRuntime([
        { type: "text", text: "（mock 执行器）" },
        { type: "finish", reason: "success", detail: "任务完成" },
      ]),
    buildWorkerToolPort: (task: TaskDependencyNode, allowedToolNames: Set<string>) =>
      new PolicyWrapper({
        permissionDecider,
        registry,
        workspaceBoundary,
        temporaryDirectoryPath,
        workerAllowedToolNames: allowedToolNames,
        nowUnixSeconds: () => Math.floor(Date.now() / 1000),
        getCurrentMode: () => modeMachine.getCurrentMode(),
        auditSink: undefined,
        backupServicePort: backupVault,
        vault: backupVault,
        deletionController: backupDeletionController,
        requestingAgentInstanceId: `worker:${task.id}`,
        protectedStoragePolicy,
        installationGateGuard,
        taskExecutionId: `task-exec:${task.id}`,
      }),
    buildPermissionExplanation: (toolName: string) =>
      `执行任务需要调用工具 ${toolName}`,
    streamOutput: options.streamOutput,
  });

  const shutdown = async (): Promise<void> => {
    await feedbackClient?.shutdown().catch(() => {});
    await supervisor?.stop().catch(() => {});
  };

  return {
    controller,
    missionManager,
    taskStore,
    supervisor,
    feedbackClient,
    shutdown,
  };
}

function resolveFeedbackEntryPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
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
  return (
    candidates.find((candidatePath) => existsSync(candidatePath)) ?? candidates[0]!
  );
}

import type { FeedbackTransportPort } from "../../../core/src/core/types.js";

function createNoopFeedbackTransport(): FeedbackTransportPort {
  return {
    enqueue: async () => {},
    queryHealth: async () => ({
      isHealthy: true,
      processPid: null,
      protocolVersion: 1,
      queuedMessageCount: 0,
    }),
    shutdown: async () => {},
    setAgentStatus: () => {},
    onMessage: () => {},
  };
}
