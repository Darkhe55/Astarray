/**
 * Agent 待办任务偏序集（T05C / ADR-0013）。
 * 以 DAG 表示有限偏序：节点之间由直接前驱/后继边连接。
 * 纯内存图操作；持久化由 AgentTaskSequenceStore 负责。
 *
 * 关键语义：
 * - 发布者添加任务时指定直接前驱/后继；没有指定位置的新任务与现有节点不可比。
 * - 拒绝环与未知锚点。
 * - 调度只比较当前可执行节点（ready set）：先满足偏序前驱，再按优先级层级
 *   选择；同层使用 sequenceOrdinal（创建序号）稳定排序。
 * - 高优先任务被低层必要前驱阻塞时，该前驱可提升执行（explainOrder 解释原因）。
 */
import { DomainError } from "../core/errors.js";
import type { AgentTaskNode } from "../core/types.js";

export interface InsertionAnchor {
  /** 插入位置参照：直接前驱节点 ID 列表。 */
  predecessorTaskIds: string[];
  /** 插入位置参照：直接后继节点 ID 列表。 */
  successorTaskIds: string[];
}

export class TaskSequencePartialOrder {
  private readonly nodesByTaskId = new Map<string, AgentTaskNode>();

  constructor(nodes: AgentTaskNode[]) {
    for (const node of nodes) {
      if (this.nodesByTaskId.has(node.taskId)) {
        throw new DomainError(
          "invalid-task-chain",
          `任务 ID 重复: ${node.taskId}`,
        );
      }
      this.nodesByTaskId.set(node.taskId, { ...node, dependsOn: [...node.dependsOn] });
    }
    this.validateDependencies();
    this.validateAcyclic();
  }

  getNode(taskId: string): AgentTaskNode | undefined {
    const node = this.nodesByTaskId.get(taskId);
    return node === undefined ? undefined : { ...node, dependsOn: [...node.dependsOn] };
  }

  getTaskIds(): string[] {
    return [...this.nodesByTaskId.keys()];
  }

  getNodes(): AgentTaskNode[] {
    return [...this.nodesByTaskId.values()].map((node) => ({
      ...node,
      dependsOn: [...node.dependsOn],
    }));
  }

  /**
   * 添加新节点并建立指定位置的边。锚点必须存在；前驱与后继同时指定时
   * 允许（表示插入到两者之间），但不得引入环。
   * 未指定任何锚点的新节点与现有节点不可比（不自动追加到队尾）。
   */
  insertNode(node: AgentTaskNode, anchor: InsertionAnchor): void {
    if (this.nodesByTaskId.has(node.taskId)) {
      throw new DomainError("invalid-task-chain", `任务 ID 重复: ${node.taskId}`);
    }
    if (
      anchor.predecessorTaskIds.length === 0 &&
      anchor.successorTaskIds.length === 0
    ) {
      throw new DomainError(
        "invalid-task-chain",
        `插入必须指定直接前驱或直接后继: ${node.taskId}`,
      );
    }
    const mergedDependencies = new Set<string>([
      ...node.dependsOn,
      ...anchor.predecessorTaskIds,
    ]);
    for (const predecessorTaskId of anchor.predecessorTaskIds) {
      this.assertNodeExists(predecessorTaskId, `前驱锚点`);
    }
    for (const successorTaskId of anchor.successorTaskIds) {
      this.assertNodeExists(successorTaskId, `后继锚点`);
    }
    this.nodesByTaskId.set(node.taskId, {
      ...node,
      dependsOn: [...mergedDependencies],
    });
    for (const successorTaskId of anchor.successorTaskIds) {
      const successorNode = this.nodesByTaskId.get(successorTaskId);
      if (successorNode !== undefined) {
        successorNode.dependsOn.push(node.taskId);
      }
    }
    try {
      this.validateAcyclic();
    } catch (error) {
      this.nodesByTaskId.delete(node.taskId);
      throw error;
    }
  }

  /** 改变已存在节点的状态；不允许改变 dependsOn（改序走 reorder）。 */
  transitionStatus(
    taskId: string,
    nextStatus: AgentTaskNode["status"],
    allowedPreviousStatuses: AgentTaskNode["status"][],
    blockReason: string | null = null,
  ): AgentTaskNode {
    const node = this.nodesByTaskId.get(taskId);
    if (node === undefined) {
      throw new DomainError("dependency-not-found", `任务不存在: ${taskId}`);
    }
    if (!allowedPreviousStatuses.includes(node.status)) {
      throw new DomainError(
        "invalid-task-chain",
        `非法状态迁移: ${taskId} ${node.status} → ${nextStatus}`,
      );
    }
    node.status = nextStatus;
    if (blockReason !== null) {
      node.blockReason = blockReason;
    }
    return { ...node, dependsOn: [...node.dependsOn] };
  }

  /**
   * 可执行节点集合：pending 且全部直接前驱已 done。
   * 按 (priorityTier 升序, sequenceOrdinal 升序) 稳定排序，可重放。
   */
  getReadyTaskIds(): string[] {
    return this.getTaskIds()
      .filter((taskId) => {
        const node = this.nodesByTaskId.get(taskId);
        if (node === undefined || node.status !== "pending") {
          return false;
        }
        return node.dependsOn.every(
          (dependencyId) =>
            this.nodesByTaskId.get(dependencyId)?.status === "done",
        );
      })
      .sort((leftTaskId, rightTaskId) => {
        const leftNode = this.nodesByTaskId.get(leftTaskId);
        const rightNode = this.nodesByTaskId.get(rightTaskId);
        if (leftNode === undefined || rightNode === undefined) {
          return 0;
        }
        if (leftNode.priorityTier !== rightNode.priorityTier) {
          return leftNode.priorityTier - rightNode.priorityTier;
        }
        return leftNode.sequenceOrdinal - rightNode.sequenceOrdinal;
      });
  }

