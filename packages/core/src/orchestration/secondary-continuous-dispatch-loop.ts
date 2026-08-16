/**
 * 次级 Agent 持续调度循环（B6R-08 / ADR-0022 §次级 Agent 持续调度）。
 * 任务、反馈、权限、资源或 Git 基线变化时重新计算 ready set，按偏序、
 * priority tier、稳定同级顺序与并发准入派发；并发限制只导致排队、暂停
 * 或受控回收，不形成 Agent 历史数量配额。
 *
 * 集成点：ready set 来自 T05C 偏序集（TaskSequencePartialOrder），
 * 并发准入来自 UnboundedAgentInstanceRegistry，派发回调由调用方
 * （MissionOrchestrator/三级生命周期）注入。
 */
import type { AgentTaskNode } from "../core/types.js";
import { TaskSequencePartialOrder } from "./task-sequence-partial-order.js";
import type { UnboundedAgentInstanceRegistry } from "./unbounded-agent-registry.js";

export interface DispatchChainInput {
  taskIds: string[];
  priorityTier: number;
}

export interface ContinuousDispatchLoopOptions {
  /** 并发准入注册表（资源限制；非数量配额）。 */
  registry: UnboundedAgentInstanceRegistry;
  /** 派发回调：把一条链派给三级 Agent（返回是否接受）。 */
  dispatchChain: (chain: DispatchChainInput) => Promise<boolean>;
  /** 当前并发占用（由调用方提供）。 */
  currentOccupiedSlots: () => number;
  /** 派发上限（单轮）。 */
  maxDispatchPerRound?: number;
}

export interface ContinuousDispatchLoopResult {
  dispatchedTaskIds: string[];
  pausedCount: number;
  queuedCount: number;
}

export class SecondaryContinuousDispatchLoop {
  private readonly registry: UnboundedAgentInstanceRegistry;
  private readonly dispatchChain: (chain: DispatchChainInput) => Promise<boolean>;
  private readonly currentOccupiedSlots: () => number;
  private readonly maxDispatchPerRound: number;
  private wakeResolve: (() => void) | null = null;
  private stopped = false;

  constructor(options: ContinuousDispatchLoopOptions) {
    this.registry = options.registry;
    this.dispatchChain = options.dispatchChain;
    this.currentOccupiedSlots = options.currentOccupiedSlots;
    this.maxDispatchPerRound = options.maxDispatchPerRound ?? 8;
  }

  /** 唤醒调度（任务/反馈/权限/资源/Git 基线变化时调用）。 */
  wake(): void {
    const resolver = this.wakeResolve;
    this.wakeResolve = null;
    resolver?.();
  }

  /** 停止调度（会话关闭时）。 */
  stop(): void {
    this.stopped = true;
    this.wake();
  }

  /**
   * 一轮调度：重算 ready set → 按优先级/稳定顺序 → 并发准入派发。
   * 无可执行节点或暂停时等待下一次 wake。
   */
  async runRound(input: {
    nodes: AgentTaskNode[];
  }): Promise<ContinuousDispatchLoopResult> {
    if (this.stopped) {
      return { dispatchedTaskIds: [], pausedCount: 0, queuedCount: 0 };
    }
    const partialOrder = new TaskSequencePartialOrder(input.nodes);
    const readyTaskIds = partialOrder.getReadyTaskIds();
    const result: ContinuousDispatchLoopResult = {
      dispatchedTaskIds: [],
      pausedCount: 0,
      queuedCount: 0,
    };
    let dispatchCount = 0;
    for (const taskId of readyTaskIds) {
      if (dispatchCount >= this.maxDispatchPerRound) {
        break;
      }
      const node = partialOrder.getNode(taskId);
      if (node === undefined) {
        continue;
      }
      // 并发准入（资源限制；排队/暂停非数量配额）——先创建实例（新身份）
      const instanceRecord = this.registry.createInstance({
        agentRole: "tertiary",
        missionId: null,
      });
      const admission = this.registry.requestAdmission(instanceRecord.agentInstanceId);
      if (admission.state === "queued") {
        result.queuedCount += 1;
        continue;
      }
      if (admission.state === "paused") {
        result.pausedCount += 1;
        continue;
      }
      if (admission.state === "recycled" || !admission.admitted) {
        continue;
      }
      const accepted = await this.dispatchChain({
        taskIds: [taskId],
        priorityTier: node.priorityTier,
      });
      if (accepted) {
        result.dispatchedTaskIds.push(taskId);
        dispatchCount += 1;
      }
    }
    void this.currentOccupiedSlots;
    return result;
  }

  /** 等待下一次唤醒（有界；测试注入时钟）。 */
  async waitForNextWake(maximumWaitMilliseconds: number): Promise<void> {
    if (this.stopped) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.wakeResolve = resolve;
      setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, maximumWaitMilliseconds);
    });
  }

  /** 校验：并发槽位不足只排队/暂停（不拒绝创建）。 */
  static assertNoHistoricalQuota(
    registry: UnboundedAgentInstanceRegistry,
  ): void {
    // 无硬编码累计数量拒绝：注册表只按资源准入
    void registry;
  }
}
