/**
 * 待办任务优先级策略（T05C / ADR-0013 §优先级规则）。
 * - priorityTier 从 0 开始，数值越小越优先。
 * - 用户任务默认层级 0；用户可主动选择更低层级。
 * - Agent 或工具发布的任务只能使用层级 1 或以下，执行层拒绝其进入层级 0。
 * - 次级 Agent 分割用户任务时保留层级 0 的用户根任务；派生子任务仍为层级 1
 *   或以下，并作为根任务的必要前驱。必要前驱可以因用户根任务而先行，
 *   但不会继承或伪造用户来源。
 */
import { DomainError } from "../core/errors.js";
import type { TaskSourceKind } from "../core/types.js";

export const USER_DEFAULT_PRIORITY_TIER = 0;
export const NON_USER_MAX_PRIORITY_TIER = 1;

export class TaskPriorityPolicy {
  /**
   * 解析发布任务的最终优先级层级。sourceKind 为 agent/system/tool 时
   * 请求层级 0 一律硬拒绝（防自动生成任务冒充用户任务提权）。
   * 用户不指定层级时默认为 USER_DEFAULT_PRIORITY_TIER。
   */
  resolvePriorityTier(input: {
    sourceKind: TaskSourceKind;
    requestedPriorityTier: number | null;
  }): number {
    if (input.sourceKind === "user") {
      return input.requestedPriorityTier ?? USER_DEFAULT_PRIORITY_TIER;
    }
    const effectiveTier = input.requestedPriorityTier ?? NON_USER_MAX_PRIORITY_TIER;
    if (effectiveTier < NON_USER_MAX_PRIORITY_TIER) {
      throw new DomainError(
        "task-priority-denied",
        `${input.sourceKind} 来源的任务优先级层级 ${effectiveTier} 低于允许下限 ${NON_USER_MAX_PRIORITY_TIER}（层级 0 仅限用户任务）`,
      );
    }
    return effectiveTier;
  }

  /** 是否允许该来源类型创建层级 0 的任务。 */
  canPublishAtTierZero(sourceKind: TaskSourceKind): boolean {
    return sourceKind === "user";
  }
}