  /**
   * 为每个任务生成顺序解释：
   * - 可执行：满足前驱、优先级层级与稳定序号；
   * - 被阻塞：列出未完成前驱；
   * - 必要前驱提升：某低层 pending 节点是更高优先节点的直接前驱时，说明
   *   调度允许先完成它以解锁高优先任务（"必要前驱可先行"）。
   */
  explainOrder(): Array<{ taskId: string; explanation: string }> {
    const readyTaskIds = new Set(this.getReadyTaskIds());
    const explanations: Array<{ taskId: string; explanation: string }> = [];
    const orderedTaskIds = this.getTaskIds().sort((leftTaskId, rightTaskId) => {
      const leftNode = this.nodesByTaskId.get(leftTaskId);
      const rightNode = this.nodesByTaskId.get(rightTaskId);
      if (leftNode === undefined || rightNode === undefined) {
        return 0;
      }
      return leftNode.sequenceOrdinal - rightNode.sequenceOrdinal;
    });
    for (const taskId of orderedTaskIds) {
      const node = this.nodesByTaskId.get(taskId);
      if (node === undefined) {
        continue;
      }
      if (readyTaskIds.has(taskId)) {
        explanations.push({
          taskId,
          explanation: `可执行：前驱已满足，优先级层级 ${node.priorityTier}，稳定序号 ${node.sequenceOrdinal}`,
        });
        continue;
      }
      if (node.status !== "pending") {
        explanations.push({
          taskId,
          explanation: `不可执行：状态 ${node.status}${node.blockReason === null ? "" : `（${node.blockReason}）`}`,
        });
        continue;
      }
      const unfinishedPredecessorIds = node.dependsOn.filter(
        (dependencyId) =>
          this.nodesByTaskId.get(dependencyId)?.status !== "done",
      );
      const higherPrioritySuccessorIds = this.findHigherPrioritySuccessorTaskIds(
        taskId,
        node.priorityTier,
      );
      if (unfinishedPredecessorIds.length > 0) {
        if (higherPrioritySuccessorIds.length > 0) {
          explanations.push({
            taskId,
            explanation: `被阻塞：未完成前驱 [${unfinishedPredecessorIds.join(", ")}]；同时是高优先任务 [${higherPrioritySuccessorIds.join(", ")}] 的必要前驱，可先行完成以解锁`,
          });
        } else {
          explanations.push({
            taskId,
            explanation: `被阻塞：未完成前驱 [${unfinishedPredecessorIds.join(", ")}]`,
          });
        }
        continue;
      }
      explanations.push({
        taskId,
        explanation: `可执行但同层序号 ${node.sequenceOrdinal} 排序靠后，等待调度`,
      });
    }
    return explanations;
  }

  /** 校验某任务是否是一条通向更小 priorityTier 任务的前驱路径（含传递）。 */
  private findHigherPrioritySuccessorTaskIds(
    taskId: string,
    ownPriorityTier: number,
  ): string[] {
    const higherPrioritySuccessorIds: string[] = [];
    const visited = new Set<string>();
    const successorsOf = new Map<string, string[]>();
    for (const node of this.nodesByTaskId.values()) {
      for (const dependencyId of node.dependsOn) {
        const successors = successorsOf.get(dependencyId) ?? [];
        successors.push(node.taskId);
        successorsOf.set(dependencyId, successors);
      }
    }
    const visit = (candidateTaskId: string): void => {
      if (visited.has(candidateTaskId)) {
        return;
      }
      visited.add(candidateTaskId);
      for (const successorTaskId of successorsOf.get(candidateTaskId) ?? []) {
        const successorNode = this.nodesByTaskId.get(successorTaskId);
        if (successorNode === undefined) {
          continue;
        }
        if (successorNode.priorityTier < ownPriorityTier) {
          higherPrioritySuccessorIds.push(successorTaskId);
        }
        visit(successorTaskId);
      }
    };
    visit(taskId);
    return higherPrioritySuccessorIds;
  }

  private assertNodeExists(taskId: string, anchorKind: string): void {
    if (!this.nodesByTaskId.has(taskId)) {
      throw new DomainError(
        "dependency-not-found",
        `未知锚点: ${anchorKind} ${taskId} 不存在`,
      );
    }
  }

  private validateDependencies(): void {
    for (const node of this.nodesByTaskId.values()) {
      for (const dependencyId of node.dependsOn) {
        if (!this.nodesByTaskId.has(dependencyId)) {
          throw new DomainError(
            "dependency-not-found",
            `任务 ${node.taskId} 依赖不存在的任务 ${dependencyId}`,
          );
        }
      }
    }
  }

  private validateAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (taskId: string): void => {
      if (visited.has(taskId)) {
        return;
      }
      if (visiting.has(taskId)) {
        throw new DomainError("dag-cycle", `任务依赖存在环: ${taskId}`);
      }
      visiting.add(taskId);
      const node = this.nodesByTaskId.get(taskId);
      for (const dependencyId of node?.dependsOn ?? []) {
        visit(dependencyId);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };

    for (const taskId of this.getTaskIds()) {
      visit(taskId);
    }
  }
}
