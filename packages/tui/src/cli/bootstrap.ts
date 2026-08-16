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
import { PermissionCapabilityCatalog } from "../../../core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../core/src/tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../../../core/src/tools/permission-profile-store.js";
import { ConfigurablePermissionPolicyEngine } from "../../../core/src/tools/configurable-permission-policy-engine.js";
import { CurrentPermissionSelectionStore } from "../../../core/src/tools/current-permission-selection.js";
import { MainAgentReadonlyToolProjection } from "../../../core/src/tools/main-agent-readonly-projection.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
} from "../../../core/src/tools/session-permission-elevation.js";
import {
  CurrentPermissionConfigurationExporter,
  SessionShutdownCoordinator,
} from "../../../core/src/tools/session-shutdown-and-export.js";
import { RegisteredAgentDirectory } from "../../../core/src/orchestration/registered-agent-directory.js";
import { MainAgentReportArchiveIngestor } from "../../../core/src/orchestration/main-agent-report-archive.js";
import { ConversationTaskInsertionController } from "../../../core/src/orchestration/conversation-task-insertion-controller.js";
import { UnboundedAgentInstanceRegistry } from "../../../core/src/orchestration/unbounded-agent-registry.js";
import { SecondaryContinuousDispatchLoop } from "../../../core/src/orchestration/secondary-continuous-dispatch-loop.js";
import {
  FileTertiaryLifecyclePhaseStore,
  TertiaryAgentLifecycleController,
} from "../../../core/src/orchestration/tertiary-lifecycle.js";
import { AgentIndividualMemoryStore } from "../../../core/src/orchestration/agent-individual-memory.js";
import { CrossAgentContextAttachmentController } from "../../../core/src/orchestration/cross-agent-attachment-controller.js";

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

  // B6R-03：可配置权限引擎（执行前按当前 profile 快照裁决）
  const permissionCatalog = new PermissionCapabilityCatalog();
  const permissionProfileStore = new PermissionProfileStore({
    baseDirectory: stateDirectory,
    catalog: permissionCatalog,
  });
  const configurablePermissionPolicyEngine = new ConfigurablePermissionPolicyEngine({
    catalog: permissionCatalog,
    profileStore: permissionProfileStore,
  });
  /** 当前权限组引用（可信运行时按模式提供；自定义组由认证设置控制面切换）。 */
  const currentPermissionProfileReference: PermissionProfileReference =
    options.mode === "ponder"
      ? { kind: "builtin", profileId: "ponder" }
      : options.mode === "assist"
        ? { kind: "builtin", profileId: "assist" }
        : { kind: "builtin", profileId: "devolve" };
  // B6R-04b：认证设置控制面（当前权限组选择持久化）
  const currentPermissionSelectionStore = new CurrentPermissionSelectionStore({
    baseDirectory: stateDirectory,
  });
  // B6R-06：主 Agent 永久只读投影 + 会话提升控制面 + 关闭协调器
  const mainAgentReadonlyProjection = new MainAgentReadonlyToolProjection();
  const sessionElevationStore = new SessionPermissionElevationStore({
    baseDirectory: stateDirectory,
  });
  const sessionElevationController = new SessionPermissionElevationController(
    sessionElevationStore,
  );
  const sessionElevationResolver = new EffectiveSecondaryPermissionResolver();
  const sessionExporter = new CurrentPermissionConfigurationExporter();
  const sessionShutdownCoordinator = new SessionShutdownCoordinator({
    elevationStore: sessionElevationStore,
    backupPort: backupVault,
  });
  // B6R-09：Agent 注册目录（报告来源认证）+ 主 Agent 报告索引 + 提案控制面
  const registeredAgentDirectory = new RegisteredAgentDirectory();
  const reportArchiveIngestor = new MainAgentReportArchiveIngestor({
    baseDirectory: stateDirectory,
    sourceAuthenticationPort: {
      verifySource: (input) =>
        Promise.resolve(registeredAgentDirectory.verifyReportSource(input)),
    },
  });
  const conversationTaskInsertionController = new ConversationTaskInsertionController({
    manageController: new (await import(
      "../../../core/src/orchestration/task-sequence-controllers.js"
    )).TaskSequenceManageController(
      new (await import(
        "../../../core/src/orchestration/agent-task-sequence-store.js"
      )).AgentTaskSequenceStore({ baseDirectory: stateDirectory }),
    ),
    authenticatedUserId: "cli-user",
  });
  // B6R-09：次级持续调度循环（生产装配；派发链回调由编排层注入）
  const dispatchRegistry = new UnboundedAgentInstanceRegistry({
    maxConcurrentSlots: 4,
    maxQueueLength: 32,
    currentOccupiedSlots: () => 0,
  });
  const secondaryDispatchLoop = new SecondaryContinuousDispatchLoop({
    registry: dispatchRegistry,
    dispatchChain: async () => false,
    currentOccupiedSlots: () => 0,
  });
  // B6R-09：三级生命周期控制器（阶段持久化 + 幂等收口；hooks 由编排层注入）
  const tertiaryLifecyclePhaseStore = new FileTertiaryLifecyclePhaseStore(stateDirectory);
  const tertiaryLifecycleController = new TertiaryAgentLifecycleController(
    {},
    { phaseStore: tertiaryLifecyclePhaseStore },
  );
  // B6R-09：个体记忆域 + 跨 Agent 附件控制器（Worker 运行时组件；生产装配）
  const agentIndividualMemoryStore = new AgentIndividualMemoryStore({
    baseDirectory: stateDirectory,
  });
  const crossAgentAttachmentController = new CrossAgentContextAttachmentController();
  const tertiaryRuntimeComponents = {
    individualMemoryStore: agentIndividualMemoryStore,
    attachmentController: crossAgentAttachmentController,
    lifecycleController: tertiaryLifecycleController,
  };

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
    permissionProfileStore,
    permissionCapabilityCatalog: permissionCatalog,
    currentPermissionSelectionStore,
    currentPermissionProfileReference,
    mainAgentReadonlyProjection,
    sessionElevationStore,
    sessionElevationController,
    sessionElevationResolver,
    sessionExporter,
    sessionShutdownCoordinator,
    registeredAgentDirectory,
    reportArchiveIngestor,
    conversationTaskInsertionController,
    secondaryDispatchLoop,
    tertiaryLifecycleController,
    tertiaryRuntimeComponents,
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
        configurablePermissionPolicyEngine,
        currentPermissionProfileReference,
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
