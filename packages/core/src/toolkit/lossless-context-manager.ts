/**
 * NODECTX-01-02：**无损暂存、自动补回、永久关闭与显式回访**（2026-10-10）。
 *
 * 契约来源：`docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md` §2.3/§2.4 与检查点 02。
 *
 * 卡内硬要求逐条落实：
 *  - "**仅把当前不需要的非紧急/非重要节点完整落盘**" ⇒ 紧急/重要/当前执行需要者**拒绝暂存**；
 *  - "先校验**原文可读、hash/revision 与写入成功**，**再**提交 temporarily-closed
 *    及队列索引" ⇒ **先写盘成功再改可见性**；
 *  - "**磁盘失败不移出上下文、不假报暂存成功**；**不通过模型重写原文**"
 *    ⇒ 写入失败时状态**完全不变**；本模块只搬运原文，**绝不改写/摘要**；
 *  - "**工具调用与结果不拆散**" ⇒ 配对节点**同进同出**；
 *  - "自动补回按 **node/revision/activation ID 幂等**" ⇒ 重复补回**不重复注入**；
 *  - "按**偏序 ready set**、优先级与稳定顺序补回，**保持用户来源优先**"；
 *  - "设置关闭/恢复阈值**滞回**及**每轮迁移上限**……防止……反复振荡；
 *    **同 revision 无进展时停止并报告**"；
 *  - "**永久关闭不自动复活**，可**显式回访**；原文仍存档"。
 *
 * 本模块做**本地文件系统 I/O**，但只在调用方给定的暂存目录内；不联网、不读凭据。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ContextVisibilityState, NodeBusinessStatus } from "./context-lossless-visibility.js";

export interface LosslessContextNode {
  nodeIdentifier: string;
  revision: number;
  sourceKind: "user" | "agent" | "tool";
  priorityTier: number;
  contentText: string;
  /** 紧急（沿 EVENT 仲裁）⇒ 不得暂存。 */
  isUrgent: boolean;
  /** 重要 ⇒ 不得暂存。 */
  isImportant: boolean;
  /** 当前执行需要（含"有效用户约束/未决问题"）⇒ 不得暂存。 */
  isNeededForCurrentExecution: boolean;
  /** 工具调用标识（用于配对保护）。 */
  toolCallIdentifier: string | null;
  /** 偏序前驱（未完成则不得补回本节点）。 */
  dependencyNodeIdentifiers: string[];
}

export interface LosslessContextManagerOptions {
  /** 暂存目录（调用方给定；通常是项目状态目录下的子目录）。 */
  stagingDirectory: string;
  /** 每轮迁移（补回）上限。 */
  maximumMigrationsPerRound: number;
}

/** 写入端口（可注入以测试磁盘失败）。 */
export type StagingWriterPort = (input: {
  stagingDirectory: string;
  nodeIdentifier: string;
  revision: number;
  contentText: string;
}) => Promise<void>;

export interface StageOutcome {
  isStaged: boolean;
  reason: string | null;
}

export interface ReclaimOutcome {
  reclaimedNodeIdentifiers: string[];
  isMigrationsCapped: boolean;
  isIdempotentSkip: boolean;
  isOscillationDetected: boolean;
  reason: string | null;
}

export interface PermanentClosureOutcome {
  isClosed: boolean;
  reason: string | null;
}

export interface ExplicitRecallOutcome {
  isRecalled: boolean;
  contentText: string | null;
  reason: string | null;
}

