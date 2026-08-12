/**
 * DAG 调度器（T05）。
 * 职责：并发限制、任务领取锁、失败传播、blocked/retry/cancel/reassign、
 *       每轮调度后原子更新 task chain。
 */
import { TASK_CHAIN_SCHEMA_VERSION } from "../core/types.js";
import type { TaskChainDocument } from "../core/types.js";
import type { TaskStorePort } from "../core/types.js";
import { TaskGraph } from "../core/task-graph.js";

export type ScheduleAction =
  | { action: "start-task"; taskId: string; assignedAgentId: string }
  | { action: "block-task"; taskId: string; reason: string }
  | { action: "retry-task"; taskId: string }
  | { action: "reassign-task"; taskId: string; assignedAgentId: string }
  | { action: "complete-mission" };

export interface DagSchedulerOptions {
  concurrency: number;
  taskStore: TaskStorePort;
  /** 为新领取的任务分配 Worker（Agent）实例 ID。 */
  allocateAgentId: (taskId: string) => string;
}

export class DagScheduler {
  private readonly claimedTaskIds = new Set<string>();
  private readonly graph: TaskGraph;
  private readonly concurrency: number;
  private readonly missionId: string;

  constructor(
    initialChain: TaskChainDocument,
    private readonly options: DagSchedulerOptions,
  ) {
    this.graph = TaskGraph.fromTaskChain(initialChain);
    this.concurrency = options.concurrency;
    this.missionId = initialChain.missionId;
  }

  getCurrentGraph(): TaskGraph {
    return this.graph;
  }

  isTaskClaimed(taskId: string): boolean {
    return this.claimedTaskIds.has(taskId);
  }

  getRunningTaskCount(): number {
    return this.claimedTaskIds.size;
  }

  /**
   * 一轮调度：先处理外部状态回写（done/failed/blocked 等已由 Worker 完成
   * 并通过 markTaskFinished 回写），再启动可运行任务。
   * 返回本轮产生的调度动作。每个动作应被调用方执行（如通知 Worker）。
   */
  async scheduleRound(): Promise<ScheduleAction[]> {
    const actions: ScheduleAction[] = [];
    this.collectDownstreamBlocks(actions);
    if (this.graph.isMissionComplete()) {
      actions.push({ action: "complete-mission" });
      return actions;
    }
    const availableSlots = this.concurrency - this.claimedTaskIds.size;
    if (availableSlots <= 0) {
      return actions;
    }
    const runnableTaskIds = this.graph
      .findRunnableTaskIds()
      .filter((taskId) => !this.claimedTaskIds.has(taskId))
      .slice(0, availableSlots);
    for (const taskId of runnableTaskIds) {
      const assignedAgentId = this.options.allocateAgentId(taskId);
      this.claimedTaskIds.add(taskId);
      this.graph.markRunning(taskId);
      this.graph.assignAgent(taskId, assignedAgentId);
      actions.push({ action: "start-task", taskId, assignedAgentId });
    }
    if (actions.length > 0) {
      await this.persistChain();
    }
    return actions;
  }

  /** Worker 完成任务后回写：成功或失败，并释放领取锁。 */
  async finishTask(
    taskId: string,
    outcome: "done" | "failed",
    resultLocation: string | null,
  ): Promise<void> {
    if (!this.claimedTaskIds.has(taskId)) {
      // 任务已被取消/重新指派等路径结算：视为过期结果，幂等忽略
      return;
    }
    this.claimedTaskIds.delete(taskId);
    if (outcome === "done") {
      this.graph.markDone(taskId, resultLocation);
    } else {
      this.graph.markFailed(taskId);
      this.graph.propagateFailureToDownstream(taskId);
    }
    await this.persistChain();
  }

  /** Worker 报告无法继续（如模糊/等待人工）：任务回 pending，释放锁。 */
  async releaseTaskBackToPending(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  /**
   * 任务进入 blocked 等待人工裁决（如 permission-ask），
   * 不会自动重新调度；裁决后经 unblockTask 恢复。
   */
  async blockTaskForHumanDecision(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markBlocked(taskId);
    await this.persistChain();
  }

  /** 取消：释放锁并将任务置为 pending（由人工裁决后决定 retry/reassign）。 */
  async cancelTask(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  async reassignTask(taskId: string): Promise<ScheduleAction> {
    if (this.claimedTaskIds.has(taskId)) {
      this.claimedTaskIds.delete(taskId);
    }
    this.graph.markPendingForRetry(taskId);
    const assignedAgentId = this.options.allocateAgentId(taskId);
    this.graph.assignAgent(taskId, assignedAgentId);
    await this.persistChain();
    return { action: "reassign-task", taskId, assignedAgentId };
  }

  /** 阻塞等待人工裁决的任务重新进入可运行集合。 */
  async unblockTask(taskId: string): Promise<void> {
    const node = this.graph.getNode(taskId);
    if (node?.status === "pending") {
      return;
    }
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  private collectDownstreamBlocks(actions: ScheduleAction[]): void {
    // 传播已在 finishTask 内完成；此处仅将 pending→blocked 的变更产出动作提示
    for (const taskId of this.graph.getTaskIds()) {
      const node = this.graph.getNode(taskId);
      if (node?.status === "blocked") {
        actions.push({ action: "block-task", taskId, reason: "上游任务失败" });
      }
    }
  }

  private async persistChain(): Promise<void> {
    await this.options.taskStore.updateTaskChain(this.missionId, (current) => {
      const previousRevision = current?.revision ?? 0;
      return {
        schemaVersion: TASK_CHAIN_SCHEMA_VERSION,
        missionId: this.missionId,
        revision: previousRevision + 1,
        updatedAtIso: new Date().toISOString(),
        tasks: this.graph.getNodes(),
      };
    });
  }
}
