/**
 * 公共应用运行时装配（T07D-R1-01）：CLI/TUI/SDK 共用同一装配入口。
 * 交互端口由界面层注入；本模块不依赖 TUI/GUI（依赖方向：core 不反向依赖界面）。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ModeMachine } from "../core/mode-machine.js";
import { SessionAuthorizationManager } from "../core/permission-policy.js";
import { PermissionDecider } from "../core/permission-policy.js";
import { TaskStore } from "../infra/task-store.js";
import { MissionLeaseStore } from "../infra/mission-lease-store.js";
import { ToolRegistry } from "../tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../tools/builtins.js";
import { PolicyWrapper } from "../tools/policy-wrapper.js";
import { WorkspaceBoundary } from "../tools/workspace-boundary.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { MainController } from "../orchestration/main-controller.js";
import { MissionManager } from "../orchestration/mission-manager.js";
import { FeedbackProcessSupervisor } from "../feedback-process/process-supervisor.js";
import type { ForkFeedbackClient } from "../feedback-process/transport.js";
import type {
  AgentRuntime,
  TaskDependencyNode,
  ToolDescriptor,
} from "../core/types.js";
import type { BackupDeletionAuthorizationControlPort } from "../core/types.js";
import type { InstallationGateUserPort } from "../tools/installation-gate-guard.js";
import {
  BackupDeletionAuditLog,
  BackupDeletionAuthorizationController,
  BackupVault,
} from "../tools/backup-vault.js";
import { ProtectedStoragePolicy } from "../tools/protected-storage-policy.js";
import { AgentWorkArchiveStore } from "../orchestration/work-archive-store.js";
import { InstallationOperationClassifier } from "../tools/installation-operation-classifier.js";
import {
  AssistInstallationAuthorizationController,
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
} from "../tools/assist-installation-gate.js";
import { InstallationGateGuard } from "../tools/installation-gate-guard.js";
import { PermissionCapabilityCatalog } from "../tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../tools/permission-profile-store.js";
import { ConfigurablePermissionPolicyEngine } from "../tools/configurable-permission-policy-engine.js";
import { CurrentPermissionSelectionStore } from "../tools/current-permission-selection.js";
import { MainAgentReadonlyToolProjection } from "../tools/main-agent-readonly-projection.js";
import {
  EffectiveSecondaryPermissionResolver,
  SessionPermissionElevationController,
  SessionPermissionElevationStore,
} from "../tools/session-permission-elevation.js";
import {
  CurrentPermissionConfigurationExporter,
  SessionShutdownCoordinator,
} from "../tools/session-shutdown-and-export.js";
import { RegisteredAgentDirectory } from "../orchestration/registered-agent-directory.js";
import { MainAgentReportArchiveIngestor } from "../orchestration/main-agent-report-archive.js";
import { ConversationTaskInsertionController } from "../orchestration/conversation-task-insertion-controller.js";
import { UnboundedAgentInstanceRegistry } from "../orchestration/unbounded-agent-registry.js";
import { SecondaryContinuousDispatchLoop } from "../orchestration/secondary-continuous-dispatch-loop.js";
import {
  FileTertiaryLifecyclePhaseStore,
  TertiaryAgentLifecycleController,
} from "../orchestration/tertiary-lifecycle.js";
import { AgentIndividualMemoryStore } from "../orchestration/agent-individual-memory.js";
import { CrossAgentContextAttachmentController } from "../orchestration/cross-agent-attachment-controller.js";
import { GlobalDecisionStore } from "../orchestration/global-decision-store.js";
import { GlobalContextBudgetStore } from "../orchestration/global-context-budget-store.js";
import { ContextClosureCapsuleStore } from "../orchestration/context-closure-capsule-store.js";
import {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "../orchestration/human-verification-controller.js";
import { ContextNodeLifecycleController } from "../orchestration/context-node-lifecycle.js";
import { LocalContextGraphStore } from "../orchestration/local-context-graph-store.js";
import {
  createContextPromptProvider,
  type ContextPromptProvider,
  type NecessaryContextCondition,
} from "../orchestration/context-prompt-assembler.js";

export interface ApplicationRuntime {
  controller: MainController;
  missionManager: MissionManager;
  taskStore: TaskStore;
  supervisor: FeedbackProcessSupervisor | null;
  feedbackClient: ForkFeedbackClient | null;
  /** T12-02：跨进程 mission 活动租约（CLI 并发门禁与编排会话共用）。 */
  missionLeaseStore: MissionLeaseStore;
  /** T12-02：本 CLI 进程不可复用实例标识。 */
  processInstanceId: string;
  /** 权威执行结果摘要（来自 Agent 工作存档的 result 条目；T07D-R1-03）。 */
  readMissionResultSummaries: (
    missionId: string,
  ) => Promise<Array<{ taskId: string | null; entryType: string; summary: string }>>;
  shutdown: () => Promise<void>;
}

