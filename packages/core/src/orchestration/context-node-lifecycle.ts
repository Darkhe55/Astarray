/**
 * 上下文节点生命周期控制（T09A-R1-03）。
 *
 * 产品任务执行时：
 * 1) 为任务建立局部上下文节点（活跃）；
 * 2) 成功后标记 locally-verified；
 * 3) 按人工验收策略处置：
 *    - continue-with-deferred-review（Devolve 默认）：关闭为 deferred-review-closed，
 *      生成真实关闭胶囊并写入层级 ≤1 的延迟人工核验任务；
 *    - block-until-verified（Assist 默认）：节点转 awaiting-user-acceptance，
 *      生成等待人工验收的胶囊，不自动通过、不自动关闭。
 */
import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { ContextClosureCapsuleStore } from "./context-closure-capsule-store.js";
import type {
  ContextClosureCapsule,
  DeferredHumanVerificationTask,
} from "./context-closure-schemas.js";
import type {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "./human-verification-controller.js";
import { CLOSED_CONTEXT_NODE_STATES } from "./local-context-graph-store.js";
import type { LocalContextGraphStore } from "./local-context-graph-store.js";

export interface ContextNodeLifecycleOptions {
  graphStore: LocalContextGraphStore;
  capsuleStore: ContextClosureCapsuleStore;
  humanVerificationController: HumanVerificationController;
  humanVerificationPolicyStore: HumanVerificationPolicyStore;
  nowMilliseconds?: () => number;
}

export interface CompleteTaskNodeInput {
  ownerAgentInstanceId: string;
  missionId: string;
  taskIdentifier: string;
  taskDescription: string;
  summaryText: string;
  modeKey: string;
}

export interface CompleteTaskNodeResult {
  contextNodeIdentifier: string;
  graphRevision: number;
  verificationPolicy: string;
  capsule: ContextClosureCapsule;
  deferredVerificationTask: DeferredHumanVerificationTask | null;
}

export class ContextNodeLifecycleController {
  private readonly graphStore: LocalContextGraphStore;
  private readonly capsuleStore: ContextClosureCapsuleStore;
  private readonly humanVerificationController: HumanVerificationController;
  private readonly humanVerificationPolicyStore: HumanVerificationPolicyStore;
  private readonly nowMilliseconds: () => number;

  constructor(options: ContextNodeLifecycleOptions) {
    this.graphStore = options.graphStore;
    this.capsuleStore = options.capsuleStore;
    this.humanVerificationController = options.humanVerificationController;
    this.humanVerificationPolicyStore = options.humanVerificationPolicyStore;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /** 建立/复用任务节点，返回当前图 revision 与节点标识。 */
  async beginTaskNode(input: {
    ownerAgentInstanceId: string;
    missionId: string;
    taskIdentifier: string;
    taskDescription: string;
  }): Promise<{ contextNodeIdentifier: string; graphRevision: number }> {
    const contextNodeIdentifier = buildContextNodeIdentifier(input.taskIdentifier);
    let graph = await this.graphStore.readGraph(
      input.ownerAgentInstanceId,
      input.missionId,
    );
    if (graph === null) {
      graph = await this.graphStore.createGraph({
        graphIdentifier: input.missionId,
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        missionId: input.missionId,
      });
    }
    if (graph.nodes.some((node) => node.contextNodeIdentifier === contextNodeIdentifier)) {
      return { contextNodeIdentifier, graphRevision: graph.revision };
    }
    const next = await this.graphStore.addNode({
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      graphIdentifier: input.missionId,
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier,
      missionId: input.missionId,
      contentFingerprint: sha256Fingerprint(input.taskDescription),
      state: "active",
    });
    return { contextNodeIdentifier, graphRevision: next.revision };
  }

  /** 任务成功：标记 locally-verified（CAS 以当前 revision 为准）。 */
  async markTaskNodeVerified(input: {
    ownerAgentInstanceId: string;
    missionId: string;
    contextNodeIdentifier: string;
  }): Promise<void> {
    const graph = await this.graphStore.readGraph(
      input.ownerAgentInstanceId,
      input.missionId,
    );
    if (graph === null) {
      return;
    }
    const node = graph.nodes.find(
      (candidate) => candidate.contextNodeIdentifier === input.contextNodeIdentifier,
    );
    if (
      node === undefined ||
      (ALREADY_MARKED_NODE_STATES as readonly string[]).includes(node.state)
    ) {
      return;
    }
    await this.graphStore.markNodeState({
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      graphIdentifier: input.missionId,
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: input.contextNodeIdentifier,
      state: "locally-verified",
    });
  }

  /**
   * 任务完成的产品级收口：按策略关闭/等待 + 生成真实胶囊与延迟核验任务。
   *
   * T12A-R1-03：本方法是跨存储多步写入（图状态 → 关闭胶囊 → 延迟核验任务），
   * 必须可在任意崩溃点后重放：已完成的步骤跳过、既有胶囊按 (节点, revision)
   * 复用、延迟核验任务按胶囊哈希复用或按 revision 追加，绝不重复或覆盖丢失。
   */
  async completeTaskNode(
    input: CompleteTaskNodeInput,
  ): Promise<CompleteTaskNodeResult> {
    const begun = await this.beginTaskNode({
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
      taskIdentifier: input.taskIdentifier,
      taskDescription: input.taskDescription,
    });
    await this.markTaskNodeVerified({
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
    });
    const verificationPolicy = await this.humanVerificationPolicyStore.getPolicy({
      modeKey: input.modeKey === "devolve" ? "devolve" : "assist",
      customProfileDefaultPolicy: "block-until-verified",
    });
    const desiredState: "deferred-review-closed" | "awaiting-user-acceptance" =
      verificationPolicy === "continue-with-deferred-review"
        ? "deferred-review-closed"
        : "awaiting-user-acceptance";
    let graph = await this.graphStore.readGraph(
      input.ownerAgentInstanceId,
      input.missionId,
    );
    const existingNode =
      graph?.nodes.find(
        (candidate) =>
          candidate.contextNodeIdentifier === begun.contextNodeIdentifier,
      ) ?? null;
    const isAlreadyClosed =
      existingNode !== null &&
      (CLOSED_CONTEXT_NODE_STATES as readonly string[]).includes(
        existingNode.state,
      );
    // 已关闭节点保持既有终态（重放不制造第二种终态、不膨胀 revision）。
    const actualState:
      | "awaiting-user-acceptance"
      | "accepted-closed"
      | "deferred-review-closed"
      | null = isAlreadyClosed
      ? existingNode.state === "superseded"
        ? null
        : (existingNode.state as
            | "accepted-closed"
            | "deferred-review-closed")
      : desiredState;
    let terminalRevision = graph?.revision ?? begun.graphRevision;
    if (
      graph !== null &&
      existingNode !== null &&
      existingNode.state !== actualState &&
      !isAlreadyClosed
    ) {
      graph =
        actualState === "deferred-review-closed"
          ? await this.graphStore.closeNode({
              ownerAgentInstanceId: input.ownerAgentInstanceId,
              graphIdentifier: input.missionId,
              expectedGraphRevision: graph.revision,
              contextNodeIdentifier: begun.contextNodeIdentifier,
              targetState: "deferred-review-closed",
            })
          : await this.graphStore.markNodeState({
              ownerAgentInstanceId: input.ownerAgentInstanceId,
              graphIdentifier: input.missionId,
              expectedGraphRevision: graph.revision,
              contextNodeIdentifier: begun.contextNodeIdentifier,
              state: "awaiting-user-acceptance",
            });
      terminalRevision = graph.revision;
    }
    if (actualState === null) {
      throw new DomainError(
        "context-node-not-closable",
        "已 superseded 节点缺少对应关闭胶囊，需人工对账: " +
          begun.contextNodeIdentifier,
      );
    }
    const capsule = await this.ensureClosureCapsule({
      input,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      graphRevision: terminalRevision,
      verificationState: actualState,
    });
    let deferredVerificationTask: DeferredHumanVerificationTask | null = null;
    if (actualState === "deferred-review-closed") {
      deferredVerificationTask = await this.ensureDeferredVerificationTask({
        input,
        contextNodeIdentifier: begun.contextNodeIdentifier,
        graphRevision: terminalRevision,
        closureCapsuleHash: capsule.contentHash,
      });
    }
    return {
      contextNodeIdentifier: begun.contextNodeIdentifier,
      graphRevision: terminalRevision,
      verificationPolicy,
      capsule,
      deferredVerificationTask,
    };
  }

  /** 关闭胶囊按 (节点, 图 revision) 幂等复用；不同 revision 各留一份，不覆盖。 */
  private async ensureClosureCapsule(input: {
    input: CompleteTaskNodeInput;
    contextNodeIdentifier: string;
    graphRevision: number;
    verificationState:
      | "deferred-review-closed"
      | "awaiting-user-acceptance"
      | "accepted-closed";
  }): Promise<ContextClosureCapsule> {
    const existingCapsules = (
      await this.capsuleStore.listCapsules(input.input.ownerAgentInstanceId)
    ).filter(
      (capsule) => capsule.contextNodeIdentifier === input.contextNodeIdentifier,
    );
    const reusable = existingCapsules.find(
      (capsule) => capsule.contextGraphRevision === input.graphRevision,
    );
    if (reusable !== undefined) {
      return reusable;
    }
    return this.capsuleStore.createCapsule({
      capsuleIdentifier:
        "capsule-" + input.contextNodeIdentifier + "-" + input.graphRevision,
      ownerAgentInstanceId: input.input.ownerAgentInstanceId,
      contextNodeIdentifier: input.contextNodeIdentifier,
      missionId: input.input.missionId,
      contextGraphRevision: input.graphRevision,
      finalDecisionSummary: input.input.summaryText.slice(0, 200),
      inputSummary: input.input.taskDescription.slice(0, 200),
      outputSummary: input.input.summaryText.slice(0, 400),
      verificationState: input.verificationState,
      informationSource: {
        sourceType: "agent",
        agentInstanceId: input.input.ownerAgentInstanceId,
      },
      reopenCondition: "用户否决或依赖真实变化时重开该节点",
    });
  }

  /**
   * 延迟核验任务幂等：同一胶囊哈希直接复用；不同 revision 追加新任务标识，
   * 旧任务保留（补充核验不重复、不丢失）。
   */
  private async ensureDeferredVerificationTask(input: {
    input: CompleteTaskNodeInput;
    contextNodeIdentifier: string;
    graphRevision: number;
    closureCapsuleHash: string;
  }): Promise<DeferredHumanVerificationTask> {
    const existingTasks =
      await this.humanVerificationController.listDeferredVerificationTasks(
        input.input.ownerAgentInstanceId,
      );
    const reusable = existingTasks.find(
      (task) =>
        task.contextNodeIdentifier === input.contextNodeIdentifier &&
        task.closureCapsuleHash === input.closureCapsuleHash,
    );
    if (reusable !== undefined) {
      return reusable;
    }
    const baseIdentifier = "verify-" + input.input.taskIdentifier;
    const hasBaseTask = existingTasks.some(
      (task) => task.taskIdentifier === baseIdentifier,
    );
    const taskIdentifier = hasBaseTask
      ? baseIdentifier + "-r" + input.graphRevision
      : baseIdentifier;
    const existingWithIdentifier = existingTasks.find(
      (task) => task.taskIdentifier === taskIdentifier,
    );
    if (existingWithIdentifier !== undefined) {
      return existingWithIdentifier;
    }
    return this.humanVerificationController.createDeferredVerificationTask({
      taskIdentifier,
      ownerAgentInstanceId: input.input.ownerAgentInstanceId,
      contextNodeIdentifier: input.contextNodeIdentifier,
      contextGraphRevision: input.graphRevision,
      closureCapsuleHash: input.closureCapsuleHash,
      humanSteps: "人工复核该任务的输出与风险后再追认",
      priorityTier: 1,
      risks: [],
    });
  }
}

/** 任务 → 上下文节点标识（恢复/重放必须与首次写入完全一致）。 */
export function buildContextNodeIdentifier(taskIdentifier: string): string {
  return "node-" + sanitizeNodeIdentifier(taskIdentifier);
}

/** 已推进过的节点状态：重复标记本地验收必须幂等跳过。 */
const ALREADY_MARKED_NODE_STATES = [
  "locally-verified",
  "awaiting-user-acceptance",
  "accepted-closed",
  "deferred-review-closed",
  "superseded",
] as const;

function sha256Fingerprint(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function sanitizeNodeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}