export interface LosslessContextManager {
  setStagingWriterForTesting(writer: StagingWriterPort): void;
  /** 登记节点（配对暂存需要两侧都已登记）。 */
  registerNode(node: LosslessContextNode): void;
  registerKnownRevision(input: {
    nodeIdentifier: string;
    revision: number;
    contentHash: string;
  }): void;
  registerToolPair(input: {
    toolCallIdentifier: string;
    toolCallNodeIdentifier: string;
    toolResultNodeIdentifier: string;
  }): void;
  registerDependency(input: {
    nodeIdentifier: string;
    predecessorNodeIdentifiers: string[];
  }): void;
  stageNode(node: LosslessContextNode): Promise<StageOutcome>;
  stageNodePair(input: { toolCallIdentifier: string }): Promise<StageOutcome>;
  reclaimAtSafetyPoint(): Promise<ReclaimOutcome>;
  closePermanently(input: {
    nodeIdentifier: string;
    verifiedByGateIdentifier: string;
    isAccepted: boolean;
  }): Promise<PermanentClosureOutcome>;
  recallExplicitly(input: { nodeIdentifier: string }): Promise<ExplicitRecallOutcome>;
  getVisibilityState(nodeIdentifier: string): ContextVisibilityState | null;
  getBusinessStatus(nodeIdentifier: string): NodeBusinessStatus | null;
  listStagedNodeIdentifiers(): string[];
  readStagedContent(nodeIdentifier: string): Promise<string | null>;
  markPredecessorCompleted(input: { nodeIdentifier: string }): void;
}

function computeContentHash(contentText: string): string {
  return "sha256:" + createHash("sha256").update(contentText, "utf8").digest("hex");
}

function stagingFileName(nodeIdentifier: string, revision: number): string {
  // 文件名保持稳定且可读；节点标识做安全化处理，避免路径穿越。
  const safeIdentifier = nodeIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return safeIdentifier + "@r" + String(revision) + ".txt";
}

