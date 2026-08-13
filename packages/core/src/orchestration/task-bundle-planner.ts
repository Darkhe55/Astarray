/**
 * 任务包规划（T05C / ADR-0013 §任务包）。
 * 次级 Agent 把偏序集中的一条真实有序链冻结为任务包派给一个具体三级 Agent。
 * 任务包是派发单位，不抹平包内节点：
 * - 节点必须形成链（相邻节点存在直接前驱关系）；
 * - 默认同一优先级层级；
 * - 任务包绑定具体三级 agentInstanceId 和创建时的序列 revision；
 * - 三级 Agent 按链依次完成，逐节点报告状态；失败或阻塞节点的后继不得执行。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type {
  AgentTaskNode,
  AgentTaskSequenceDocument,
  TaskBundleRecord,
} from "../core/types.js";

export interface TaskBundlePlanInput {
  sequence: AgentTaskSequenceDocument;
  taskIds: string[];
  boundAgentInstanceId: string;
  /** 打包方要求的优先级层级（必须与包内节点一致）。 */
  requestedPriorityTier: number | null;
}

export class TaskBundlePlanner {
  /**
   * 冻结任务包：校验链结构、优先层一致性与任务范围兼容。
   * 返回新包记录（不写入存储，由控制器持久化）。
   */
  createBundle(input: TaskBundlePlanInput): TaskBundleRecord {
    if (input.taskIds.length === 0) {
      throw new DomainError("task-bundle-invalid", "任务包不能为空");
    }
    const nodesByTaskId = new Map<string, AgentTaskNode>();
    for (const node of input.sequence.nodes) {
      nodesByTaskId.set(node.taskId, node);
    }
    for (const taskId of input.taskIds) {
      if (!nodesByTaskId.has(taskId)) {
        throw new DomainError(
          "dependency-not-found",
          `任务包包含未知任务: ${taskId}`,
        );
      }
    }
    if (new Set(input.taskIds).size !== input.taskIds.length) {
      throw new DomainError("task-bundle-invalid", "任务包内任务不能重复");
    }
    // 链校验：相邻任务必须存在直接前驱关系（taskIds[i+1] 的 dependsOn 含 taskIds[i]）。
    for (let index = 0; index < input.taskIds.length - 1; index++) {
      const currentTaskId = input.taskIds[index]!;
      const nextTaskId = input.taskIds[index + 1]!;
      const nextNode = nodesByTaskId.get(nextTaskId);
      if (nextNode === undefined || !nextNode.dependsOn.includes(currentTaskId)) {
        throw new DomainError(
          "task-bundle-invalid",
          `任务包必须形成链: ${currentTaskId} → ${nextTaskId} 缺少直接前驱关系`,
        );
      }
    }
    // 优先层一致性：包内节点默认同一优先级层级。
    const tiers = new Set(
      input.taskIds.map((taskId) => nodesByTaskId.get(taskId)!.priorityTier),
    );
    if (tiers.size > 1) {
      throw new DomainError(
        "task-bundle-invalid",
        `任务包内节点优先级层级不一致: [${[...tiers].join(", ")}]`,
      );
    }
    const effectiveTier = input.requestedPriorityTier ?? [...tiers][0]!;
    if (effectiveTier !== [...tiers][0]) {
      throw new DomainError(
        "task-bundle-invalid",
        `打包方指定层级 ${effectiveTier} 与包内节点层级 ${[...tiers][0]} 不一致`,
      );
    }
    // 链内任务必须可执行于同一执行者（仅校验结构：全部节点属于同一序列，
    // 且至少首节点当前为 pending）。
    const firstNode = nodesByTaskId.get(input.taskIds[0]!);
    if (firstNode === undefined || firstNode.status !== "pending") {
      throw new DomainError(
        "task-bundle-invalid",
        `任务包首节点 ${input.taskIds[0]} 必须处于 pending 状态`,
      );
    }
    // 包内其余节点不得已完成/已取消（打包失败的链无意义）。
    for (const taskId of input.taskIds.slice(1)) {
      const node = nodesByTaskId.get(taskId);
      if (node === undefined || node.status !== "pending") {
        throw new DomainError(
          "task-bundle-invalid",
          `任务包节点 ${taskId} 当前状态为 ${node?.status ?? "缺失"}，无法打包`,
        );
      }
    }
    return {
      bundleId: `bundle-${randomUUID()}`,
      boundAgentInstanceId: input.boundAgentInstanceId,
      sequenceRevision: input.sequence.revision,
      taskIds: [...input.taskIds],
      status: "prepared",
      createdAtIso: new Date().toISOString(),
    };
  }
}
