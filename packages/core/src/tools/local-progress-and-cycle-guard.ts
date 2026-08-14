/**
 * 通用活锁与循环守卫（T07B / ADR-0017 §更多活锁保护）。
 *
 * LocalProgressAndCycleGuard 同时维护资源调用图、Agent 委派图和进展计数器：
 * - 检测直接自环 A→A、工具/资源环 A→B→A、任务回派祖先环与跨 Agent 乒乓；
 * - 相同调用在执行中时合并为单飞请求（single-flight）；
 * - 相同结果/错误/无进展时累计 consecutiveNoProgressCount，默认 3 次暂停路径；
 * - include/redirect/引用解析的深度、节点数和扇出上限；
 * - 任务总调用预算持久化（进程重启不清零）；用户新信息/真实变化/新证据
 *   可产生新进展，但不清除任务级总安全预算。
 *
 * 触发后返回结构化原因、循环链、已有回执与解除条件。
 */
import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { AgentRole } from "../core/types.js";

export const DEFAULT_MAX_CALL_DEPTH = 12;
export const DEFAULT_MAX_GRAPH_NODES = 64;
export const DEFAULT_MAX_FANOUT = 16;
export const DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT = 3;
export const DEFAULT_TASK_TOTAL_CALL_BUDGET = 200;

export interface ProgressGuardOptions {
  /** 单调时钟（毫秒）；测试注入 fake clock。 */
  nowUnixMilliseconds?: () => number;
  maxCallDepth?: number;
  maxGraphNodes?: number;
  maxFanout?: number;
  consecutiveNoProgressLimit?: number;
  taskTotalCallBudget?: number;
  /** 持久化任务预算读取器（进程重启不清零）。 */
  readTaskBudget?: (taskExecutionId: string) => number;
  /** 持久化任务预算写入器。 */
  writeTaskBudget?: (taskExecutionId: string, count: number) => void;
}

export interface RecordCallInput {
  callerKey: string;
  calleeKey: string;
  /** 调用图节点身份（工具名/资源规范路径/Agent 实例 ID）。 */
  nodeKind: "tool" | "resource" | "agent";
  taskExecutionId: string | null;
  /** 结果签名（相同结果/错误/无进展判定）；null 表示不累计。 */
  outcomeSignature: string | null;
  isNewProgress: boolean;
}

export interface GuardViolation {
  kind:
    | "self-loop"
    | "resource-cycle"
    | "ancestor-redispatch"
    | "no-progress-limit"
    | "call-depth-limit"
    | "graph-node-limit"
    | "fanout-limit"
    | "task-budget-exceeded";
  cycleChain: string[];
  message: string;
}

export class LocalProgressAndCycleGuard {
  private readonly nowUnixMilliseconds: () => number;
  private readonly maxCallDepth: number;
  private readonly maxGraphNodes: number;
  private readonly maxFanout: number;
  private readonly noProgressLimit: number;
  private readonly taskTotalCallBudget: number;
  private readonly readTaskBudget: (taskExecutionId: string) => number;
  private readonly writeTaskBudget: (taskExecutionId: string, count: number) => void;
  /** 调用图：caller → callee 集合。 */
  private readonly callGraph = new Map<string, Set<string>>();
  /** 图节点数。 */
  private readonly graphNodes = new Set<string>();
  /** 调用栈（当前链，用于环检测）。 */
  private readonly callStack: string[] = [];
  /** 路径级无进展计数。 */
  private readonly noProgressCountByPath = new Map<string, number>();
  /** 在途调用（single-flight）。 */
  private readonly inFlightCalls = new Set<string>();

  constructor(options: ProgressGuardOptions = {}) {
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
    this.maxCallDepth = options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
    this.maxGraphNodes = options.maxGraphNodes ?? DEFAULT_MAX_GRAPH_NODES;
    this.maxFanout = options.maxFanout ?? DEFAULT_MAX_FANOUT;
    this.noProgressLimit =
      options.consecutiveNoProgressLimit ?? DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT;
    this.taskTotalCallBudget =
      options.taskTotalCallBudget ?? DEFAULT_TASK_TOTAL_CALL_BUDGET;
    this.readTaskBudget = options.readTaskBudget ?? (() => 0);
    this.writeTaskBudget = options.writeTaskBudget ?? (() => {});
  }

