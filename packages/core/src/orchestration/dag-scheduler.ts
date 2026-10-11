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

  /**
   * 阻塞等待人工裁决的任务重新进入可运行集合。
   *
   * **2026-10-10 Linux 平台证据修复：迟到的 unblock 不得降级正在运行/已终态的任务。**
   *
   * 缺陷（`authorization-retry-closure` ① 在 WSL Ubuntu 上失败、Windows 上一直通过）：
   * 批准后的 `unblock` 指令是**异步**送达本调度器的，而调度循环可能已经**抢先**
   * 把任务重新领取并标记为 `running`。此前本方法只判 `pending`，否则一律
   * `markPendingForRetry` ⇒ 把**正在运行**的任务**降回 pending**，而领取集合并未释放。
   * 于是 worker 成功回写时 `finishTask("done")` 面对的是 `pending` 节点 ⇒
   * `非法状态迁移: <task> pending → done` ⇒ **成果已落盘却被误判为 blocked**。
   *
   * **不**放宽状态机（`pending → done` 必须继续非法，由
   * `tests/core/unit/task-graph-gaps.test.ts` 钉住），而是把本方法**幂等化**：
   * 只有 `pending`（已是目标态）与 `blocked`（真正等待裁决）才需要处理；
   * `running`/`done`/`failed` 下这是**冗余的迟到指令**，必须无操作。
   */
  async unblockTask(taskId: string): Promise<void> {
    const node = this.graph.getNode(taskId);
    const status = node?.status;
    /**
     * `pending` ⇒ 已是可运行态（幂等无操作）。
     * `running` ⇒ 重跑**已经在进行中**：降回 pending 会让"领取集合含此任务"
     *   与"图节点 pending"不一致，直接导致 `pending → done` 非法（见方法注释）。
     * `done`/`failed` ⇒ 已结案：不得复活，也不得把终态改回可运行。
     */
    if (
      status === "pending" ||
      status === "running" ||
      status === "done" ||
      status === "failed"
    ) {
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
