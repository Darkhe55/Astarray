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
import { RecoveryClassificationService } from "./recovery-classification-service.js";
import { RecoveryIdentityAndBudgetService } from "./recovery-identity-budget-service.js";

export interface RecoveryCenterControllerOptions {
  baseDirectory: string;
  /** 诊断用本进程实例 ID；缺省按进程唯一生成，可注入以便测试稳定。 */
  currentProcessInstanceId?: string;
}

export interface RecoverableMissionView {
  missionIdentifier: string;
  exists: boolean;
  status: string | null;
  isCorrupted: boolean;
  pendingTaskCount: number | null;
  hasTrustedCheckpoint: boolean;
  leaseProcessInstanceId: string | null;
  isLeaseActive: boolean;
}

export interface RecoveryDecisionItem {
  item: string;
  decision: "blocked-uncertain-side-effect" | "blocked-provider-state-unknown" | "reauthorize-required" | "blocked-state-corrupted" | "checkpoint-not-found";
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
  lostTimeWindowDescription: string | null;
}

export interface RecoveryAbandonResult {
  missionIdentifier: string;
  abandoned: boolean;
  artifactsRetained: true;
  statusAfter: string | null;
}

export class RecoveryCenterController {
  private readonly missionManager: MissionManager;
  private readonly leaseStore: MissionLeaseStore;
  private readonly checkpointStore: RecoveryCheckpointStore;
  private readonly classificationService = new RecoveryClassificationService();
  private readonly identityAndBudgetService =
    new RecoveryIdentityAndBudgetService();
  private readonly currentProcessInstanceId: string;

  constructor(options: RecoveryCenterControllerOptions) {
    this.currentProcessInstanceId =
      options.currentProcessInstanceId ?? `process-${randomUUID()}`;
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
      lostTimeWindowDescription: trustedCheckpoint.lostTimeWindowDescription,
    };
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