export function createLosslessContextManager(
  options: LosslessContextManagerOptions,
): LosslessContextManager {
  const visibilityStateByNodeIdentifier = new Map<string, ContextVisibilityState>();
  const businessStatusByNodeIdentifier = new Map<string, NodeBusinessStatus>();
  const nodeByNodeIdentifier = new Map<string, LosslessContextNode>();
  const revisionByNodeIdentifier = new Map<string, number>();
  const knownContentHashByNodeIdentifier = new Map<string, string>();
  const completedPredecessorNodeIdentifiers = new Set<string>();
  const dependenciesByNodeIdentifier = new Map<string, string[]>();
  const toolPairsByCallIdentifier = new Map<
    string,
    { toolCallNodeIdentifier: string; toolResultNodeIdentifier: string }
  >();
  /** 已补回过的 `node@revision@activation`（幂等键）。 */
  const reclaimedActivationKeys = new Set<string>();
  /** 同一 revision 反复暂存/补回的计数（振荡检测）。 */
  const migrationCountByNodeRevision = new Map<string, number>();
  /** 因无进展而停止补回的节点（直到 revision 前进才解除）。 */
  const stalledNodeRevisionKeys = new Set<string>();
  let activationSequence = 0;
  let stagingWriter: StagingWriterPort = async (input) => {
    await fs.mkdir(input.stagingDirectory, { recursive: true });
    await fs.writeFile(
      path.join(
        input.stagingDirectory,
        stagingFileName(input.nodeIdentifier, input.revision),
      ),
      input.contentText,
      "utf8",
    );
  };

  const nodeRevisionKey = (nodeIdentifier: string, revision: number): string =>
    nodeIdentifier + "@r" + String(revision);

  const isProtectedFromStaging = (
    node: LosslessContextNode,
  ): { isProtected: boolean; reason: string } => {
    if (node.isUrgent) {
      return { isProtected: true, reason: "紧急节点不得暂存（沿 EVENT 仲裁）" };
    }
    if (node.isImportant) {
      return { isProtected: true, reason: "重要节点不得暂存" };
    }
    if (node.isNeededForCurrentExecution) {
      return {
        isProtected: true,
        reason: "当前执行需要（含有效用户约束/未决问题）不得暂存",
      };
    }
    if (node.sourceKind === "user" && node.priorityTier === 0 && !node.isImportant) {
      /**
       * 用户来源保持优先：用户尚未完成的约束不得因为"低优先"被移出上下文。
       * 这里用"用户来源 + 最高层级"表达"未完成用户约束"。
       */
      return { isProtected: true, reason: "用户来源未完成约束不得暂存（用户优先）" };
    }
    return { isProtected: false, reason: "" };
  };

  const writeStagedContent = async (node: LosslessContextNode): Promise<void> => {
    await stagingWriter({
      stagingDirectory: options.stagingDirectory,
      nodeIdentifier: node.nodeIdentifier,
      revision: node.revision,
      contentText: node.contentText,
    });
  };

  const stageSingleNode = async (node: LosslessContextNode): Promise<StageOutcome> => {
    const protection = isProtectedFromStaging(node);
    if (protection.isProtected) {
      return { isStaged: false, reason: protection.reason };
    }
    /** hash/revision 校验：登记过已知 revision 时必须一致。 */
    const knownRevision = revisionByNodeIdentifier.get(node.nodeIdentifier);
    if (knownRevision !== undefined && knownRevision !== node.revision) {
      return {
        isStaged: false,
        reason:
          "revision 不一致（拒绝暂存错版本）: 期望 r" +
          String(knownRevision) +
          "，实际 r" +
          String(node.revision),
      };
    }
    const knownHash = knownContentHashByNodeIdentifier.get(node.nodeIdentifier);
    if (knownHash !== undefined && knownHash !== computeContentHash(node.contentText)) {
      return { isStaged: false, reason: "原文 hash 与登记不一致（拒绝暂存）" };
    }
    /**
     * **先写盘成功，再提交可见性**：写入失败时状态完全不变
     * （卡内"磁盘失败不移出上下文、不假报暂存成功"）。
     */
    try {
      await writeStagedContent(node);
    } catch (error) {
      return {
        isStaged: false,
        reason:
          "暂存写入失败，状态保持不变（不移出上下文）: " +
          String(error instanceof Error ? error.message : error),
      };
    }
    visibilityStateByNodeIdentifier.set(node.nodeIdentifier, "temporarily-closed");
    nodeByNodeIdentifier.set(node.nodeIdentifier, { ...node });
    revisionByNodeIdentifier.set(node.nodeIdentifier, node.revision);
    /**
     * 业务状态**独立于可见性**：暂存**不改变**业务状态（卡内"不能把暂不入提示词当 done"）。
     * 首次见到该节点时登记为 pending，便于核对"暂存不等于完成"。
     */
    if (!businessStatusByNodeIdentifier.has(node.nodeIdentifier)) {
      businessStatusByNodeIdentifier.set(node.nodeIdentifier, "pending");
    }
    return { isStaged: true, reason: null };
  };

  return {
    setStagingWriterForTesting(writer) {
      stagingWriter = writer;
    },

    registerNode(node) {
      nodeByNodeIdentifier.set(node.nodeIdentifier, { ...node });
      revisionByNodeIdentifier.set(node.nodeIdentifier, node.revision);
      if (!visibilityStateByNodeIdentifier.has(node.nodeIdentifier)) {
        visibilityStateByNodeIdentifier.set(node.nodeIdentifier, "active");
      }
      if (!businessStatusByNodeIdentifier.has(node.nodeIdentifier)) {
        businessStatusByNodeIdentifier.set(node.nodeIdentifier, "pending");
      }
    },

    registerKnownRevision(input) {
      revisionByNodeIdentifier.set(input.nodeIdentifier, input.revision);
      knownContentHashByNodeIdentifier.set(input.nodeIdentifier, input.contentHash);
    },

    registerToolPair(input) {
      toolPairsByCallIdentifier.set(input.toolCallIdentifier, {
        toolCallNodeIdentifier: input.toolCallNodeIdentifier,
        toolResultNodeIdentifier: input.toolResultNodeIdentifier,
      });
    },

    registerDependency(input) {
      dependenciesByNodeIdentifier.set(
        input.nodeIdentifier,
        [...input.predecessorNodeIdentifiers],
      );
    },

    async stageNode(node) {
      const toolCallIdentifier = node.toolCallIdentifier;
      if (toolCallIdentifier !== null) {
        const pair = toolPairsByCallIdentifier.get(toolCallIdentifier);
        if (pair !== undefined) {
          /**
           * 配对保护：带工具调用标识的节点**必须与其结果同进同出**
           * （卡内测试重点"工具调用与结果不拆散"）。单个暂存一律拒绝。
           */
          return {
            isStaged: false,
            reason:
              "工具调用与结果不得拆散：请使用 stageNodePair（工具调用 " +
              toolCallIdentifier +
              " 需要与其结果节点一同暂存）",
          };
        }
      }
      return stageSingleNode(node);
    },

    async stageNodePair(input) {
      const pair = toolPairsByCallIdentifier.get(input.toolCallIdentifier);
      if (pair === undefined) {
        return { isStaged: false, reason: "未登记该工具调用配对" };
      }
      const callNode = nodeByNodeIdentifier.get(pair.toolCallNodeIdentifier);
      const resultNode = nodeByNodeIdentifier.get(pair.toolResultNodeIdentifier);
      if (callNode === undefined || resultNode === undefined) {
        return {
          isStaged: false,
          reason: "配对节点尚未登记（无法保证同进同出）",
        };
      }
      for (const node of [callNode, resultNode]) {
        const protection = isProtectedFromStaging(node);
        if (protection.isProtected) {
          return { isStaged: false, reason: protection.reason };
        }
      }
      // 先写两个节点的落盘，全部成功后才提交可见性。
      try {
        await writeStagedContent(callNode);
        await writeStagedContent(resultNode);
      } catch (error) {
        return {
          isStaged: false,
          reason:
            "配对暂存写入失败，状态保持不变: " +
            String(error instanceof Error ? error.message : error),
        };
      }
      visibilityStateByNodeIdentifier.set(callNode.nodeIdentifier, "temporarily-closed");
      visibilityStateByNodeIdentifier.set(resultNode.nodeIdentifier, "temporarily-closed");
      return { isStaged: true, reason: null };
    },

    async reclaimAtSafetyPoint() {
      activationSequence += 1;
      const reclaimedNodeIdentifiers: string[] = [];
      let isMigrationsCapped = false;
      let isOscillationDetected = false;
      let oscillationReason: string | null = null;

      const candidates = [...visibilityStateByNodeIdentifier.entries()]
        .filter(([, state]) => state === "temporarily-closed")
        .map(([nodeIdentifier]) => nodeIdentifier)
        .filter((nodeIdentifier) => {
          // 偏序：前驱未完成则不得补回
          const predecessors = dependenciesByNodeIdentifier.get(nodeIdentifier) ?? [];
          return predecessors.every((predecessor) =>
            completedPredecessorNodeIdentifiers.has(predecessor),
          );
        })
        .sort((left, right) => {
          const leftNode = nodeByNodeIdentifier.get(left);
          const rightNode = nodeByNodeIdentifier.get(right);
          // 用户来源优先，其次按 priorityTier 升序，最后按标识稳定排序
          const leftIsUser = leftNode?.sourceKind === "user" ? 0 : 1;
          const rightIsUser = rightNode?.sourceKind === "user" ? 0 : 1;
          if (leftIsUser !== rightIsUser) {
            return leftIsUser - rightIsUser;
          }
          const leftTier = leftNode?.priorityTier ?? 0;
          const rightTier = rightNode?.priorityTier ?? 0;
          if (leftTier !== rightTier) {
            return leftTier - rightTier;
          }
          return left.localeCompare(right);
        });

      for (const nodeIdentifier of candidates) {
        const revision = revisionByNodeIdentifier.get(nodeIdentifier) ?? 1;
        const revisionKey = nodeRevisionKey(nodeIdentifier, revision);
        /** 振荡保护：同 revision 已判定"无进展"⇒ 停止补回并报告。 */
        if (stalledNodeRevisionKeys.has(revisionKey)) {
          isOscillationDetected = true;
          oscillationReason =
            "同 revision " +
            revisionKey +
            " 反复暂存/补回且**无进展**，已停止补回（不周期性唤醒模型）";
          continue;
        }
        const activationKey =
          nodeIdentifier + "@r" + String(revision) + "@a" + String(activationSequence);
        if (reclaimedActivationKeys.has(activationKey)) {
          continue;
        }
        if (reclaimedNodeIdentifiers.length >= options.maximumMigrationsPerRound) {
          isMigrationsCapped = true;
          break;
        }
        reclaimedActivationKeys.add(activationKey);
        reclaimedNodeIdentifiers.push(nodeIdentifier);
        visibilityStateByNodeIdentifier.set(nodeIdentifier, "active");
        const migrationCount = (migrationCountByNodeRevision.get(revisionKey) ?? 0) + 1;
        migrationCountByNodeRevision.set(revisionKey, migrationCount);
        /**
         * 滞回：同一 revision 迁移超过 2 次即视为振荡 ⇒ 停止该 revision 的补回。
         */
        /**
         * 滞回：同一 revision 的第 **2** 次补回即视为"无进展振荡"——
         * 因为两次补回之间**没有任何 revision 前进**（卡内"同 revision 无进展时停止并报告"）。
         */
        if (migrationCount >= 2) {
          stalledNodeRevisionKeys.add(revisionKey);
          /**
           * **同一轮**上报振荡：本次补回本身合法，但调用方现在就该被告知"再补也无进展"，
           * 否则要多跑一轮才被通知。卡内要求"同 revision 无进展时**停止并报告**"。
           */
          isOscillationDetected = true;
          oscillationReason =
            "同 revision " +
            revisionKey +
            " 反复暂存/补回且**无进展**，已停止后续补回（不周期性唤醒模型）";
        }
      }

      const isIdempotentSkip =
        reclaimedNodeIdentifiers.length === 0 && !isOscillationDetected;
      return {
        reclaimedNodeIdentifiers,
        isMigrationsCapped,
        isIdempotentSkip,
        isOscillationDetected,
        reason: oscillationReason,
      };
    },

    async closePermanently(input) {
      const currentState = visibilityStateByNodeIdentifier.get(input.nodeIdentifier);
      if (currentState === undefined) {
        return { isClosed: false, reason: "节点不存在" };
      }
      if (!input.isAccepted) {
        return {
          isClosed: false,
          reason: "逐项核验未通过（不得永久关闭）",
        };
      }
      if (input.verifiedByGateIdentifier === "") {
        return { isClosed: false, reason: "缺少核验门禁标识" };
      }
      visibilityStateByNodeIdentifier.set(input.nodeIdentifier, "permanently-closed");
      businessStatusByNodeIdentifier.set(input.nodeIdentifier, "completed");
      return { isClosed: true, reason: null };
    },

    async recallExplicitly(input) {
      const currentState = visibilityStateByNodeIdentifier.get(input.nodeIdentifier);
      if (currentState !== "permanently-closed") {
        return {
          isRecalled: false,
          contentText: null,
          reason: "仅永久关闭的节点可显式回访（其余状态本就在装配范围内）",
        };
      }
      const contentText = await this.readStagedContent(input.nodeIdentifier);
      if (contentText === null) {
        return { isRecalled: false, contentText: null, reason: "原文不可读" };
      }
      return { isRecalled: true, contentText, reason: null };
    },

    getVisibilityState(nodeIdentifier) {
      /**
       * 未登记的节点按 `active` 处理：它**没有被移出**上下文
       * （暂存失败时状态必须"完全不变"，因此不能返回"未知"）。
       */
      return visibilityStateByNodeIdentifier.get(nodeIdentifier) ?? "active";
    },

    getBusinessStatus(nodeIdentifier) {
      return businessStatusByNodeIdentifier.get(nodeIdentifier) ?? null;
    },

    listStagedNodeIdentifiers() {
      return [...visibilityStateByNodeIdentifier.entries()]
        .filter(([, state]) => state !== "active")
        .map(([nodeIdentifier]) => nodeIdentifier)
        .sort();
    },

    async readStagedContent(nodeIdentifier) {
      const revision = revisionByNodeIdentifier.get(nodeIdentifier);
      if (revision === undefined) {
        return null;
      }
      try {
        return await fs.readFile(
          path.join(options.stagingDirectory, stagingFileName(nodeIdentifier, revision)),
          "utf8",
        );
      } catch {
        return null;
      }
    },

    markPredecessorCompleted(input) {
      completedPredecessorNodeIdentifiers.add(input.nodeIdentifier);
    },
  };
}
