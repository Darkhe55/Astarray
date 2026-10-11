/**
 * TOOLKIT-01-06 **包级验收**：工具包能力（配方/登记/推广/版本/隔离/转换器）在
 * **tarball 隔离安装**后必须真实可用。
 *
 * AGENTS.md：「打包验收必须以 tarball 隔离安装为准。」
 * 检查点 06 要求"共用 SDK 与 CLI/TUI/GUI 最小管理入口、**tarball 隔离包闭环**、收益评估"。
 *
 * 流程：
 *  1. `npm pack --ignore-scripts` 生成 tarball（`--run-prepack` 可显式开启 prepack）；
 *  2. 在 `.tmp/toolkit-package-acceptance/<runId>/install` **隔离安装**；
 *  3. 用**已安装包的公共 SDK**跑一份探针，实测各能力并收集**观测**；
 *  4. 判定交给纯函数模块 `scripts/lib/toolkit01-package-checks.mjs`
 *     （可单测的不变量；**缺省即失败**，不会"零判据通过"）；
 *  5. 写出 acceptance-verdict.json（含 tarball sha256、字节数、来源提交，可审计）。
 *
 * 纪律：本脚本**不申请任何权限、不联网、不使用 Provider 凭据**；
 * 探针只使用显式输入与本地临时目录。
 *
 * 用法：
 *   node scripts/verify-toolkit-package.mjs
 *   node scripts/verify-toolkit-package.mjs --run-prepack
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

import {
  installTarballIsolated,
  packTarball,
  readSourceCommit,
} from "./lib/package-acceptance-runtime.mjs";
import {
  buildToolkitPackageChecks,
  summarizeToolkitPackageChecks,
} from "./lib/toolkit01-package-checks.mjs";

const repositoryRoot = process.cwd();
const verificationRunIdentifier = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceRoot = path.join(
  repositoryRoot,
  ".tmp",
  "toolkit-package-acceptance",
  verificationRunIdentifier,
);
const installRoot = path.join(acceptanceRoot, "install");
const packageArchiveRoot = path.join(acceptanceRoot, "packages");
const shouldRunPrepack = process.argv.includes("--run-prepack");

console.log("=== TOOLKIT-01-06 包级验收：工具包能力（tarball 隔离安装）===");

const tarball = packTarball({
  archiveDirectory: packageArchiveRoot,
  shouldRunPrepack,
});
const sourceCommit = readSourceCommit();
console.log("tarball: " + tarball.tarballFileName);
console.log("sha256 : " + tarball.tarballSha256);
console.log("bytes  : " + String(tarball.tarballByteCount));
console.log("commit : " + sourceCommit);

const cliEntryPath = installTarballIsolated({
  installDirectory: installRoot,
  tarballPath: tarball.tarballPath,
  packageName: "toolkit-package-acceptance",
});
const installedPackageRoot = path.dirname(path.dirname(cliEntryPath));
const installedSdkPath = path.join(installedPackageRoot, "dist", "public-sdk.js");

/**
 * 探针源码：只用**已安装包**的公共 SDK 与显式输入，收集观测并打印 JSON。
 *
 * 探针里的每个字段都对应 `toolkit01-package-checks.mjs` 的一条判据；
 * 任何未取到的观测保持 `undefined`（判据侧 fail-closed）。
 */
