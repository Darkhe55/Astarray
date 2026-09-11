/**
 * 恢复中心控制器（T12A-R1-01）：recover 命令的真实调用链。
 *
 * - 列表/查询反映磁盘上的 mission 状态、损坏标记与租约；
 * - 损坏状态显式上报，绝不静默重建为“成功”；
 * - resume 依据最近可信检查点做本地确定性分类：存在阻塞项 → 返回可操作裁决项，
 *   否则真正把 mission 置为 running（不是固定文案）；
 * - abandon 只更新状态并保留全部产物。
 */
import { randomUUID } from "node:crypto";

import { MissionLeaseStore } from "../infra/mission-lease-store.js";
import { TaskStore } from "../infra/task-store.js";
import { MissionManager } from "./mission-manager.js";
import { RecoveryCheckpointStore } from "./recovery-checkpoint-store.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoint-schemas.js";
import { RecoveryClassificationService } from "./recovery-classification-service.js";
import { RecoveryIdentityAndBudgetService } from "./recovery-identity-budget-service.js";
import {
  createLocalHumanChangeObservationPort,
  createLocalWorktreeExistencePort,
  ReconciliationStateUnavailableError,
} from "./recovery-reconciliation-ports.js";
import { ReadonlyReconciliationService } from "./readonly-reconciliation-service.js";
import type {
  GitStatusPort,
  HumanChangeObservationPort,
  WorktreeExistencePort,
} from "./readonly-reconciliation-service.js";

/** 恢复对账端口（默认 worktree/人工变化走真实本地只读实现）。 */
export interface RecoveryReconciliationPorts {
  /** Git 只读状态端口；缺省表示本进程无法读取 Git 状态（fail-closed）。 */
  gitStatusPort?: GitStatusPort;
  worktreeExistencePort?: WorktreeExistencePort;
  humanChangeObservationPort?: HumanChangeObservationPort;
}

/** 只读对账结论（重启先对账；不写任何文件）。 */
export interface RecoveryReconciliationOutcome {
  /** 检查点是否声明了需要核对的状态（gitStateRecovery 非空）。 */
  required: boolean;
  /** Git 状态是否实际读到（false 时不得继续恢复）。 */
  gitStateAvailable: boolean;
  isReadonlyConfirmed: boolean;
  isSafeToProceed: boolean;
  requiresHumanChangeReconciliation: boolean;
  discrepancies: Array<{ type: string; detail: string }>;
}

export interface RecoveryCenterControllerOptions {
  baseDirectory: string;
  /** 诊断用本进程实例 ID；缺省按进程唯一生成，可注入以便测试稳定。 */
  currentProcessInstanceId?: string;
  reconciliationPorts?: RecoveryReconciliationPorts;
}

export interface RecoverableMissionView {
  missionIdentifier: string;
  exists: boolean;
  /** 该 mission 的可信检查点声明了 Git/worktree 状态 → 恢复前必须先只读对账。 */
  reconciliationRequired: boolean;
  status: string | null;
  isCorrupted: boolean;
  pendingTaskCount: number | null;
  hasTrustedCheckpoint: boolean;
  leaseProcessInstanceId: string | null;
  isLeaseActive: boolean;
}

export interface RecoveryDecisionItem {
  item: string;
  decision:
    | "blocked-uncertain-side-effect"
    | "blocked-provider-state-unknown"
    | "reauthorize-required"
    | "blocked-state-corrupted"
    | "checkpoint-not-found"
    | "blocked-reconciliation-discrepancy"
    | "blocked-reconciliation-unavailable";
  reason: string;
}

export interface RecoveredAgentIdentityView {
  agentInstanceId: string;
  isReusingOriginalIdentity: boolean;
  handoffReference: string | null;
}

export interface RecoveryResumeResult {
  missionIdentifier: string;
  resumed: boolean;
  recoveredSafeNodes: string[];
  /** 依据检查点重算的 ready set（任务顺序不清零）。 */
  readySetTaskNodeIdentifiers: string[];
  /** 存在已回收/关闭 Agent → 必须走新身份 + handoff。 */
  requiresHandoffIdentity: boolean;
  identityRecoveries: RecoveredAgentIdentityView[];
  blockedDecisionItems: RecoveryDecisionItem[];
  /** 一次性授权不随恢复延续；恢复后需重新授权的能力类型（非阻断项）。 */
  reauthorizationRequiredTypes: string[];
  /** 重启先做只读对账的结论（未声明对账输入时 required=false）。 */
  reconciliation: RecoveryReconciliationOutcome;
  /** 反馈 ack 之后才允许重放的 enqueue 范围（ack 之前不得重复投递）。 */
  feedbackReplayEnqueueRange: {
    fromEnqueueCursor: number;
    toEnqueueCursor: number;
  } | null;
  lostTimeWindowDescription: string | null;
}

