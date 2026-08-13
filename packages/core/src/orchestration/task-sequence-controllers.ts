/**
 * 任务序列管理/状态控制器（T05C / ADR-0013）。
 * - TaskSequenceManageController：发布、插入、状态迁移、取消、打包；
 *   任何删除、覆盖、改序、取消和清理先走存储自动备份；全部变更记录认证来源。
 * - TaskSequenceStatusController：一致 revision 的只读快照、ready set、
 *   阻塞原因、顺序解释与任务包状态；不改变 busy 状态或序列顺序。
 *
 * 权限：模型不得通过填写发布者 ID 获得他人视图/越权改序——actor 身份由
 * harness 注入（调用方传入），本层按注入身份校验，不信任模型输入。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type {
  AgentTaskNode,
  AgentTaskSequenceDocument,
  AgentTaskSequenceSnapshot,
  TaskSourceKind,
} from "../core/types.js";
import type { AgentTaskSequenceStore } from "./agent-task-sequence-store.js";
import { TaskBundlePlanner } from "./task-bundle-planner.js";
import { TaskPriorityPolicy } from "./task-priority-policy.js";
import { TaskSequencePartialOrder } from "./task-sequence-partial-order.js";

export interface ActorIdentity {
  sourceKind: TaskSourceKind;
  actorId: string;
}

export interface PublishTaskSequenceInput {
  ownerAgentInstanceId: string;
  actor: ActorIdentity;
  sequenceId: string;
  firstTask: {
    taskId: string;
    title: string;
    priorityTier: number | null;
    externalReference: string | null;
  };
}

export interface InsertTaskInput {
  ownerAgentInstanceId: string;
  actor: ActorIdentity;
  sequenceId: string;
  expectedRevision: number;
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
}

export interface TransitionTaskStatusInput {
  ownerAgentInstanceId: string;
  actor: ActorIdentity;
  sequenceId: string;
  expectedRevision: number;
  taskId: string;
  nextStatus: AgentTaskNode["status"];
  blockReason: string | null;
}

export interface CreateTaskBundleInput {
  ownerAgentInstanceId: string;
  actor: ActorIdentity;
  sequenceId: string;
  expectedRevision: number;
  taskIds: string[];
  boundAgentInstanceId: string;
  requestedPriorityTier: number | null;
}

export interface CancelTaskInput {
  ownerAgentInstanceId: string;
  actor: ActorIdentity;
  sequenceId: string;
  expectedRevision: number;
  taskId: string;
  cancelReason: string;
}

export class TaskSequenceManageController {
  private readonly priorityPolicy = new TaskPriorityPolicy();
  private readonly bundlePlanner = new TaskBundlePlanner();
  /** 创建序号计数器：保证同毫秒内多个任务的稳定排序可重放。 */
  private ordinalCounter = 0;

  constructor(private readonly store: AgentTaskSequenceStore) {}

  /** 创建序列并发布首个任务。首任务同样必须带锚点约束不可变：发布即创建。 */
  async publishSequence(
    input: PublishTaskSequenceInput,
  ): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const existingSequence = await this.store.readSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
    );
    if (existingSequence !== null) {
      throw new DomainError(
        "invalid-task-chain",
        `序列已存在: ${input.sequenceId}`,
      );
    }
    const priorityTier = this.priorityPolicy.resolvePriorityTier({
      sourceKind: input.actor.sourceKind,
      requestedPriorityTier: input.firstTask.priorityTier,
    });
    const document: AgentTaskSequenceDocument = {
      schemaVersion: 1,
      sequenceId: input.sequenceId,
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      nodes: [
        this.buildNode(input.firstTask.taskId, input.firstTask.title, {
          priorityTier,
          externalReference: input.firstTask.externalReference,
          actor: input.actor,
        }),
      ],
      bundles: [],
      auditEntries: [],
    };
    const initialDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      0,
      (current) => {
        if (current !== null) {
          throw new DomainError(
            "invalid-task-chain",
            `序列已存在: ${input.sequenceId}`,
          );
        }
        return document;
      },
    );
    const appendedDocument = await this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      initialDocument.revision,
      input.actor,
      "publish",
      `发布序列 ${input.sequenceId} 并创建首任务 ${input.firstTask.taskId}`,
    );
    return appendedDocument;
  }

  /** 插入新任务：可指定直接前驱/后继锚点；环与未知锚点被拒绝。 */
  async insertTask(input: InsertTaskInput): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const priorityTier = this.priorityPolicy.resolvePriorityTier({
      sourceKind: input.actor.sourceKind,
      requestedPriorityTier: input.task.priorityTier,
    });
    const insertedDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      input.expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const partialOrder = new TaskSequencePartialOrder(sequence.nodes);
        const newNode = this.buildNode(input.task.taskId, input.task.title, {
          priorityTier,
          externalReference: input.task.externalReference,
          actor: input.actor,
        });
        partialOrder.insertNode(newNode, {
          predecessorTaskIds: input.anchor.predecessorTaskIds,
          successorTaskIds: input.anchor.successorTaskIds,
        });
        return this.withNextRevision(sequence, partialOrder.getNodes());
      },
    );
    return this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      insertedDocument.revision,
      input.actor,
      "insert",
      `插入任务 ${input.task.taskId}`,
    );
  }

  /** 状态迁移：pending → running/done/failed/blocked；blocked → pending 等。 */
  async transitionTaskStatus(
    input: TransitionTaskStatusInput,
  ): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const transitionedDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      input.expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const partialOrder = new TaskSequencePartialOrder(sequence.nodes);
        const allowedPreviousStatuses =
          input.nextStatus === "pending"
            ? (["running", "blocked", "failed"] as const)
            : (["pending", "blocked"] as const);
        const transitionedNode = partialOrder.transitionStatus(
          input.taskId,
          input.nextStatus,
          [...allowedPreviousStatuses],
          input.blockReason,
        );
        if (input.nextStatus === "blocked") {
          transitionedNode.blockReason = input.blockReason;
        }
        return this.withNextRevision(sequence, partialOrder.getNodes());
      },
    );
    return this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      transitionedDocument.revision,
      input.actor,
      "status-change",
      `任务 ${input.taskId} → ${input.nextStatus}`,
    );
  }

  /** 取消任务：仅发布者（或序列 owner）可取消；记录原因并保留历史。 */
  async cancelTask(input: CancelTaskInput): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const cancelledDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      input.expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const partialOrder = new TaskSequencePartialOrder(sequence.nodes);
        const node = partialOrder.getNode(input.taskId);
        if (node === undefined) {
          throw new DomainError(
            "dependency-not-found",
            `任务不存在: ${input.taskId}`,
          );
        }
        if (node.status === "done" || node.status === "cancelled") {
          throw new DomainError(
            "invalid-task-chain",
            `任务 ${input.taskId} 当前状态 ${node.status} 不可取消`,
          );
        }
        const cancelledNode = partialOrder.transitionStatus(
          input.taskId,
          "cancelled",
          ["pending", "running", "blocked", "failed"],
          input.cancelReason,
        );
        if (cancelledNode.status !== "cancelled") {
          throw new DomainError(
            "invalid-task-chain",
            `取消任务 ${input.taskId} 失败`,
          );
        }
        return this.withNextRevision(sequence, partialOrder.getNodes());
      },
    );
    return this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      cancelledDocument.revision,
      input.actor,
      "cancel",
      `取消任务 ${input.taskId}（${input.cancelReason}）`,
    );
  }

  /** 创建任务包：链校验 + 绑定三级 Agent；失败或阻塞节点的后继不得执行。 */
  async createTaskBundle(
    input: CreateTaskBundleInput,
  ): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const bundledDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      input.expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const bundleRecord = this.bundlePlanner.createBundle({
          sequence,
          taskIds: input.taskIds,
          boundAgentInstanceId: input.boundAgentInstanceId,
          requestedPriorityTier: input.requestedPriorityTier,
        });
        return {
          ...this.withNextRevision(sequence, sequence.nodes),
          bundles: [...sequence.bundles, bundleRecord],
        };
      },
    );
    return this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      bundledDocument.revision,
      input.actor,
      "bundle-create",
      `创建任务包（绑定 ${input.boundAgentInstanceId}，含 ${input.taskIds.length} 个任务）`,
    );
  }

  /** 更新任务包状态（prepared → active → completed/failed）。 */
  async transitionBundleStatus(input: {
    ownerAgentInstanceId: string;
    actor: ActorIdentity;
    sequenceId: string;
    expectedRevision: number;
    bundleId: string;
    nextStatus: "active" | "completed" | "failed";
  }): Promise<AgentTaskSequenceDocument> {
    this.assertActorAllowedToManage(input.actor, input.ownerAgentInstanceId);
    const transitionedDocument = await this.store.updateSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
      input.expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const bundle = sequence.bundles.find(
          (candidate) => candidate.bundleId === input.bundleId,
        );
        if (bundle === undefined) {
          throw new DomainError(
            "task-bundle-invalid",
            `任务包不存在: ${input.bundleId}`,
          );
        }
        bundle.status = input.nextStatus;
        return this.withNextRevision(sequence, sequence.nodes);
      },
    );
    return this.appendAuditEntry(
      input.ownerAgentInstanceId,
      input.sequenceId,
      transitionedDocument.revision,
      input.actor,
      "bundle-status",
      `任务包 ${input.bundleId} → ${input.nextStatus}`,
    );
  }

  private assertActorAllowedToManage(
    actor: ActorIdentity,
    ownerAgentInstanceId: string,
  ): void {
    if (actor.sourceKind === "user") {
      return;
    }
    if (actor.actorId !== ownerAgentInstanceId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `${actor.sourceKind} ${actor.actorId} 无权管理序列 ${ownerAgentInstanceId}`,
      );
    }
  }

  private buildNode(
    taskId: string,
    title: string,
    options: {
      priorityTier: number;
      externalReference: string | null;
      actor: ActorIdentity;
    },
  ): AgentTaskNode {
    this.ordinalCounter += 1;
    return {
      taskId,
      title,
      dependsOn: [],
      sourceKind: options.actor.sourceKind,
      publisherId: options.actor.actorId,
      priorityTier: options.priorityTier,
      status: "pending",
      blockReason: null,
      externalReference: options.externalReference,
      sequenceOrdinal: Date.now() * 1000 + this.ordinalCounter,
      createdAtIso: new Date().toISOString(),
    };
  }

  private requireSequence(
    current: AgentTaskSequenceDocument | null,
  ): AgentTaskSequenceDocument {
    if (current === null) {
      throw new DomainError(
        "task-sequence-not-found",
        "序列不存在，请先发布",
      );
    }
    return current;
  }

  private withNextRevision(
    sequence: AgentTaskSequenceDocument,
    nodes: AgentTaskNode[],
  ): AgentTaskSequenceDocument {
    return {
      ...sequence,
      revision: sequence.revision + 1,
      updatedAtIso: new Date().toISOString(),
      nodes,
    };
  }

  private async appendAuditEntry(
    ownerAgentInstanceId: string,
    sequenceId: string,
    expectedRevision: number,
    actor: ActorIdentity,
    mutationKind:
      | "publish"
      | "insert"
      | "reorder"
      | "status-change"
      | "cancel"
      | "bundle-create"
      | "bundle-status",
    summary: string,
  ): Promise<AgentTaskSequenceDocument> {
    return this.store.updateSequence(
      ownerAgentInstanceId,
      sequenceId,
      expectedRevision,
      (current) => {
        const sequence = this.requireSequence(current);
        const auditEntry = {
          auditEntryId: `audit-${randomUUID()}`,
          recordedAtIso: new Date().toISOString(),
          mutationKind,
          actorSourceKind: actor.sourceKind,
          actorId: actor.actorId,
          summary,
        };
        return {
          ...sequence,
          revision: sequence.revision + 1,
          updatedAtIso: new Date().toISOString(),
          auditEntries: [...sequence.auditEntries, auditEntry],
        };
      },
    );
  }
}