const probeSource = `
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const sdk = await import(__INSTALLED_SDK_PATH__);
const observation = {};

/* ── 公开入口可达 ── */
observation.publicEntryExports = {};
for (const name of [
  "RecipeExecutionEngine",
  "createRecipeLifecycle",
  "ToolPackageRegistry",
  "ToolPackageVersionController",
  "ToolPackageVersionStateStore",
  "evaluateProgramToolEnablement",
  "DETERMINISTIC_CSV_TO_JSON_CONVERTER",
  "runDeterministicProgramTool",
  // NODECTX-01（与 MERGE-01 同卡）：无损上下文与可见性展示必须同样可达。
  "createLosslessContextManager",
  "buildContextVisibilityDisplayRows",
  "createLosslessContextManager",
  "evaluateParameterAuthorizationSettingChange",
  "evaluateInstructionMergeEligibility",
]) {
  observation.publicEntryExports[name] = typeof sdk[name] !== "undefined";
}

const hash = (character) => "sha256:" + character.repeat(64);
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-pkg-probe-"));

try {
  /* ── 配方：定义校验 + 真实执行 + 独立验证 ── */
  const recipe = {
    recipeIdentifier: "read-then-list",
    version: 1,
    declaredInputNames: ["filePath", "directoryPath"],
    usedToolReferences: [
      { toolId: "readFile", toolRevision: 1 },
      { toolId: "listDirectory", toolRevision: 1 },
    ],
    steps: [
      {
        stepIdentifier: "step-read",
        toolName: "readFile",
        dependsOnStepIdentifiers: [],
        argumentMapping: { filePath: "$input.filePath" },
      },
      {
        stepIdentifier: "step-list",
        toolName: "listDirectory",
        dependsOnStepIdentifiers: ["step-read"],
        argumentMapping: { directoryPath: "$input.directoryPath" },
      },
    ],
  };
  const definitionValidation = sdk.validateRecipeDefinition(recipe);
  /** 故意构造一个环，确认校验真的会拒绝（而不是恒 true）。 */
  const cyclicValidation = sdk.validateRecipeDefinition({
    ...recipe,
    steps: [
      { ...recipe.steps[0], dependsOnStepIdentifiers: ["step-list"] },
      { ...recipe.steps[1], dependsOnStepIdentifiers: ["step-read"] },
    ],
  });

  /** 记录真实经过执行网关的工具名（用于证明"复用不是只 import"）。 */
  const gatewayCallLog = [];
  const toolPort = {
    async execute(toolName, argumentsJson) {
      gatewayCallLog.push(toolName);
      return {
        kind: "success",
        callId: "probe-" + String(gatewayCallLog.length),
        toolName,
        outputText: "probe-output:" + toolName + ":" + argumentsJson,
        isSideEffectFree: true,
      };
    },
  };
  const engine = new sdk.RecipeExecutionEngine({ toolPort });
  const executionOutcome = await engine.execute({
    recipe,
    input: { filePath: "sample.txt", directoryPath: "." },
    cancellationSignal: new AbortController().signal,
  });

  /** 生命周期：作者自验必须被拒；独立验证须真实执行全部声明工具。 */
  const lifecycle = sdk.createRecipeLifecycle();
  const draft = await lifecycle.submitRecipeDraft({
    recipe,
    authorAgentInstanceId: "agent-author",
    sourceProjectIdentifier: "project-alpha",
  });
  let rejectedSameAuthorValidation = false;
  try {
    await lifecycle.recordIndependentValidation({
      draftIdentifier: draft.draftIdentifier,
      validatorAgentInstanceId: "agent-author",
      executedToolNames: ["readFile", "listDirectory"],
      isExecutionSuccessful: true,
    });
  } catch {
    rejectedSameAuthorValidation = true;
  }
  let isValidationAccepted = false;
  let validatorDiffersFromAuthor = false;
  try {
    const validated = await lifecycle.recordIndependentValidation({
      draftIdentifier: draft.draftIdentifier,
      validatorAgentInstanceId: "agent-validator",
      executedToolNames: gatewayCallLog,
      isExecutionSuccessful: true,
    });
    isValidationAccepted = validated.status === "validated";
    validatorDiffersFromAuthor = validated.validatorAgentInstanceId === "agent-validator";
  } catch {
    isValidationAccepted = false;
  }
  await lifecycle.registerAndEnable({
    draftIdentifier: draft.draftIdentifier,
    toolPackageId: "read-then-list",
    version: 1,
    contentHash: hash("e"),
  });
  const discoverableInSource = lifecycle.listDiscoverableRecipes({
    projectIdentifier: "project-alpha",
  });
  const discoverableInOther = lifecycle.listDiscoverableRecipes({
    projectIdentifier: "project-beta",
  });
  const otherProjectExecution = await lifecycle.executeRegisteredRecipe({
    toolPackageId: "read-then-list",
    version: 1,
    projectIdentifier: "project-beta",
    input: { filePath: "sample.txt", directoryPath: "." },
    cancellationSignal: new AbortController().signal,
    recipeExecutionEngine: engine,
    recipe,
  });

  observation.recipe = {
    isDefinitionValid:
      definitionValidation.isValid === true && cyclicValidation.isValid === false,
    resolvedToolNames: recipe.usedToolReferences.map((reference) => reference.toolId),
    executedToolNames: gatewayCallLog,
    isExecutionSuccessful:
      executionOutcome.isSuccessful === true &&
      executionOutcome.stepReceipts.every((receipt) => receipt.status === "succeeded"),
    validatorDiffersFromAuthor,
    isValidationAccepted,
    rejectedSameAuthorValidation,
    isReuseProvenNotImportOnly:
      recipe.usedToolReferences.every((reference) =>
        gatewayCallLog.includes(reference.toolId),
      ),
  };

  /* ── 登记与作用域 ── */
  const registry = new sdk.ToolPackageRegistry();
  const baseRegistration = {
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
    schemaVersion: "ASTRAY_TOOL_PACKAGE_V1",
    packageKind: "recipe",
    readableName: "测试报告格式化",
    purposeSummary: "整理测试报告",
    applicableConditions: [],
    sourceProjectIdentifier: "project-alpha",
    generatorAgentInstanceId: "agent-gen-1",
    acceptorAgentInstanceId: "agent-acc-1",
    evidenceReferences: [],
    supportedActions: ["read"],
    scope: "project",
  };
  registry.register(baseRegistration);
  const byIdentity = registry.resolveByIdentity({
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
  });
  const byReadableName = registry.resolveByReadableName("测试报告格式化");
  let immutabilityEnforced = false;
  try {
    registry.register({ ...baseRegistration, contentHash: hash("b") });
  } catch {
    immutabilityEnforced = true;
  }
  registry.enable({
    toolPackageId: "report-formatter",
    version: 1,
    targetProjectIdentifier: "project-alpha",
  });
  const discoveredInOtherProject = registry.listDiscoverable({
    projectIdentifier: "project-beta",
  });
  const executedFromOtherProject = registry.resolveForExecution({
    toolPackageId: "report-formatter",
    version: 1,
    projectIdentifier: "project-beta",
  });

  observation.registry = {
    resolveByIdentityWorks:
      byIdentity !== null && byIdentity.toolPackageId === "report-formatter",
    resolveByReadableNameIsNull: byReadableName === null,
    immutabilityEnforced,
    otherProjectCannotDiscover: discoveredInOtherProject.length === 0,
    otherProjectCannotExecute: executedFromOtherProject === null,
  };

  /* ── 推广（去项目化 / 敏感内容 / 批准不启用） ── */
  const sourcePackage = {
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
    sourceProjectIdentifier: "project-alpha",
    generalLogic: { steps: ["parse", "format"] },
    projectAdaptations: { "project-alpha": { testFramework: "vitest" } },
    userPreferences: { language: "zh-CN" },
  };
  const candidate = sdk.createPromotionCandidate({
    sourcePackage,
    targetScope: "user",
    reason: "多个项目重复使用",
  });
  const cleanCandidateValidation = sdk.validatePromotionCandidate({ candidate });
  const sensitiveCandidate = sdk.createPromotionCandidate({
    sourcePackage: {
      ...sourcePackage,
      generalLogic: { steps: ["curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop'"] },
    },
    targetScope: "user",
    reason: "敏感内容拦截",
  });
  const sensitiveValidation = sdk.validatePromotionCandidate({
    candidate: sensitiveCandidate,
  });
  const promotionDecision = sdk.applyPromotionDecision({
    candidate,
    decision: "approved",
    approvedByUserId: "user-1",
  });

  observation.promotion = {
    candidateStripsProjectAdaptations:
      cleanCandidateValidation.isValid === true &&
      Object.keys(candidate.projectAdaptations).length === 0,
    sensitiveContentRejected: sensitiveValidation.isValid === false,
    approvalDoesNotEnableAnyProject:
      promotionDecision.isApproved === true &&
      promotionDecision.enabledProjectIdentifiers.length === 0,
  };

  /* ── 版本：重新授权 / 不可旁路 / 回滚保留历史 ── */
  const versionController = new sdk.ToolPackageVersionController();
  versionController.registerVersion({
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none"],
    declaredDependencies: [],
    permissionRequirements: [],
  });
  versionController.registerVersion({
    toolPackageId: "report-formatter",
    version: 2,
    contentHash: hash("b"),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none", "file-write"],
    declaredDependencies: [],
    permissionRequirements: [],
  });
  versionController.lockProjectToVersion({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
  });
  versionController.enableForProject({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    version: 1,
  });
  const unauthorizedUpgrade = versionController.upgradeProjectVersion({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    toVersion: 2,
    isReauthorized: false,
  });
  let bypassAttemptRejected = false;
  try {
    versionController.recordPendingVersionSwitch({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      intendedVersion: 2,
      intendedContentHash: hash("b"),
    });
    const bypass = versionController.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 2,
    });
    bypassAttemptRejected = bypass.isApplied === false;
  } catch {
    bypassAttemptRejected = true;
  }
  versionController.recordCompletedCall({
    runIdentifier: "run-history",
    stepIdentifier: "step-1",
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    version: 1,
    argumentHash: hash("d"),
    producedArtifacts: [],
  });
  const rollback = versionController.rollbackProjectVersion({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    toVersion: 1,
  });

  observation.version = {
    reauthorizationRequiredForNewSideEffect: unauthorizedUpgrade.isApplied === false,
    reauthorizationGateNotBypassable: bypassAttemptRejected,
    rollbackKeepsHistory:
      rollback.isApplied === true &&
      versionController.listCallHistory({ projectIdentifier: "project-alpha" }).length > 0,
  };


  /* ── NODECTX-01：无损上下文与"不把不在上下文显示成删除" ── */
  const losslessManager = sdk.createLosslessContextManager({
    stagingDirectory: path.join(stateDirectory, "nodectx-staging"),
    maximumMigrationsPerRound: 4,
  });
  let diskFailureKeepsStateUnchanged = false;
  try {
    losslessManager.setStagingWriterForTesting(async () => {
      throw new Error("模拟磁盘已满");
    });
    const failedStage = await losslessManager.stageNode({
      nodeIdentifier: "probe-node-disk-fail",
      revision: 1,
      sourceKind: "agent",
      priorityTier: 1,
      contentText: "原文",
      isUrgent: false,
      isImportant: false,
      isNeededForCurrentExecution: false,
      toolCallIdentifier: null,
      dependencyNodeIdentifiers: [],
    });
    diskFailureKeepsStateUnchanged =
      failedStage.isStaged === false &&
      losslessManager.getVisibilityState("probe-node-disk-fail") === "active" &&
      losslessManager.listStagedNodeIdentifiers().length === 0;
  } catch {
    diskFailureKeepsStateUnchanged = false;
  }

  /** 配对保护：登记调用/结果两侧后，单独暂存调用侧必须被拒。 */
  let toolPairIsAtomic = false;
  try {
    const pairManager = sdk.createLosslessContextManager({
      stagingDirectory: path.join(stateDirectory, "nodectx-pair"),
      maximumMigrationsPerRound: 4,
    });
    const callNode = {
      nodeIdentifier: "probe-call",
      revision: 1,
      sourceKind: "tool",
      priorityTier: 1,
      contentText: "调用",
      isUrgent: false,
      isImportant: false,
      isNeededForCurrentExecution: false,
      toolCallIdentifier: "probe-call-id",
      dependencyNodeIdentifiers: [],
    };
    const resultNode = { ...callNode, nodeIdentifier: "probe-result", toolCallIdentifier: null };
    pairManager.registerNode(callNode);
    pairManager.registerNode(resultNode);
    pairManager.registerToolPair({
      toolCallIdentifier: "probe-call-id",
      toolCallNodeIdentifier: "probe-call",
      toolResultNodeIdentifier: "probe-result",
    });
    const partial = await pairManager.stageNode(callNode);
    const paired = await pairManager.stageNodePair({ toolCallIdentifier: "probe-call-id" });
    toolPairIsAtomic =
      partial.isStaged === false &&
      paired.isStaged === true &&
      pairManager.getVisibilityState("probe-call") === "temporarily-closed" &&
      pairManager.getVisibilityState("probe-result") === "temporarily-closed";
  } catch {
    toolPairIsAtomic = false;
  }

  /**
   * NODECTX-01：**重启恢复**实测 —— 同一暂存目录下另建管理器（不共享内存）后仅凭磁盘恢复，
   * 可见性与原文都必须回来。
   */
  let isStateRestoredAcrossRestart = false;
  let isOriginalContentBytesIdenticalAfterRestart = false;
  try {
    const restartStagingDirectory = path.join(stateDirectory, "nodectx-restart");
    const stagingManager = sdk.createLosslessContextManager({
      stagingDirectory: restartStagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    await stagingManager.stageNode({
      nodeIdentifier: "probe-restart-node",
      revision: 7,
      sourceKind: "agent",
      priorityTier: 1,
      contentText: "跨重启必须逐字节保留的原文",
      isUrgent: false,
      isImportant: false,
      isNeededForCurrentExecution: false,
      toolCallIdentifier: null,
      dependencyNodeIdentifiers: [],
    });
    // 全新管理器（不共享任何内存状态），仅凭磁盘恢复。
    const restartedManager = sdk.createLosslessContextManager({
      stagingDirectory: restartStagingDirectory,
      maximumMigrationsPerRound: 4,
    });
    const restoreOutcome = await restartedManager.restoreFromDisk();
    const restoredContent = await restartedManager.readStagedContent("probe-restart-node");
    isStateRestoredAcrossRestart =
      restoreOutcome.isRestored === true &&
      restoreOutcome.restoredNodeCount === 1 &&
      restartedManager.getVisibilityState("probe-restart-node") === "temporarily-closed";
    isOriginalContentBytesIdenticalAfterRestart =
      restoredContent === "跨重启必须逐字节保留的原文";
  } catch {
    isStateRestoredAcrossRestart = false;
    isOriginalContentBytesIdenticalAfterRestart = false;
  }

  /**
   * MERGE-01 §1.3：**真实驱动**设置变更判定 —— 关闭细分使 deny 规则失效即为放宽，
   * 未确认必须被拒；判定本身不得产生副作用。
   */
  let parameterAuthorization = {
    isWideningDetected: false,
    isUnconfirmedWideningRejected: false,
    isRejectionSideEffectFree: false,
  };
  try {
    const wideningOutcome = sdk.evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: false,
      },
      tools: [
        {
          toolName: "readFile",
          unifiedEffect: "allow",
          ruleEffects: [{ ruleIdentifier: "rule-deny-secrets", effect: "deny" }],
        },
      ],
      isConfirmedByAuthenticatedUser: false,
      configurationRevision: 3,
      effectiveRevision: 3,
    });
    parameterAuthorization = {
      isWideningDetected: wideningOutcome.widenedPermissions.length > 0,
      isUnconfirmedWideningRejected: wideningOutcome.isAccepted === false,
      /** 被拒时**不得推进任何 revision**（不得半生效）。 */
      isRejectionSideEffectFree:
        wideningOutcome.configurationRevision === 3 && wideningOutcome.effectiveRevision === 3,
    };
  } catch {
    parameterAuthorization = {
      isWideningDetected: false,
      isUnconfirmedWideningRejected: false,
      isRejectionSideEffectFree: false,
    };
  }

  /**
   * MERGE-01-02：**真实驱动**确定性合并资格判定 —— 开关初始关闭（不合并但不丢原指令）、
   * 跨项目被拒、结果映射回原 ID、安全点拆回只动未执行项且不重放副作用。
   */
  let instructionMerge = {
    isSwitchInitiallyDisabled: false,
    isRetentionKeptWhenDisabled: false,
    isCrossProjectRejected: false,
    isResultMappedBackToOriginalIds: false,
    isSplitBackLimitedToUnexecuted: false,
    isSideEffectReplayed: true,
  };
  try {
    const buildMergeCandidate = (instructionIdentifier, overrides = {}) => ({
      instructionIdentifier,
      revision: 1,
      instructionText: "指令 " + instructionIdentifier,
      projectIdentifier: "probe-project",
      taskAuthorityIdentifier: "probe-authority",
      permissionScopeIdentifier: "probe-scope",
      goalIdentifier: "probe-goal",
      priorityTier: 0,
      supersedesInstructionIdentifiers: [],
      dependencyNodeIdentifiers: [],
      completedDependencyNodeIdentifiers: [],
      isSemanticallyConflicting: false,
      isGoalAmbiguous: false,
      requiresIndependentAuthorization: false,
      hasSideEffectInFlight: false,
      ...overrides,
    });
    const disabledOutcome = sdk.evaluateInstructionMergeEligibility({
      candidates: [buildMergeCandidate("probe-1"), buildMergeCandidate("probe-2")],
      isMergeEnabled: sdk.DEFAULT_INSTRUCTION_MERGE_SETTINGS.isMergeEnabled,
    });
    const crossProjectOutcome = sdk.evaluateInstructionMergeEligibility({
      candidates: [
        buildMergeCandidate("probe-1"),
        buildMergeCandidate("probe-2", { projectIdentifier: "other-project" }),
      ],
      isMergeEnabled: true,
    });
    const eligibleOutcome = sdk.evaluateInstructionMergeEligibility({
      candidates: [buildMergeCandidate("probe-1"), buildMergeCandidate("probe-2")],
      isMergeEnabled: true,
    });
    const splitOutcome = sdk.splitExecutionGroupAtSafetyPoint({
      groupIdentifier: "probe-group",
      members: [
        { instructionIdentifier: "probe-done", hasExecuted: true, hasSideEffectInFlight: false },
        { instructionIdentifier: "probe-pending", hasExecuted: false, hasSideEffectInFlight: false },
        { instructionIdentifier: "probe-inflight", hasExecuted: false, hasSideEffectInFlight: true },
      ],
    });
    instructionMerge = {
      isSwitchInitiallyDisabled:
        sdk.DEFAULT_INSTRUCTION_MERGE_SETTINGS.isMergeEnabled === false &&
        disabledOutcome.canMerge === false,
      isRetentionKeptWhenDisabled:
        disabledOutcome.retainedInstructionIdentifiers.length === 2,
      isCrossProjectRejected:
        crossProjectOutcome.canMerge === false &&
        crossProjectOutcome.rejectedInstructionIdentifiers.includes("probe-2"),
      isResultMappedBackToOriginalIds:
        eligibleOutcome.canMerge === true &&
        eligibleOutcome.resultMappingByInstructionIdentifier["probe-1"] === "probe-1" &&
        eligibleOutcome.resultMappingByInstructionIdentifier["probe-2"] === "probe-2",
      isSplitBackLimitedToUnexecuted:
        splitOutcome.splitBackInstructionIdentifiers.length === 1 &&
        splitOutcome.splitBackInstructionIdentifiers[0] === "probe-pending",
      isSideEffectReplayed: splitOutcome.isSideEffectReplayed,
    };
  } catch {
    instructionMerge = {
      isSwitchInitiallyDisabled: false,
      isRetentionKeptWhenDisabled: false,
      isCrossProjectRejected: false,
      isResultMappedBackToOriginalIds: false,
      isSplitBackLimitedToUnexecuted: false,
      isSideEffectReplayed: true,
    };
  }

  const displayRows = sdk.buildContextVisibilityDisplayRows([
    {
      nodeIdentifier: "probe-staged",
      visibilityState: "temporarily-closed",
      businessStatus: "pending",
      stagingReason: "当前不需要",
      isPendingRatification: false,
    },
    {
      nodeIdentifier: "probe-pending",
      visibilityState: "temporarily-closed",
      businessStatus: "completed",
      stagingReason: "等待核验",
      isPendingRatification: true,
    },
  ]);
  const deletionWords = ["删除", "已移除", "丢弃", "清除", "销毁"];
  observation.losslessContext = {
    isPromptAbsenceShownAsDeletion: displayRows.some((row) => row.isShownAsDeleted),
    isTextFreeOfDeletionWording: !displayRows.some((row) =>
      deletionWords.some((word) => row.displayText.includes(word)),
    ),
    isContentRetainedOnDisk: displayRows.every((row) => row.isContentRetainedOnDisk === true),
    diskFailureKeepsStateUnchanged,
    toolPairIsAtomic,
    pendingRatificationIsNotShownCompleted:
      displayRows.find((row) => row.nodeIdentifier === "probe-pending")?.isShownAsCompleted ===
      false,
    isStateRestoredAcrossRestart,
    isOriginalContentBytesIdenticalAfterRestart,
  };
  observation.parameterAuthorization = parameterAuthorization;
  observation.instructionMerge = instructionMerge;
  /* ── 隔离边界 ── */
  const basePlatform = {
    platformIdentifier: "probe-platform",
    hasEnforceableSandbox: true,
    hasControlledBroker: true,
    supportedCapabilities: [],
    maximumDependencyDepth: 4,
    maximumExecutionBudgetMilliseconds: 30000,
  };
  const baseDeclaration = {
    ...sdk.DETERMINISTIC_CSV_TO_JSON_CONVERTER,
  };
  const sensitiveDeclaration = {
    ...baseDeclaration,
    readOnlySelfDeclaration: false,
    requiredCapabilities: ["file-read"],
    declaredSideEffects: ["file-read"],
  };
  const readOnlyLie = sdk.evaluateProgramToolEnablement({
    declaration: { ...baseDeclaration, declaredSideEffects: ["file-read"], requiredCapabilities: ["file-read"] },
    platform: { ...basePlatform, supportedCapabilities: ["file-read"] },
  });
  const missingSandbox = sdk.evaluateProgramToolEnablement({
    declaration: sensitiveDeclaration,
    platform: { ...basePlatform, hasEnforceableSandbox: false, supportedCapabilities: ["file-read"] },
  });
  const missingBroker = sdk.evaluateProgramToolEnablement({
    declaration: sensitiveDeclaration,
    platform: { ...basePlatform, hasControlledBroker: false, supportedCapabilities: ["file-read"] },
  });
  const unsupportedPlatform = sdk.evaluateProgramToolEnablement({
    declaration: { ...sensitiveDeclaration, requiredCapabilities: ["network-access"], declaredSideEffects: ["network-access"] },
    platform: basePlatform,
  });

  observation.isolation = {
    readOnlySelfDeclarationNotTrusted: readOnlyLie.isEnabled === false,
    missingSandboxRejected: missingSandbox.isEnabled === false,
    missingBrokerRejected: missingBroker.isEnabled === false,
    unsupportedPlatformRejected:
      unsupportedPlatform.isEnabled === false &&
      unsupportedPlatform.unsupportedCapabilities.length > 0,
    arbitraryScriptFallbackDisallowed:
      unsupportedPlatform.isArbitraryScriptFallbackAllowed === false,
    recipeFallbackPreserved: unsupportedPlatform.fallbackPath === "recipe-only",
  };

  /* ── 真实转换器 ── */
  const conversionInput = "name,age\\nAlice,30\\n";
  const firstRun = await sdk.runDeterministicProgramTool({
    declaration: baseDeclaration,
    platform: basePlatform,
    inputText: conversionInput,
    cancellationSignal: new AbortController().signal,
  });
  const secondRun = await sdk.runDeterministicProgramTool({
    declaration: baseDeclaration,
    platform: basePlatform,
    inputText: conversionInput,
    cancellationSignal: new AbortController().signal,
  });
  const badRowRun = await sdk.runDeterministicProgramTool({
    declaration: baseDeclaration,
    platform: basePlatform,
    inputText: "a,b\\n1\\n",
    cancellationSignal: new AbortController().signal,
  });

  observation.converter = {
    gatePassed: firstRun.isEnabledByGate === true,
    conversionSucceeded: firstRun.isSucceeded === true,
    outputIsExpected:
      firstRun.outputText === JSON.stringify([{ name: "Alice", age: "30" }]),
    badRowRejected: badRowRun.isSucceeded === false,
    determinismVerified:
      firstRun.outputText !== null && firstRun.outputText === secondRun.outputText,
  };
} catch (error) {
  observation.probeFailure = String(error && error.message ? error.message : error);
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

process.stdout.write(JSON.stringify(observation));
`;

