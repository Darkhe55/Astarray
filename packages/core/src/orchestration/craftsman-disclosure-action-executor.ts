/**
 * 工匠披露动作执行器（T08D-04 / ADR-0027 §5）。
 *
 * 三种披露动作：
 * - suggest-only：只通知次级（事件已由披露控制器发送；无额外动作）；
 * - suggest-with-prompt：校验提示词模板存在，返回模板引用（次级结合
 *   ready set/指纹/权限边界形成安排建议），不插入节点；
 * - auto-enqueue-proposal：本地控制面把"评估并安排工匠"节点插入目标
 *   次级偏序集；自动节点来源是本地策略，只能使用优先级层级 1，
 *   不能抢占用户层级 0，也不能伪装用户来源。
 *
 * 提示词是给次级 Agent 的计划输入，不构成工具授权、安装同意、
 * Git 合并许可或用户验收。
 */
import { DomainError } from "../core/errors.js";
import type { CraftsmanPresetAvailableEvent } from "./craftsman-schemas.js";
import type { TaskSequenceManageController } from "./task-sequence-controllers.js";

export type DisclosureActionExecutionResult =
  | { action: "suggest-only" }
  | { action: "suggest-with-prompt"; promptTemplateReference: string }
  | {
      action: "auto-enqueue-proposal";
      insertedTaskId: string;
      priorityTier: 1;
    };

export interface CraftsmanDisclosureActionExecutorOptions {
  sequenceManageController: TaskSequenceManageController;
  /** 目标次级是否存在的校验端口。 */
  doesSecondaryAgentExist: (agentInstanceId: string) => boolean;
}

export class CraftsmanDisclosureActionExecutor {
  private readonly sequenceManageController: TaskSequenceManageController;
  private readonly doesSecondaryAgentExist: (
    agentInstanceId: string,
  ) => boolean;

  constructor(options: CraftsmanDisclosureActionExecutorOptions) {
    this.sequenceManageController = options.sequenceManageController;
    this.doesSecondaryAgentExist = options.doesSecondaryAgentExist;
  }

  /**
   * 按披露事件执行动作。事件必须已含目标次级与幂等键（来源保留）。
   * auto-enqueue-proposal 插入的自动节点固定 priorityTier 1（本地策略
   * 来源不允许 0；用户显式确认后才可升级为层级 0）。
   */
  async executeDisclosureAction(input: {
    event: CraftsmanPresetAvailableEvent;
    promptTemplate: string | null;
    /** 目标次级偏序集 revision（乐观并发）。 */
    expectedSequenceRevision: number;
    /** 自动节点锚点（必须指定直接前驱或后继；装配方提供）。 */
    anchor: {
      predecessorTaskIds: string[];
      successorTaskIds: string[];
    };
  }): Promise<DisclosureActionExecutionResult> {
    const event = input.event;
    if (!this.doesSecondaryAgentExist(event.targetSecondaryAgentInstanceId)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `目标次级 Agent 不存在: ${event.targetSecondaryAgentInstanceId}`,
      );
    }
    switch (event.disclosureAction) {
      case "suggest-only":
        return { action: "suggest-only" };
      case "suggest-with-prompt":
        if (input.promptTemplate === null || input.promptTemplate.trim() === "") {
          throw new DomainError(
            "invalid-task-chain",
            "suggest-with-prompt 披露动作缺少提示词模板",
          );
        }
        return {
          action: "suggest-with-prompt",
          promptTemplateReference: input.promptTemplate,
        };
      case "auto-enqueue-proposal": {
        const taskId = `craftsman-proposal-${event.idempotencyKey
          .replace(/[^A-Za-z0-9]/g, "-")
          .slice(0, 40)}`;
        // 本地控制面代理目标次级插入自动节点：来源仍是 agent（非用户）、
        // priorityTier 1（不抢占用户层级 0）；actor 归属序列所有者次级。
        await this.sequenceManageController.insertTask({
          ownerAgentInstanceId: event.targetSecondaryAgentInstanceId,
          actor: {
            sourceKind: "agent",
            actorId: event.targetSecondaryAgentInstanceId,
          },
          sequenceId: `sequence-${event.targetSecondaryAgentInstanceId}`,
          expectedRevision: input.expectedSequenceRevision,
          task: {
            taskId,
            title: "评估并安排工匠工作流定制（本地策略自动节点；优先级层级 1）",
            priorityTier: 1,
            externalReference: event.eventId,
          },
          anchor: input.anchor,
        });
        return { action: "auto-enqueue-proposal", insertedTaskId: taskId, priorityTier: 1 };
      }
    }
  }
}