export interface ApplicationRuntimeOptions {
  mode: "ponder" | "assist" | "devolve";
  stateDirectory: string;
  concurrency: number;
  failureThreshold: number;
  maxLoopIterations: number;
  /** 是否启动独立反馈进程（headless 单命令场景可关闭）。 */
  useFeedbackProcess: boolean;
  streamOutput: (missionId: string | null, text: string) => void;
  /** 备份删除交互端口（界面层注入；null 表示无交互通道，fail-closed）。 */
  backupDeletionControlPort?: BackupDeletionAuthorizationControlPort | null;
  /** 安装门禁交互端口（界面层注入；null 表示无交互通道，fail-closed）。 */
  installationUserPort?: InstallationGateUserPort | null;
  /** 认证用户标识（可信本地 harness 注入）。 */
  authenticatedUserId?: string;
  /** 主 Agent 实例标识（报告/摘要路由用）。 */
  mainAgentInstanceId?: string;
  /** 独立反馈进程入口路径；不传则使用 supervisor 默认解析。 */
  feedbackProcessModulePath?: string | null;
  /** 主 Agent 运行时工厂覆盖（Provider 接线；缺省为 mock ScriptedRuntime）。 */
  mainRuntimeFactory?: (agentInstanceId: string) => AgentRuntime;
  /** Worker 运行时工厂覆盖（Provider 接线；缺省为 mock ScriptedRuntime）。 */
  workerRuntimeFactory?: (
    agentInstanceId: string,
    task: TaskDependencyNode,
  ) => AgentRuntime;
  /** T07D-R2-03：Provider 运行时强制要求本地完成控制事件（mock 默认关闭）。 */
  requireCompletionControlEvent?: boolean;
  /** T09A-R1-01：全局上下文预算（token，默认 4096）。 */
  globalContextBudgetTokens?: number;
  /** T09A-R1-01：任务必要条件；不满足时阻塞而非静默执行。 */
  mandatoryContextConditions?: NecessaryContextCondition[];
  /** T09A-R1-01：上下文提示词装配提供者覆盖（测试/嵌入用）。 */
  contextPromptProvider?: ContextPromptProvider;
  /** T09A-R1-02：Provider 可用输入空间（token）；缺省不缩减。 */
  modelInputSpaceTokens?: number | null;
}