export interface RecoveryAbandonResult {
  missionIdentifier: string;
  abandoned: boolean;
  artifactsRetained: true;
  statusAfter: string | null;
}

function buildReconciliationNotRequired(): RecoveryReconciliationOutcome {
  return {
    required: false,
    gitStateAvailable: false,
    isReadonlyConfirmed: false,
    isSafeToProceed: true,
    requiresHumanChangeReconciliation: false,
    discrepancies: [],
  };
}

export class RecoveryCenterController {
  private readonly missionManager: MissionManager;
  private readonly leaseStore: MissionLeaseStore;
  private readonly checkpointStore: RecoveryCheckpointStore;
  private readonly classificationService = new RecoveryClassificationService();
  private readonly identityAndBudgetService =
    new RecoveryIdentityAndBudgetService();
  private readonly currentProcessInstanceId: string;
  private readonly gitStatusPort: GitStatusPort | undefined;
  private readonly worktreeExistencePort: WorktreeExistencePort;
  private readonly humanChangeObservationPort: HumanChangeObservationPort;

  constructor(options: RecoveryCenterControllerOptions) {
    this.currentProcessInstanceId =
      options.currentProcessInstanceId ?? `process-${randomUUID()}`;
    this.gitStatusPort = options.reconciliationPorts?.gitStatusPort;
    this.worktreeExistencePort =
      options.reconciliationPorts?.worktreeExistencePort ??
      createLocalWorktreeExistencePort(options.baseDirectory);
    this.humanChangeObservationPort =
      options.reconciliationPorts?.humanChangeObservationPort ??
      createLocalHumanChangeObservationPort(options.baseDirectory);
    this.missionManager = new MissionManager(
      new TaskStore({ baseDirectory: options.baseDirectory }),
      options.baseDirectory,
    );
    this.leaseStore = new MissionLeaseStore({
      stateDirectory: options.baseDirectory,
    });
    this.checkpointStore = new RecoveryCheckpointStore({
      baseDirectory: options.baseDirectory,
    });
  }

  async listMissions(): Promise<{
    recoveryCenterReady: true;
    missions: RecoverableMissionView[];
    requiresDecisionMissions: string[];
  }> {
    const missionIdentifiers = await this.missionManager.listMissionIds();
    const trustedCheckpoint =
      await this.checkpointStore.selectLatestTrustedCheckpoint();
    const missions: RecoverableMissionView[] = [];
    for (const missionIdentifier of missionIdentifiers) {
      const probe = await this.missionManager.probeMissionDirectory(missionIdentifier);
      const lease = await this.leaseStore
        .readLeaseSummary(missionIdentifier, this.currentProcessInstanceId)
        .catch(() => null);
      missions.push({
        missionIdentifier,
        exists: probe.exists,
        reconciliationRequired:
          trustedCheckpoint?.checkpoint.missionIdentifier ===
            missionIdentifier &&
          (trustedCheckpoint.checkpoint.gitStateRecovery ?? null) !== null,
        status: probe.summaryStatus,
        isCorrupted: probe.summaryCorrupted || probe.taskChainCorrupted,
        pendingTaskCount: probe.pendingTaskCount,
        hasTrustedCheckpoint:
          trustedCheckpoint?.checkpoint.missionIdentifier === missionIdentifier,
        leaseProcessInstanceId:
          lease === null ? null : lease.ownerProcessInstanceId,
        isLeaseActive: lease !== null && lease.isActive,
      });
    }
    return {
      recoveryCenterReady: true,
      missions,
      requiresDecisionMissions: missions
        .filter(
          (mission) =>
            mission.isCorrupted ||
            mission.status === null ||
            mission.pendingTaskCount === null ||
            (mission.pendingTaskCount !== null && mission.pendingTaskCount > 0),
        )
        .map((mission) => mission.missionIdentifier),
    };
  }

  async inspectMission(missionIdentifier: string): Promise<{
    view: RecoverableMissionView;
    hasTrustedCheckpoint: boolean;
  }> {
    const probe = await this.missionManager.probeMissionDirectory(missionIdentifier);
    const lease = await this.leaseStore
      .readLeaseSummary(missionIdentifier, this.currentProcessInstanceId)
      .catch(() => null);
    const trustedCheckpoint =
      await this.checkpointStore.selectLatestTrustedCheckpoint();
    return {
      view: {
        missionIdentifier,
        exists: probe.exists,
        reconciliationRequired:
          trustedCheckpoint?.checkpoint.missionIdentifier ===
            missionIdentifier &&
          (trustedCheckpoint.checkpoint.gitStateRecovery ?? null) !== null,
        status: probe.summaryStatus,
        isCorrupted: probe.summaryCorrupted || probe.taskChainCorrupted,
        pendingTaskCount: probe.pendingTaskCount,
        hasTrustedCheckpoint:
          trustedCheckpoint?.checkpoint.missionIdentifier === missionIdentifier,
        leaseProcessInstanceId:
          lease === null ? null : lease.ownerProcessInstanceId,
        isLeaseActive: lease !== null && lease.isActive,
      },
      hasTrustedCheckpoint:
        trustedCheckpoint?.checkpoint.missionIdentifier === missionIdentifier,
    };
  }

