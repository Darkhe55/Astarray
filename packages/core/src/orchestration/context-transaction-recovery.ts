/**
 * 上下文事务恢复（T12A-R1-03）。
 *
 * 任务完成是跨存储多步写入：图节点终态 → 关闭胶囊 → 延迟核验任务。
 * 任一步之间进程中断都会留下部分提交状态。本服务：
 * 1) 只读对账（inspect）：报告缺口（终态/胶囊/补充任务）、陈旧胶囊 revision、
 *    延后片段数量与图 revision；
 * 2) 幂等重放（replay）：只补齐缺口，既有胶囊按 (节点, revision) 复用、
 *    补充任务按胶囊哈希复用或按 revision 追加，绝不重复写入或覆盖丢失；
 * 3) 不触碰预算、签字与延后片段存储（重启不清零、签字不跨 revision 复用）。
 */
import type { ContextClosureCapsuleStore } from "./context-closure-capsule-store.js";
import type {
  ContextClosureCapsule,
  DeferredHumanVerificationTask,
} from "./context-closure-schemas.js";
import {
  buildContextNodeIdentifier,
  ContextNodeLifecycleController,
} from "./context-node-lifecycle.js";
import { readDeferredGlobalContextFragments } from "./global-decision-selector.js";
import type {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "./human-verification-controller.js";
import type { LocalContextGraphStore } from "./local-context-graph-store.js";

export interface ContextTransactionRecoveryOptions {
  baseDirectory: string;
  graphStore: LocalContextGraphStore;
  capsuleStore: ContextClosureCapsuleStore;
  humanVerificationController: HumanVerificationController;
  humanVerificationPolicyStore: HumanVerificationPolicyStore;
  nowMilliseconds?: () => number;
}

export type ContextTransactionMissingPiece =
  | "terminal-context-state"
  | "closure-capsule"
  | "deferred-verification-task";

export interface ContextTransactionInspection {
  ownerAgentInstanceId: string;
  missionId: string;
  taskIdentifier: string;
  contextNodeIdentifier: string;
  graphRevision: number | null;
  nodeState: string | null;
  terminalState: "deferred-review-closed" | "awaiting-user-acceptance" | null;
  capsule: ContextClosureCapsule | null;
  deferredVerificationTask: DeferredHumanVerificationTask | null;
  deferredFragmentCount: number;
  missingPieces: ContextTransactionMissingPiece[];
  /** 存在旧 revision 胶囊但当前终态 revision 没有对应胶囊（陈旧，不得复用）。 */
  isStaleCapsuleRevision: boolean;
  isComplete: boolean;
}

export interface ContextTransactionReplayResult {
  inspection: ContextTransactionInspection;
  replayedActions: ContextTransactionMissingPiece[];
  /** 重放后状态一致（再次重放不会产生动作）。 */
  isReplayStable: boolean;
}

export interface InspectContextTransactionInput {
  ownerAgentInstanceId: string;
  missionId: string;
  taskIdentifier: string;
}

export interface ReplayContextTransactionInput
  extends InspectContextTransactionInput {
  taskDescription: string;
  summaryText: string;
  modeKey: string;
}

export class ContextTransactionRecoveryService {
  private readonly baseDirectory: string;
  private readonly graphStore: LocalContextGraphStore;
  private readonly capsuleStore: ContextClosureCapsuleStore;
  private readonly humanVerificationController: HumanVerificationController;
  private readonly lifecycle: ContextNodeLifecycleController;

  constructor(options: ContextTransactionRecoveryOptions) {
    this.baseDirectory = options.baseDirectory;
    this.graphStore = options.graphStore;
    this.capsuleStore = options.capsuleStore;
    this.humanVerificationController = options.humanVerificationController;
    this.lifecycle = new ContextNodeLifecycleController({
      graphStore: options.graphStore,
      capsuleStore: options.capsuleStore,
      humanVerificationController: options.humanVerificationController,
      humanVerificationPolicyStore: options.humanVerificationPolicyStore,
      ...(options.nowMilliseconds !== undefined
        ? { nowMilliseconds: options.nowMilliseconds }
        : {}),
    });
  }

  /** 只读对账：不写入任何存储。 */
  async inspect(
    input: InspectContextTransactionInput,
  ): Promise<ContextTransactionInspection> {
    const contextNodeIdentifier = buildContextNodeIdentifier(
      input.taskIdentifier,
    );
    const graph = await this.graphStore.readGraph(
      input.ownerAgentInstanceId,
      input.missionId,
    );
    const node =
      graph?.nodes.find(
        (candidate) => candidate.contextNodeIdentifier === contextNodeIdentifier,
      ) ?? null;
    const nodeState = node?.state ?? null;
    const terminalState =
      nodeState === "deferred-review-closed" ||
      nodeState === "awaiting-user-acceptance"
        ? nodeState
        : null;
    const capsules = (
      await this.capsuleStore.listCapsules(input.ownerAgentInstanceId)
    ).filter(
      (capsule) => capsule.contextNodeIdentifier === contextNodeIdentifier,
    );
    const capsule =
      graph === null
        ? null
        : (capsules.find(
            (candidate) => candidate.contextGraphRevision === graph.revision,
          ) ?? null);
    const tasks =
      await this.humanVerificationController.listDeferredVerificationTasks(
        input.ownerAgentInstanceId,
      );
    const nodeTasks = tasks.filter(
      (task) => task.contextNodeIdentifier === contextNodeIdentifier,
    );
    const deferredVerificationTask =
      capsule === null
        ? null
        : (nodeTasks.find(
            (task) => task.closureCapsuleHash === capsule.contentHash,
          ) ?? null);
    const fragments = await readDeferredGlobalContextFragments({
      baseDirectory: this.baseDirectory,
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
    });
    const missingPieces: ContextTransactionMissingPiece[] = [];
    if (terminalState === null) {
      missingPieces.push("terminal-context-state");
    }
    if (terminalState !== null && capsule === null) {
      missingPieces.push("closure-capsule");
    }
    if (
      terminalState === "deferred-review-closed" &&
      deferredVerificationTask === null
    ) {
      missingPieces.push("deferred-verification-task");
    }
    return {
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
      taskIdentifier: input.taskIdentifier,
      contextNodeIdentifier,
      graphRevision: graph?.revision ?? null,
      nodeState,
      terminalState,
      capsule,
      deferredVerificationTask,
      deferredFragmentCount: fragments.length,
      missingPieces,
      isStaleCapsuleRevision:
        terminalState !== null && capsules.length > 0 && capsule === null,
      isComplete: missingPieces.length === 0,
    };
  }

  /** 幂等重放：只补齐缺口；重复调用不再产生动作。 */
  async replay(
    input: ReplayContextTransactionInput,
  ): Promise<ContextTransactionReplayResult> {
    const before = await this.inspect(input);
    await this.lifecycle.completeTaskNode({
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
      taskIdentifier: input.taskIdentifier,
      taskDescription: input.taskDescription,
      summaryText: input.summaryText,
      modeKey: input.modeKey,
    });
    const after = await this.inspect(input);
    const replayedActions: ContextTransactionMissingPiece[] = [];
    if (before.terminalState === null && after.terminalState !== null) {
      replayedActions.push("terminal-context-state");
    }
    if (before.capsule === null && after.capsule !== null) {
      replayedActions.push("closure-capsule");
    }
    if (
      before.deferredVerificationTask === null &&
      after.deferredVerificationTask !== null
    ) {
      replayedActions.push("deferred-verification-task");
    }
    return {
      inspection: after,
      replayedActions,
      isReplayStable: after.isComplete && replayedActions.length === 0,
    };
  }
}
