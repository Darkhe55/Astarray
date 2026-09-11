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

import type { ContextClosureCapsuleStore } from "./context-closure-capsule-store.js";
import type {
  ContextClosureCapsule,
  DeferredHumanVerificationTask,
} from "./context-closure-schemas.js";
import type {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "./human-verification-controller.js";
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
    const contextNodeIdentifier = "node-" + sanitizeNodeIdentifier(input.taskIdentifier);
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
    if (node === undefined || node.state === "locally-verified") {
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

  /** 任务完成的产品级收口：按策略关闭/等待 + 生成真实胶囊与延迟核验任务。 */
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
    let graph = await this.graphStore.readGraph(
      input.ownerAgentInstanceId,
      input.missionId,
    );
    const currentRevision = graph?.revision ?? begun.graphRevision;
    if (verificationPolicy === "continue-with-deferred-review") {
      graph = await this.graphStore.closeNode({
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        graphIdentifier: input.missionId,
        expectedGraphRevision: currentRevision,
        contextNodeIdentifier: begun.contextNodeIdentifier,
        targetState: "deferred-review-closed",
      });
    } else {
      graph = await this.graphStore.markNodeState({
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        graphIdentifier: input.missionId,
        expectedGraphRevision: currentRevision,
        contextNodeIdentifier: begun.contextNodeIdentifier,
        state: "awaiting-user-acceptance",
      });
    }
    const capsule = await this.capsuleStore.createCapsule({
      capsuleIdentifier:
        "capsule-" + begun.contextNodeIdentifier + "-" + graph.revision,
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      contextNodeIdentifier: begun.contextNodeIdentifier,
      missionId: input.missionId,
      contextGraphRevision: graph.revision,
      finalDecisionSummary: input.summaryText.slice(0, 200),
      inputSummary: input.taskDescription.slice(0, 200),
      outputSummary: input.summaryText.slice(0, 400),
      verificationState:
        verificationPolicy === "continue-with-deferred-review"
          ? "deferred-review-closed"
          : "awaiting-user-acceptance",
      informationSource: {
        sourceType: "agent",
        agentInstanceId: input.ownerAgentInstanceId,
      },
      reopenCondition: "用户否决或依赖真实变化时重开该节点",
    });
    let deferredVerificationTask: DeferredHumanVerificationTask | null = null;
    if (verificationPolicy === "continue-with-deferred-review") {
      deferredVerificationTask =
        await this.humanVerificationController.createDeferredVerificationTask({
          taskIdentifier: "verify-" + input.taskIdentifier,
          ownerAgentInstanceId: input.ownerAgentInstanceId,
          contextNodeIdentifier: begun.contextNodeIdentifier,
          contextGraphRevision: graph.revision,
          closureCapsuleHash: capsule.contentHash,
          humanSteps: "人工复核该任务的输出与风险后再追认",
          priorityTier: 1,
          risks: [],
        });
    }
    return {
      contextNodeIdentifier: begun.contextNodeIdentifier,
      graphRevision: graph.revision,
      verificationPolicy,
      capsule,
      deferredVerificationTask,
    };
  }
}

function sha256Fingerprint(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function sanitizeNodeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