  async resumeMission(missionIdentifier: string): Promise<RecoveryResumeResult> {
    const probe = await this.missionManager.probeMissionDirectory(missionIdentifier);
    if (probe.summaryCorrupted || probe.taskChainCorrupted) {
      return {
        missionIdentifier,
        resumed: false,
        recoveredSafeNodes: [],
        readySetTaskNodeIdentifiers: [],
        requiresHandoffIdentity: false,
        identityRecoveries: [],
        blockedDecisionItems: [
          {
            item: "mission-state-corrupted",
            decision: "blocked-state-corrupted",
            reason: "mission summary/task-chain 损坏，禁止静默重建为恢复成功",
          },
        ],
        reauthorizationRequiredTypes: [],
        reconciliation: buildReconciliationNotRequired(),
        feedbackReplayEnqueueRange: null,
        lostTimeWindowDescription: null,
      };
    }
    const trustedCheckpoint =
      await this.checkpointStore.selectLatestTrustedCheckpoint();
    if (
      trustedCheckpoint === null ||
      trustedCheckpoint.checkpoint.missionIdentifier !== missionIdentifier
    ) {
      return {
        missionIdentifier,
        resumed: false,
        recoveredSafeNodes: [],
        readySetTaskNodeIdentifiers: [],
        requiresHandoffIdentity: false,
        identityRecoveries: [],
        blockedDecisionItems: [
          {
            item: "checkpoint-not-found",
            decision: "checkpoint-not-found",
            reason: "未找到属于该 mission 的可信检查点；未知状态不得自动恢复",
          },
        ],
        reauthorizationRequiredTypes: [],
        reconciliation: buildReconciliationNotRequired(),
        feedbackReplayEnqueueRange: null,
        lostTimeWindowDescription: trustedCheckpoint?.lostTimeWindowDescription ?? null,
      };
    }
    const classification = this.classificationService.classifyRecovery({
      checkpoint: trustedCheckpoint.checkpoint,
      remainingRetryBudget: 1,
    });
    const identityAndBudget =
      this.identityAndBudgetService.recoverIdentityAndBudget({
        checkpoint: trustedCheckpoint.checkpoint,
        generateNewIdentity: (originalAgentInstanceId) =>
          `${originalAgentInstanceId}-recovered-${randomUUID()}`,
      });
    const reconciliation = await this.reconcileCheckpoint(
      trustedCheckpoint.checkpoint,
    );
    const blockedDecisionItems: RecoveryDecisionItem[] =
      classification.toolCallClassifications
        .filter(
          (entry) =>
            entry.classification.category === "blocked-uncertain-side-effect",
        )
        .map((entry) => ({
          item: entry.toolCallIdentifier,
          decision: "blocked-uncertain-side-effect" as const,
          reason: "工具副作用未知，需用户裁决，禁止自动二次执行",
        }));
    for (const providerRequestIdentifier of classification.blockedProviderRequestIdentifiers) {
      blockedDecisionItems.push({
        item: providerRequestIdentifier,
        decision: "blocked-provider-state-unknown",
        reason: "Provider 停止状态不确定，需确认停止后才能继续",
      });
    }
    // 重启先只读对账：检查点声明的 Git/worktree/人工变化状态不一致 → 阻断，
    // 未读到 Git 状态时 fail-closed（绝不当作“无差异”继续恢复）。
    if (reconciliation.required && !reconciliation.gitStateAvailable) {
      blockedDecisionItems.push({
        item: "git-state-unavailable",
        decision: "blocked-reconciliation-unavailable",
        reason: "无法只读读取 Git 状态；未对账前不得继续恢复",
      });
    }
    for (const discrepancy of reconciliation.discrepancies) {
      blockedDecisionItems.push({
        item: discrepancy.type,
        decision: "blocked-reconciliation-discrepancy",
        reason: discrepancy.detail,
      });
    }
    // 未决冲突：旧检查点不得覆盖人工变化，先由用户裁决。
    if (trustedCheckpoint.checkpoint.pendingConflictIdentifiers.length > 0) {
      blockedDecisionItems.push({
        item: "pending-conflict-identifiers",
        decision: "blocked-reconciliation-discrepancy",
        reason: `存在未决冲突 ${trustedCheckpoint.checkpoint.pendingConflictIdentifiers.join(", ")}；需人工裁决后才能继续`,
      });
    }
    // 一次性授权不随恢复延续：作为必须重新授权项上报，但不阻断安全节点恢复
    // （recovery-classification-service 的 hasBlockingItems 同样不含该类别）。
    const recoveredSafeNodes = classification.toolCallClassifications
      .filter((entry) => entry.classification.category === "reuse-confirmed-result")
      .map((entry) => entry.toolCallIdentifier);
    if (classification.hasBlockingItems || blockedDecisionItems.length > 0) {
      return {
        missionIdentifier,
        resumed: false,
        recoveredSafeNodes,
        readySetTaskNodeIdentifiers:
          identityAndBudget.readySetTaskNodeIdentifiers,
        requiresHandoffIdentity: identityAndBudget.requiresHandoffIdentity,
        identityRecoveries: identityAndBudget.identityRecoveries,
        blockedDecisionItems,
        reauthorizationRequiredTypes: classification.reauthorizationRequiredTypes,
        reconciliation,
        feedbackReplayEnqueueRange: classification.feedbackReplayEnqueueRange,
        lostTimeWindowDescription: trustedCheckpoint.lostTimeWindowDescription,
      };
    }
    await this.missionManager.updateMissionStatus(missionIdentifier, "running");
    return {
      missionIdentifier,
      resumed: true,
      recoveredSafeNodes,
      readySetTaskNodeIdentifiers:
        identityAndBudget.readySetTaskNodeIdentifiers,
      requiresHandoffIdentity: identityAndBudget.requiresHandoffIdentity,
      identityRecoveries: identityAndBudget.identityRecoveries,
      blockedDecisionItems: [],
      reauthorizationRequiredTypes: classification.reauthorizationRequiredTypes,
      reconciliation,
      feedbackReplayEnqueueRange: classification.feedbackReplayEnqueueRange,
      lostTimeWindowDescription: trustedCheckpoint.lostTimeWindowDescription,
    };
  }

