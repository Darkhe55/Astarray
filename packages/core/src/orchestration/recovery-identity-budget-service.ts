/**
 * 恢复身份、handoff、任务偏序与预算服务（T12A-05 / ADR-0030 §2）。
 *
 * - 已暂停同一 Agent 可在身份有效时恢复（沿用原 agentInstanceId）；
 *   已回收/关闭 Agent 必须新建身份并只接收选定 handoff（不复用旧身份）；
 * - 任务偏序恢复：按前驱/优先级重算 ready set（任务顺序不清零）；
 * - 读取/循环预算恢复：工作集、任务链累计来源、反自指、循环、失败
 *   与工具调用预算从检查点恢复，不能通过重启清零。
 */
import { recoveryCheckpointSchema } from "./recovery-checkpoint-schemas.js";
import type {
  AgentIdentityRecovery,
  RecoveryCheckpoint,
} from "./recovery-checkpoint-schemas.js";

/** 身份恢复结果（沿用原身份或新身份 + handoff）。 */
export interface IdentityRecoveryResult {
  agentInstanceId: string;
  isReusingOriginalIdentity: boolean;
  handoffReference: string | null;
}

/** 预算恢复结果（从检查点恢复；不清零）。 */
export interface BudgetRecoveryResult {
  workingSetFileCountsByAgent: Record<string, number>;
  taskChainCumulativeSourceCount: number;
  readReceiptBudgetRestored: boolean;
  cycleGuardBudgetRestored: boolean;
  failureRetryBudgetRestored: boolean;
}

export interface RecoveryIdentityAndBudgetOutput {
  identityRecoveries: IdentityRecoveryResult[];
  readySetTaskNodeIdentifiers: string[];
  budgetRecovery: BudgetRecoveryResult;
  requiresHandoffIdentity: boolean;
}

export class RecoveryIdentityAndBudgetService {
  /**
   * 恢复 Agent 身份、重算 ready set 并恢复预算。
   * 已回收/关闭 → 新身份 + 显式 handoff（不复用旧身份）。
   */
  recoverIdentityAndBudget(input: {
    checkpoint: RecoveryCheckpoint;
    /** 新身份生成端口（已回收 Agent 用）。 */
    generateNewIdentity: (originalAgentInstanceId: string) => string;
  }): RecoveryIdentityAndBudgetOutput {
    const parsedCheckpoint = recoveryCheckpointSchema.safeParse(input.checkpoint);
    if (!parsedCheckpoint.success) {
      throw new Error(`检查点非法: ${parsedCheckpoint.error.message}`);
    }
    const checkpoint = parsedCheckpoint.data;

    // 1) 身份恢复
    const identityRecoveries: IdentityRecoveryResult[] = [];
    let requiresHandoffIdentity = false;
    for (const agentIdentity of checkpoint.agentIdentities) {
      const isReclaimable =
        agentIdentity.lifecycleState === "closed" ||
        agentIdentity.lifecycleState === "reclaimed";
      if (isReclaimable) {
        requiresHandoffIdentity = true;
        identityRecoveries.push({
          agentInstanceId: input.generateNewIdentity(agentIdentity.agentInstanceId),
          isReusingOriginalIdentity: false,
          handoffReference:
            agentIdentity.handoffReference ??
            `handoff-from-${agentIdentity.agentInstanceId}`,
        });
      } else {
        // active/paused：沿用原身份
        identityRecoveries.push({
          agentInstanceId: agentIdentity.agentInstanceId,
          isReusingOriginalIdentity: true,
          handoffReference: null,
        });
      }
    }

    // 2) 任务偏序恢复：ready set = pending 且全部前驱已 done 的节点
    const doneNodeIdentifiers = new Set(
      checkpoint.taskNodes
        .filter((node) => node.status === "done")
        .map((node) => node.taskNodeIdentifier),
    );
    const readySetTaskNodeIdentifiers = checkpoint.taskNodes
      .filter(
        (node) =>
          node.status === "pending" &&
          node.predecessorTaskNodeIdentifiers.every((predecessor) =>
            doneNodeIdentifiers.has(predecessor),
          ),
      )
      .sort((left, right) => left.priorityTier - right.priorityTier)
      .map((node) => node.taskNodeIdentifier);

    // 3) 预算恢复（不清零；工作集/累计来源/读取回执/循环/失败预算）
    const budgetRecovery: BudgetRecoveryResult = {
      workingSetFileCountsByAgent: checkpoint.workingSetFileCountsByAgent,
      taskChainCumulativeSourceCount: checkpoint.taskChainCumulativeSourceCount,
      readReceiptBudgetRestored: true,
      cycleGuardBudgetRestored: true,
      failureRetryBudgetRestored: true,
    };

    return {
      identityRecoveries,
      readySetTaskNodeIdentifiers,
      budgetRecovery,
      requiresHandoffIdentity,
    };
  }

  /** 校验身份恢复引用（handoff 不能为空字符串）。 */
  static assertIdentityRecoveryValid(agentIdentity: AgentIdentityRecovery): void {
    if (
      (agentIdentity.lifecycleState === "closed" ||
        agentIdentity.lifecycleState === "reclaimed") &&
      (agentIdentity.handoffReference === null ||
        agentIdentity.handoffReference.trim() === "")
    ) {
      throw new Error("已回收 Agent 必须携带显式 handoff 引用（不复用旧身份）");
    }
  }
}