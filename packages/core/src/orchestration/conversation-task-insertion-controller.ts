/**
 * 对话任务插入控制器（T08A / ADR-0022 §主 Agent 交流、评估与任务插入提案）。
 * 主 Agent 输出版本化 TaskInsertionProposal；本控制器在本地验证用户/Agent
 * 来源、目标次级 Agent、偏序集 revision、前驱/后继与优先层后，代表控制面
 * 提交偏序集变更。该控制器不是主 Agent 可调用的写工具。
 *
 * 来源与优先级：用户原始任务或指导保持 priorityTier 0；主 Agent 自行推导
 * 的设计/拆解/补充节点是 Agent 来源，只能进入 priorityTier >= 1。主 Agent
 * 不得通过转述把 Agent 生成内容伪装成用户来源。
 */
import { DomainError } from "../core/errors.js";
import type { TaskSourceKind } from "../core/types.js";
import type {
  TaskSequenceManageController,
} from "./task-sequence-controllers.js";

export interface TaskInsertionProposal {
  proposalId: string;
  /** 目标次级 Agent（不可复用实例 ID）。 */
  targetSecondaryAgentInstanceId: string;
  sequenceId: string;
  expectedRevision: number;
  /** 提案来源（harness 注入；模型不能填写）。 */
  sourceKind: TaskSourceKind;
  sourceActorId: string;
  task: {
    taskId: string;
    title: string;
    priorityTier: number | null;
    externalReference: string | null;
  };
  anchor: {
    predecessorTaskIds: string[];
    successorTaskIds: string[];
  };
  /** 任务摘要、约束与验收条件（随任务描述）。 */
  acceptanceCriteria: string;
  createdAtIso: string;
}

export interface ConversationTaskInsertionControllerOptions {
  manageController: TaskSequenceManageController;
  /** 当前对话用户标识（harness 注入）。 */
  authenticatedUserId: string;
  /** 允许提案来源（默认 user/agent；tool/system 拒绝）。 */
  allowedSourceKinds?: TaskSourceKind[];
}

export class ConversationTaskInsertionController {
  private readonly manageController: TaskSequenceManageController;
  private readonly authenticatedUserId: string;
  private readonly allowedSourceKinds: TaskSourceKind[];

  constructor(options: ConversationTaskInsertionControllerOptions) {
    this.manageController = options.manageController;
    this.authenticatedUserId = options.authenticatedUserId;
    this.allowedSourceKinds = options.allowedSourceKinds ?? ["user", "agent"];
  }

  /**
   * 提交提案：校验来源、优先级与锚点后插入目标次级 Agent 的偏序集。
   * 用户来源默认层级 0；agent 来源请求层级 0 由优先级策略硬拒绝。
   */
  async submitProposal(
    proposal: TaskInsertionProposal,
  ): Promise<void> {
    if (!this.allowedSourceKinds.includes(proposal.sourceKind)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `提案来源不允许: ${proposal.sourceKind}`,
      );
    }
    if (proposal.sourceKind === "user" && proposal.sourceActorId !== this.authenticatedUserId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "用户来源与认证用户不一致",
      );
    }
    if (proposal.sourceKind === "agent" && proposal.task.priorityTier === 0) {
      throw new DomainError(
        "task-priority-denied",
        "主 Agent 派生任务不能进入层级 0（不得伪装用户来源）",
      );
    }
    const actor =
      proposal.sourceKind === "user"
        ? { sourceKind: "user" as const, actorId: proposal.sourceActorId }
        : { sourceKind: "agent" as const, actorId: proposal.sourceActorId };
    await this.manageController.insertTask({
      ownerAgentInstanceId: proposal.targetSecondaryAgentInstanceId,
      actor,
      sequenceId: proposal.sequenceId,
      expectedRevision: proposal.expectedRevision,
      task: {
        taskId: proposal.task.taskId,
        title: `${proposal.task.title}（验收: ${proposal.acceptanceCriteria.slice(0, 80)}）`,
        priorityTier: proposal.task.priorityTier,
        externalReference: proposal.task.externalReference,
      },
      anchor: proposal.anchor,
    });
  }
}