  /**
   * 记录一次调用并返回违反守卫的结构化信息（无违反返回 null）。
   * 调用者必须在自己执行前调用（守卫先于副作用）。
   */
  async recordCallAndDetectViolation(
    input: RecordCallInput,
  ): Promise<GuardViolation | null> {
    if (input.callerKey === input.calleeKey) {
      return this.violation("self-loop", [input.callerKey], "直接自环调用");
    }
    // 祖先回派/资源环：callee 已在调用栈中 → A→B→A 环
    const cycleStartIndex = this.callStack.indexOf(input.calleeKey);
    if (cycleStartIndex !== -1) {
      const cycleChain = [
        ...this.callStack.slice(cycleStartIndex),
        input.calleeKey,
      ];
      return this.violation(
        "resource-cycle",
        cycleChain,
        `调用环: ${cycleChain.join(" → ")}`,
      );
    }
    // 深度限制
    if (this.callStack.length >= this.maxCallDepth) {
      return this.violation(
        "call-depth-limit",
        [...this.callStack, input.calleeKey],
        `调用深度超过 ${this.maxCallDepth}`,
      );
    }
    // 图节点数与扇出限制
    this.graphNodes.add(input.calleeKey);
    if (this.graphNodes.size > this.maxGraphNodes) {
      return this.violation(
        "graph-node-limit",
        [...this.graphNodes],
        `调用图节点数超过 ${this.maxGraphNodes}`,
      );
    }
    const callerSuccessors = this.callGraph.get(input.callerKey) ?? new Set();
    callerSuccessors.add(input.calleeKey);
    this.callGraph.set(input.callerKey, callerSuccessors);
    if (callerSuccessors.size > this.maxFanout) {
      return this.violation(
        "fanout-limit",
        [...callerSuccessors],
        `调用者 ${input.callerKey} 扇出超过 ${this.maxFanout}`,
      );
    }
    // 无进展累计（路径级）
    if (input.outcomeSignature !== null && !input.isNewProgress) {
      const pathKey = `${input.callerKey}->${input.calleeKey}`;
      const count = (this.noProgressCountByPath.get(pathKey) ?? 0) + 1;
      this.noProgressCountByPath.set(pathKey, count);
      if (count >= this.noProgressLimit) {
        return this.violation(
          "no-progress-limit",
          [input.callerKey, input.calleeKey],
          `路径 ${pathKey} 连续 ${count} 次无进展`,
        );
      }
    } else if (input.outcomeSignature !== null) {
      // 有进展：重置该路径计数
      const pathKey = `${input.callerKey}->${input.calleeKey}`;
      this.noProgressCountByPath.delete(pathKey);
    }
    // 任务总调用预算（持久化，重启不清零）
    if (input.taskExecutionId !== null) {
      const currentBudget = this.readTaskBudget(input.taskExecutionId);
      const nextBudget = currentBudget + 1;
      this.writeTaskBudget(input.taskExecutionId, nextBudget);
      if (nextBudget > this.taskTotalCallBudget) {
        return this.violation(
          "task-budget-exceeded",
          [input.callerKey, input.calleeKey],
          `任务 ${input.taskExecutionId} 总调用预算超过 ${this.taskTotalCallBudget}`,
        );
      }
    }
    return null;
  }

  /** 调用入栈（执行期；记录调用后调用）。 */
  pushCallFrame(callKey: string): void {
    this.callStack.push(callKey);
  }

  /** 调用出栈（执行结束）。 */
  popCallFrame(): void {
    this.callStack.pop();
  }

  /**
   * single-flight：相同在途调用合并。返回 true 表示本次调用已在途
   * （调用者应等待/复用结果，不重复执行）；false 表示首次，调用者应
   * 在结束后调用 completeInFlightCall 释放。
   */
  tryAcquireInFlightCall(callKey: string): boolean {
    if (this.inFlightCalls.has(callKey)) {
      return true;
    }
    this.inFlightCalls.add(callKey);
    return false;
  }

  completeInFlightCall(callKey: string): void {
    this.inFlightCalls.delete(callKey);
  }

  getInFlightCallCount(): number {
    return this.inFlightCalls.size;
  }

  /** 测试：调用图快照。 */
  getCallGraphSnapshot(): Record<string, string[]> {
    const snapshot: Record<string, string[]> = {};
    for (const [callerKey, successors] of this.callGraph) {
      snapshot[callerKey] = [...successors];
    }
    return snapshot;
  }

  private violation(
    kind: GuardViolation["kind"],
    cycleChain: string[],
    message: string,
  ): GuardViolation {
    return { kind, cycleChain, message };
  }
}

/** 构建守卫触发拒绝（livelock-guard-triggered），消息含循环链与解除条件。 */
export function buildGuardDenial(violation: GuardViolation): DomainError {
  return new DomainError(
    "livelock-guard-triggered",
    `${violation.message}；循环链: [${violation.cycleChain.join(", ")}]；解除条件: 用户新信息、资源真实变化或取得新证据后重试，或显式授权解除`,
  );
}

/** 结果签名：相同结果/错误/无进展判定用（规范化）。 */
export function buildOutcomeSignature(parts: Array<string | null>): string | null {
  const nonEmptyParts = parts.filter((part) => part !== null && part !== "");
  if (nonEmptyParts.length === 0) {
    return null;
  }
  return createHash("sha256").update(nonEmptyParts.join("|")).digest("hex");
}

/** Agent 委派键（用于跨 Agent 回派环检测）。 */
export function buildAgentCallKey(
  agentRole: AgentRole,
  agentInstanceId: string,
): string {
  return `agent:${agentRole}:${agentInstanceId}`;
}