export class TaskSequenceStatusController {
  constructor(private readonly store: AgentTaskSequenceStore) {}

  /**
   * 只读快照：返回一致 revision 的调度视图。
   * viewer 必须是序列 owner（Agent 查看自己发布/获授权观察的任务）
   * 或用户（可查看自己发布任务及其派生链）。
   */
  async getSnapshot(input: {
    ownerAgentInstanceId: string;
    sequenceId: string;
    viewer: ActorIdentity;
  }): Promise<AgentTaskSequenceSnapshot> {
    if (
      input.viewer.sourceKind !== "user" &&
      input.viewer.actorId !== input.ownerAgentInstanceId
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `${input.viewer.sourceKind} ${input.viewer.actorId} 无权查看序列 ${input.ownerAgentInstanceId}`,
      );
    }
    const sequence = await this.store.readSequence(
      input.ownerAgentInstanceId,
      input.sequenceId,
    );
    if (sequence === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `序列不存在: ${input.sequenceId}`,
      );
    }
    const partialOrder = new TaskSequencePartialOrder(sequence.nodes);
    return {
      sequenceId: sequence.sequenceId,
      ownerAgentInstanceId: sequence.ownerAgentInstanceId,
      revision: sequence.revision,
      nodes: partialOrder.getNodes(),
      readyTaskIds: partialOrder.getReadyTaskIds(),
      bundles: sequence.bundles.map((bundle) => ({ ...bundle })),
      orderExplanations: partialOrder.explainOrder(),
    };
  }
}