export async function createApplicationRuntime(
  options: ApplicationRuntimeOptions,
): Promise<ApplicationRuntime> {
  const stateDirectory = options.stateDirectory;
  const processInstanceId = `process-${randomUUID()}`;
  const missionLeaseStore = new MissionLeaseStore({ stateDirectory });
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
      modulePath: options.feedbackProcessModulePath ?? undefined,
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
  const backupDeletionControlPort = options.backupDeletionControlPort ?? null;
  const backupDeletionController = new BackupDeletionAuthorizationController({
    mode: () => modeMachine.getCurrentMode(),
    controlPort: backupDeletionControlPort,
    auditLog: backupDeletionAuditLog,
    readCurrentVaultRevision: () => backupVault.getManifestRevision(),
  });
  // T05A：Agent 工作存档
  // T07D-R2-03：结果条目落盘即时入内存索引，避免终态先于存档可见的竞态。
  const inMemoryResultSummariesByMission = new Map<
    string,
    Array<{ taskId: string | null; entryType: string; summary: string }>
  >();
  const workArchiveStore = new AgentWorkArchiveStore({
    baseDirectory: stateDirectory,
    onEntryAppended: ({ missionId, entry }) => {
      if (entry.entryType !== "result" || entry.summary.length === 0) {
        return;
      }
      const existing = inMemoryResultSummariesByMission.get(missionId) ?? [];
      existing.push({
        taskId: entry.taskId,
        entryType: entry.entryType,
        summary: entry.summary,
      });
      inMemoryResultSummariesByMission.set(missionId, existing);
    },
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
  const installationUserPort = options.installationUserPort ?? null;
  const installationGateGuard = new InstallationGateGuard({
    classifier: installationClassifier,
    inquiryController: installationInquiryController,
    authorizationController: installationAuthorizationController,
    userPort: installationUserPort,
    authenticatedUserId: options.authenticatedUserId ?? "local-user",
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
      "../orchestration/task-sequence-controllers.js"
    )).TaskSequenceManageController(
      new (await import(
        "../orchestration/agent-task-sequence-store.js"
      )).AgentTaskSequenceStore({ baseDirectory: stateDirectory }),
    ),
    authenticatedUserId: options.authenticatedUserId ?? "local-user",
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
  // T08C-07：四层路由控制面装配（直投/摘要/侦察/任命裁决/四级；CLI/TUI/GUI 共用）
  const { SmallTaskEligibilityPolicy } = await import(
    "../orchestration/small-task-eligibility-policy.js"
  );
  const { DirectDispatchController } = await import(
    "../orchestration/direct-dispatch-controller.js"
  );
  const { SecondaryUserFacingSummaryController } = await import(
    "../orchestration/secondary-user-facing-summary-controller.js"
  );
  const { ProjectReconnaissanceDigestStore } = await import(
    "../orchestration/project-reconnaissance-digest-store.js"
  );
  const { ProjectReconnaissanceController } = await import(
    "../orchestration/project-reconnaissance-controller.js"
  );
  const { AgentAppointmentRegistry } = await import(
    "../orchestration/agent-appointment-registry.js"
  );
  const { AcceptanceVerdictGate } = await import(
    "../orchestration/acceptance-verdict-gate.js"
  );
  const { QuaternaryLifecycleController } = await import(
    "../orchestration/quaternary-lifecycle-controller.js"
  );
  const { QuaternaryGitBranchPolicy } = await import(
    "../orchestration/quaternary-boundary-guards.js"
  );
  const sequenceManageController = new (await import(
    "../orchestration/task-sequence-controllers.js"
  )).TaskSequenceManageController(
    new (await import(
      "../orchestration/agent-task-sequence-store.js"
    )).AgentTaskSequenceStore({ baseDirectory: stateDirectory }),
  );
  const directDispatchController = new DirectDispatchController({
    authenticatedUserId: "cli-user",
    eligibilityPolicy: new SmallTaskEligibilityPolicy(),
    sequenceManageController,
    doesSecondaryAgentExist: (agentInstanceId) =>
      registeredAgentDirectory.verifyReportSource({
        reportingAgentInstanceId: agentInstanceId,
        missionId: "mission-cli",
        taskBundleId: "bundle-cli",
      }).valid,
  });
  const t08cSummaryController = new SecondaryUserFacingSummaryController({
    authenticatedMainAgentInstanceId: options.mainAgentInstanceId ?? "main-agent",
    reportIndexPort: {
      insertSummaryEntry: async () => undefined,
    },
    sourceAuthenticationPort: {
      isRegisteredSecondary: async (agentInstanceId) =>
        registeredAgentDirectory.verifyReportSource({
          reportingAgentInstanceId: agentInstanceId,
          missionId: "mission-cli",
          taskBundleId: "bundle-cli",
        }).valid,
    },
    detailQueryPort: {
      requestDetail: async () => ({ kind: "unknown", reason: "CLI 未连接具体次级" }),
    },
  });
  const reconnaissanceDigestStore = new ProjectReconnaissanceDigestStore({
    baseDirectory: stateDirectory,
  });
  const reconnaissanceController = new ProjectReconnaissanceController({
    digestStore: reconnaissanceDigestStore,
    sensitivePathMatchPort: {
      matchSensitivePathName: (filePath) =>
        filePath.includes(".env") || filePath.includes("credential")
          ? "sensitive-path"
          : null,
    },
    sourceAuthenticationPort: {
      isRegisteredReconnaissance: async (agentInstanceId) =>
        registeredAgentDirectory.verifyReportSource({
          reportingAgentInstanceId: agentInstanceId,
          missionId: "mission-cli",
          taskBundleId: "bundle-cli",
        }).valid,
    },
  });
  const appointmentRegistry = new AgentAppointmentRegistry();
  const acceptanceVerdictGate = new AcceptanceVerdictGate({
    appointmentRegistry,
  });
  const quaternaryLifecycleController = new QuaternaryLifecycleController({
    isTertiaryAgentActive: () => true,
  });
  const quaternaryGitBranchPolicy = new QuaternaryGitBranchPolicy();
  const t08cRoutingFacade = {
    directDispatchController,
    secondarySummaryController: t08cSummaryController,
    reconnaissanceController,
    appointmentRegistry,
    acceptanceVerdictGate,
    quaternaryLifecycleController,
    quaternaryGitBranchPolicy,
  };

  const globalDecisionStore = new GlobalDecisionStore({
    baseDirectory: stateDirectory,
  });
  const contextGraphStore = new LocalContextGraphStore({
    baseDirectory: stateDirectory,
  });
  const globalContextBudgetStore = new GlobalContextBudgetStore({
    baseDirectory: stateDirectory,
  });
  // T09A-R1-03：任务完成后的节点收口（节点 → 验证 → 关闭/等待 → 胶囊 → 核验任务）。
  const contextClosureCapsuleStore = new ContextClosureCapsuleStore({
    baseDirectory: stateDirectory,
  });
  const humanVerificationController = new HumanVerificationController({
    baseDirectory: stateDirectory,
    graphStore: contextGraphStore,
    globalDecisionStore,
  });
  const humanVerificationPolicyStore = new HumanVerificationPolicyStore({
    baseDirectory: stateDirectory,
  });
  const contextNodeLifecycle = new ContextNodeLifecycleController({
    graphStore: contextGraphStore,
    capsuleStore: contextClosureCapsuleStore,
    humanVerificationController,
    humanVerificationPolicyStore,
  });
  const contextPromptProvider =
    options.contextPromptProvider ??
    createContextPromptProvider({
      globalDecisionStore,
      graphStore: contextGraphStore,
      maximumGlobalContextTokenCount: options.globalContextBudgetTokens ?? 4096,
      mandatoryConditions: options.mandatoryContextConditions,
      budgetPolicyProvider: () => globalContextBudgetStore.readPolicy(),
      modelInputSpaceTokens: options.modelInputSpaceTokens,
    });

  const controller = new MainController({
    modeMachine,
    sessionManager,
    taskStore,
    missionManager,
    registry,
    missionLeaseStore,
    processInstanceId,
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
    t08cRoutingFacade,
    mainRuntimeFactory:
      options.mainRuntimeFactory ??
      (() =>
        new ScriptedRuntime([
          {
            type: "text",
            text: "（主 Agent 应答）任务已受理。",
          },
          { type: "finish", reason: "success", detail: "受理完成" },
        ])),
    workerRuntimeFactory:
      options.workerRuntimeFactory ??
      (() =>
        new ScriptedRuntime([
          { type: "text", text: "（mock 执行器）" },
          { type: "finish", reason: "success", detail: "任务完成" },
        ])),
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
    resolveToolDescriptors: (task: TaskDependencyNode): ToolDescriptor[] =>
      task.toolNames
        .map((toolName) => registry.getDescriptor(toolName))
        .filter((descriptor): descriptor is ToolDescriptor => descriptor !== undefined),
    requireCompletionControlEvent: options.requireCompletionControlEvent ?? false,
    contextPromptProvider,
    contextNodeLifecycle,
    streamOutput: options.streamOutput,
  });

  const shutdown = async (): Promise<void> => {
    // T07D-R1-03：先收敛在途编排（取消并等待 Worker/循环），再释放反馈进程资源。
    await controller.shutdown().catch(() => {});
    await feedbackClient?.shutdown().catch(() => {});
    await supervisor?.stop().catch(() => {});
  };

  const readMissionResultSummaries = async (
    missionId: string,
  ): Promise<Array<{ taskId: string | null; entryType: string; summary: string }>> => {
    const inMemory = inMemoryResultSummariesByMission.get(missionId);
    if (inMemory !== undefined && inMemory.length > 0) {
      return [...inMemory];
    }
    const agentInstanceIds = await workArchiveStore.listAgentIdsWithArchive(missionId);
    const summaries: Array<{ taskId: string | null; entryType: string; summary: string }> = [];
    for (const agentInstanceId of agentInstanceIds) {
      const archive = await workArchiveStore
        .readArchive(missionId, agentInstanceId)
        .catch(() => null);
      if (archive === null) {
        continue;
      }
      for (const entry of archive.entries) {
        if (entry.entryType === "result") {
          summaries.push({
            taskId: entry.taskId,
            entryType: entry.entryType,
            summary: entry.summary,
          });
        }
      }
    }
    return summaries;
  };

  return {
    controller,
    missionManager,
    taskStore,
    supervisor,
    feedbackClient,
    missionLeaseStore,
    processInstanceId,
    readMissionResultSummaries,
    shutdown,
  };
}

import type { FeedbackTransportPort } from "../core/types.js";

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