const probeFilePath = path.join(installRoot, "toolkit-probe.mjs");
writeFileSync(
  probeFilePath,
  probeSource.replace(
    "__INSTALLED_SDK_PATH__",
    JSON.stringify(pathToFileURL(installedSdkPath).href),
  ),
  "utf8",
);

let observation = {};
let probeExitCode = 0;
let probeStderrText = "";
try {
  const probeStdout = execFileSync(process.execPath, [probeFilePath], {
    cwd: installRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  observation = JSON.parse(probeStdout);
} catch (error) {
  probeExitCode = typeof error.status === "number" ? error.status : 1;
  probeStderrText =
    typeof error.stderr === "string" && error.stderr !== ""
      ? error.stderr
      : String(error && error.message ? error.message : error);
}

const checks = buildToolkitPackageChecks(observation);
const summary = summarizeToolkitPackageChecks(checks);

if (probeExitCode !== 0) {
  console.log("探针退出码非 0：" + String(probeExitCode));
  console.log(probeStderrText);
}

for (const check of checks) {
  console.log(
    (check.passed ? "  [通过] " : "  [失败] ") + check.name + (check.detail ? " — " + check.detail : ""),
  );
}

const verdictPath = path.join(acceptanceRoot, "acceptance-verdict.json");
mkdirSync(acceptanceRoot, { recursive: true });
writeFileSync(
  verdictPath,
  JSON.stringify(
    {
      taskIdentifier: "TOOLKIT-01-06",
      tarballFileName: tarball.tarballFileName,
      tarballSha256: tarball.tarballSha256,
      tarballByteCount: tarball.tarballByteCount,
      sourceCommit,
      probeExitCode,
      ...summary,
      checks,
      observation,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(
  "判据：" +
    String(summary.passedCheckCount) +
    "/" +
    String(summary.totalCheckCount) +
    (summary.isPassed ? "（全部通过）" : "（存在失败：" + summary.failedCheckNames.join("; ") + "）"),
);
console.log("验收记录：" + path.relative(repositoryRoot, verdictPath));

if (!summary.isPassed) {
  console.log("=== TOOLKIT-01-06 包级验收：失败 ===");
  process.exitCode = 1;
} else {
  console.log("=== TOOLKIT-01-06 包级验收：通过 ===");
  // 通过时清理隔离安装目录，避免累积（失败时保留现场便于定位）。
  rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(packageArchiveRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