  /** 只读对账：检查点声明了 Git/worktree 状态时，重启先用本地只读状态核对。 */
  private async reconcileCheckpoint(
    checkpoint: RecoveryCheckpoint,
  ): Promise<RecoveryReconciliationOutcome> {
    const gitStateRecovery = checkpoint.gitStateRecovery ?? null;
    if (gitStateRecovery === null) {
      return buildReconciliationNotRequired();
    }
    if (this.gitStatusPort === undefined) {
      return {
        required: true,
        gitStateAvailable: false,
        isReadonlyConfirmed: false,
        isSafeToProceed: false,
        requiresHumanChangeReconciliation: false,
        discrepancies: [],
      };
    }
    const reconciliationService = new ReadonlyReconciliationService({
      gitStatusPort: this.gitStatusPort,
      worktreeExistencePort: this.worktreeExistencePort,
      humanChangeObservationPort: this.humanChangeObservationPort,
    });
    try {
      const result = await reconciliationService.reconcile({
        checkpointGitState: {
          targetBranchName: gitStateRecovery.targetBranchName,
          targetHeadCommitIdentifier: gitStateRecovery.targetHeadCommitIdentifier,
          expectedDirty: gitStateRecovery.expectedDirty,
        },
        checkpointHumanChangeObservationRevision:
          checkpoint.humanChangeObservationRevision,
        expectedWorktreeIdentifiers:
          gitStateRecovery.expectedWorktreeIdentifiers,
      });
      return {
        required: true,
        gitStateAvailable: true,
        isReadonlyConfirmed: result.isReadonlyConfirmed,
        isSafeToProceed: result.isSafeToProceed,
        requiresHumanChangeReconciliation:
          result.requiresHumanChangeReconciliation,
        discrepancies: result.discrepancies,
      };
    } catch (error) {
      if (error instanceof ReconciliationStateUnavailableError) {
        return {
          required: true,
          gitStateAvailable: false,
          isReadonlyConfirmed: false,
          isSafeToProceed: false,
          requiresHumanChangeReconciliation: false,
          discrepancies: [],
        };
      }
      throw error;
    }
  }

  async abandonMission(missionIdentifier: string): Promise<RecoveryAbandonResult> {
    await this.missionManager.updateMissionStatus(missionIdentifier, "cancelled");
    const probe = await this.missionManager.probeMissionDirectory(missionIdentifier);
    return {
      missionIdentifier,
      abandoned: true,
      artifactsRetained: true,
      statusAfter: probe.summaryStatus,
    };
  }
}