/**
 * 任务 DAG（T05）。
 * 职责：环检测、缺失依赖检测、可运行任务计算、状态迁移、失败传播。
 * 纯内存图操作；持久化由调用方（DagScheduler + TaskStore）负责。
 */
import { DomainError } from "./errors.js";
import type { TaskChainDocument, TaskDependencyNode } from "./types.js";

export class TaskGraph {
  private readonly nodesById = new Map<string, TaskDependencyNode>();

  constructor(nodes: TaskDependencyNode[]) {
    for (const node of nodes) {
      if (this.nodesById.has(node.id)) {
        throw new DomainError(
          "invalid-task-chain",
          `任务 ID 重复: ${node.id}`,
        );
      }
      this.nodesById.set(node.id, { ...node, dependsOn: [...node.dependsOn] });
    }
    this.validateDependencies();
    this.validateAcyclic();
  }

  static fromTaskChain(document: TaskChainDocument): TaskGraph {
    return new TaskGraph(document.tasks);
  }

  getNode(taskId: string): TaskDependencyNode | undefined {
    return this.nodesById.get(taskId);
  }

  getTaskIds(): string[] {
    return [...this.nodesById.keys()];
  }

  getNodes(): TaskDependencyNode[] {
    return [...this.nodesById.values()].map((node) => ({
      ...node,
      dependsOn: [...node.dependsOn],
    }));
  }

  /**
   * 可运行任务：pending 且全部依赖已 done，且自身未被领取。
   * 按任务 ID 字典序返回，保证调度确定性。
   */
  findRunnableTaskIds(): string[] {
    return this.getTaskIds()
      .filter((taskId) => {
        const node = this.nodesById.get(taskId);
        if (node === undefined || node.status !== "pending") {
          return false;
        }
        return node.dependsOn.every(
          (dependencyId) =>
            this.nodesById.get(dependencyId)?.status === "done",
        );
      })
      .sort();
  }

  isMissionComplete(): boolean {
    return this.getTaskIds().every(
      (taskId) => this.nodesById.get(taskId)?.status === "done",
    );
  }

  markRunning(taskId: string): void {
    this.transitionTo(taskId, "running", ["pending"]);
  }

  markDone(taskId: string, resultLocation: string | null): void {
    const node = this.transitionTo(taskId, "done", ["running"]);
    node.resultLocation = resultLocation;
  }

  markFailed(taskId: string): void {
    this.transitionTo(taskId, "failed", ["running", "pending"]);
  }

  markBlocked(taskId: string): void {
    this.transitionTo(taskId, "blocked", ["pending", "running"]);
  }

  /** 恢复为 pending（retry/reassign/cancel/人工放行），清空指派。 */
  markPendingForRetry(taskId: string): void {
    const node = this.transitionTo(taskId, "pending", [
      "running",
      "failed",
      "blocked",
    ]);
    node.assignedAgentId = null;
  }

  /**
   * 失败传播：将依赖该失败任务的下游任务标记为 blocked。
   * 返回被阻塞的任务 ID 列表。
   */
  propagateFailureToDownstream(failedTaskId: string): string[] {
    const blockedTaskIds: string[] = [];
    for (const taskId of this.getTaskIds()) {
      const node = this.nodesById.get(taskId);
      if (node === undefined || node.status !== "pending") {
        continue;
      }
      if (node.dependsOn.includes(failedTaskId)) {
        node.status = "blocked";
        blockedTaskIds.push(taskId);
      }
    }
    return blockedTaskIds;
  }

  assignAgent(taskId: string, agentId: string): void {
    const node = this.nodesById.get(taskId);
    if (node === undefined) {
      throw new DomainError("dependency-not-found", `任务不存在: ${taskId}`);
    }
    node.assignedAgentId = agentId;
  }

  private transitionTo(
    taskId: string,
    nextStatus: TaskDependencyNode["status"],
    allowedPreviousStatuses: TaskDependencyNode["status"][],
  ): TaskDependencyNode {
    const node = this.nodesById.get(taskId);
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
    return node;
  }

  private validateDependencies(): void {
    for (const node of this.nodesById.values()) {
      for (const dependencyId of node.dependsOn) {
        if (!this.nodesById.has(dependencyId)) {
          throw new DomainError(
            "dependency-not-found",
            `任务 ${node.id} 依赖不存在的任务 ${dependencyId}`,
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
        throw new DomainError(
          "dag-cycle",
          `任务依赖存在环: ${taskId}`,
        );
      }
      visiting.add(taskId);
      const node = this.nodesById.get(taskId);
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
