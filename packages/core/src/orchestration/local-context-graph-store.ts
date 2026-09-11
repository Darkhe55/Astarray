/**
 * 局部上下文偏序图存储（T09A-02 / ADR-0031）。
 * 位置：<baseDirectory>/agent-memory/<agentInstanceId>/context-graphs/<graphId>/context-graph.json
 * + .bak（原子替换 + 备份恢复）。
 *
 * 保证：
 * - 每个具体 agentInstanceId 独占图文件；跨 Agent 所有权由 schema 拒绝；
 * - expected revision CAS、revision 单调、写入前自动备份；
 * - required 边维护 openRequiredChildCount 并增量传播；
 * - 关闭资格：自身状态可验收且无未关闭 required 直接子节点；
 * - 新增必要分支/重开时递增祖先计数（重新开放受影响节点）；
 * - 环、未知锚点、自环、缺失豁免一律 fail-closed。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import {
  localContextGraphSchema,
  type ContextEdgeType,
  type ContextNodeState,
  type LocalContextGraph,
  type LocalContextGraphNode,
} from "./context-closure-schemas.js";

export const CLOSED_CONTEXT_NODE_STATES: readonly ContextNodeState[] = [
  "accepted-closed",
  "deferred-review-closed",
  "superseded",
];

const CLOSURE_ELIGIBLE_SOURCE_STATES: readonly ContextNodeState[] = [
  "locally-verified",
  "awaiting-user-acceptance",
];

export interface LocalContextGraphStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

export interface CreateLocalContextGraphInput {
  graphIdentifier: string;
  ownerAgentInstanceId: string;
  missionId: string;
}

export interface AddContextNodeInput {
  ownerAgentInstanceId: string;
  graphIdentifier: string;
  expectedGraphRevision: number;
  contextNodeIdentifier: string;
  missionId: string;
  contentFingerprint: string;
  state?: ContextNodeState;
}

export interface AddContextEdgeInput {
  ownerAgentInstanceId: string;
  graphIdentifier: string;
  expectedGraphRevision: number;
  edgeIdentifier: string;
  fromContextNodeIdentifier: string;
  toContextNodeIdentifier: string;
  edgeType: ContextEdgeType;
  waiver?: {
    userId: string;
    contextGraphRevision: number;
    waivedAtIso: string;
  };
}

export interface CloseContextNodeInput {
  ownerAgentInstanceId: string;
  graphIdentifier: string;
  expectedGraphRevision: number;
  contextNodeIdentifier: string;
  targetState: "accepted-closed" | "deferred-review-closed";
}

export interface ReopenContextNodeInput {
  ownerAgentInstanceId: string;
  graphIdentifier: string;
  expectedGraphRevision: number;
  contextNodeIdentifier: string;
}

export class LocalContextGraphStore {
  private readonly agentMemoryDirectoryPath: string;
  private readonly nowMilliseconds: () => number;
  private readonly graphLocks = new Map<string, AsyncMutex>();

  constructor(options: LocalContextGraphStoreOptions) {
    this.agentMemoryDirectoryPath = path.join(options.baseDirectory, "agent-memory");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  private graphDirectoryPath(ownerAgentInstanceId: string, graphIdentifier: string): string {
    return path.join(
      this.agentMemoryDirectoryPath,
      sanitizePathSegment(ownerAgentInstanceId),
      "context-graphs",
      sanitizePathSegment(graphIdentifier),
    );
  }

  private graphFilePath(ownerAgentInstanceId: string, graphIdentifier: string): string {
    return path.join(this.graphDirectoryPath(ownerAgentInstanceId, graphIdentifier), "context-graph.json");
  }

  private graphBackupFilePath(ownerAgentInstanceId: string, graphIdentifier: string): string {
    return path.join(this.graphDirectoryPath(ownerAgentInstanceId, graphIdentifier), "context-graph.json.bak");
  }

  private getGraphLock(ownerAgentInstanceId: string, graphIdentifier: string): AsyncMutex {
    const lockKey = ownerAgentInstanceId + "/" + graphIdentifier;
    let lock = this.graphLocks.get(lockKey);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.graphLocks.set(lockKey, lock);
    }
    return lock;
  }

  async createGraph(input: CreateLocalContextGraphInput): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const existing = await this.readGraphInternal(input.ownerAgentInstanceId, input.graphIdentifier);
      if (existing !== null) {
        throw new DomainError("context-graph-invalid", "上下文图已存在: " + input.graphIdentifier);
      }
      const graph: LocalContextGraph = {
        schemaVersion: 1,
        graphIdentifier: input.graphIdentifier,
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        missionId: input.missionId,
        revision: 1,
        nodes: [],
        edges: [],
        updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      };
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, graph);
      return graph;
    });
  }

  async readGraph(ownerAgentInstanceId: string, graphIdentifier: string): Promise<LocalContextGraph | null> {
    return this.getGraphLock(ownerAgentInstanceId, graphIdentifier).runExclusive(() =>
      this.readGraphInternal(ownerAgentInstanceId, graphIdentifier),
    );
  }

  async addNode(input: AddContextNodeInput): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const current = await this.requireGraphCurrentRevision(input);
      if (current.nodes.some((node) => node.contextNodeIdentifier === input.contextNodeIdentifier)) {
        throw new DomainError("context-graph-invalid", "上下文节点已存在: " + input.contextNodeIdentifier);
      }
      const node: LocalContextGraphNode = {
        contextNodeIdentifier: input.contextNodeIdentifier,
        agentInstanceId: input.ownerAgentInstanceId,
        missionId: input.missionId,
        state: input.state ?? "active",
        openRequiredChildCount: 0,
        contentFingerprint: input.contentFingerprint,
        updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      };
      const next = this.withRevision(current, { nodes: [...current.nodes, node] });
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, next);
      return next;
    });
  }

  /**
   * T09A-R1-03：标记节点状态（CAS）；已关闭状态不得回退为非关闭状态。
   */
  async markNodeState(input: {
    ownerAgentInstanceId: string;
    graphIdentifier: string;
    expectedGraphRevision: number;
    contextNodeIdentifier: string;
    state: ContextNodeState;
  }): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const current = await this.requireGraphCurrentRevision(input);
      const node = this.requireNode(current, input.contextNodeIdentifier);
      if (this.isClosedState(node.state) && !this.isClosedState(input.state)) {
        throw new DomainError(
          "context-graph-invalid",
          "已关闭节点不得回退为非关闭状态: " + input.contextNodeIdentifier,
        );
      }
      const next = this.withRevision(current, {
        nodes: current.nodes.map((candidate) =>
          candidate.contextNodeIdentifier === node.contextNodeIdentifier
            ? {
                ...candidate,
                state: input.state,
                updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
              }
            : candidate,
        ),
      });
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, next);
      return next;
    });
  }

  async addEdge(input: AddContextEdgeInput): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const current = await this.requireGraphCurrentRevision(input);
      if (current.edges.some((edge) => edge.edgeIdentifier === input.edgeIdentifier)) {
        throw new DomainError("context-graph-invalid", "上下文边已存在: " + input.edgeIdentifier);
      }
      const nodeIdentifiers = new Set(current.nodes.map((node) => node.contextNodeIdentifier));
      if (
        !nodeIdentifiers.has(input.fromContextNodeIdentifier) ||
        !nodeIdentifiers.has(input.toContextNodeIdentifier) ||
        input.fromContextNodeIdentifier === input.toContextNodeIdentifier
      ) {
        throw new DomainError("context-graph-invalid", "边必须引用两个不同的已知节点: " + input.edgeIdentifier);
      }
      if (input.edgeType === "waived" && input.waiver === undefined) {
        throw new DomainError("context-graph-invalid", "waived 边必须携带认证用户豁免: " + input.edgeIdentifier);
      }
      if (this.wouldCreateCycle(current, input.fromContextNodeIdentifier, input.toContextNodeIdentifier)) {
        throw new DomainError("context-graph-invalid", "不允许形成上下文图环: " + input.edgeIdentifier);
      }
      const targetNode = current.nodes.find(
        (node) => node.contextNodeIdentifier === input.toContextNodeIdentifier,
      )!;
      const shouldCountAsOpenRequiredChild =
        input.edgeType === "required" && !this.isClosedState(targetNode.state);
      const nextNodes = shouldCountAsOpenRequiredChild
        ? current.nodes.map((node) =>
            node.contextNodeIdentifier === input.fromContextNodeIdentifier
              ? { ...node, openRequiredChildCount: node.openRequiredChildCount + 1 }
              : node,
          )
        : current.nodes;
      const next = this.withRevision(current, {
        nodes: nextNodes,
        edges: [
          ...current.edges,
          {
            edgeIdentifier: input.edgeIdentifier,
            fromContextNodeIdentifier: input.fromContextNodeIdentifier,
            toContextNodeIdentifier: input.toContextNodeIdentifier,
            edgeType: input.edgeType,
            ...(input.waiver !== undefined ? { waiver: input.waiver } : {}),
          },
        ],
      });
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, next);
      return next;
    });
  }

  async closeNode(input: CloseContextNodeInput): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const current = await this.requireGraphCurrentRevision(input);
      const node = this.requireNode(current, input.contextNodeIdentifier);
      if (!CLOSURE_ELIGIBLE_SOURCE_STATES.includes(node.state)) {
        throw new DomainError(
          "context-node-not-closable",
          "节点当前状态不可关闭（须先本地验收/等待人工验收）: " + input.contextNodeIdentifier,
        );
      }
      if (node.openRequiredChildCount > 0) {
        throw new DomainError(
          "context-node-not-closable",
          "仍有 " + node.openRequiredChildCount + " 个未关闭 required 直接子节点: " + input.contextNodeIdentifier,
        );
      }
      // T09A-R1-03：accepted-closed 要求 required 子节点也必须 accepted-closed；
      // 仅 deferred-review-closed 的子节点不得让祖先被标记为“已人工验收”。
      if (input.targetState === "accepted-closed") {
        const unverifiedRequiredChildIdentifiers = current.edges
          .filter(
            (edge) =>
              edge.edgeType === "required" &&
              edge.fromContextNodeIdentifier === input.contextNodeIdentifier,
          )
          .map((edge) => edge.toContextNodeIdentifier)
          .filter((childIdentifier) => {
            const child = current.nodes.find(
              (candidate) => candidate.contextNodeIdentifier === childIdentifier,
            );
            return child === undefined || child.state !== "accepted-closed";
          });
        if (unverifiedRequiredChildIdentifiers.length > 0) {
          throw new DomainError(
            "context-node-not-closable",
            "required 子节点尚未通过人工验收: " +
              unverifiedRequiredChildIdentifiers.join(", "),
          );
        }
      }
      const nextNodes = current.nodes.map((candidate) => {
        if (candidate.contextNodeIdentifier === input.contextNodeIdentifier) {
          return {
            ...candidate,
            state: input.targetState,
            updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
          };
        }
        return this.decrementParentCounterFor(current, candidate, input.contextNodeIdentifier);
      });
      const next = this.withRevision(current, { nodes: nextNodes });
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, next);
      return next;
    });
  }

  async reopenNode(input: ReopenContextNodeInput): Promise<LocalContextGraph> {
    return this.getGraphLock(input.ownerAgentInstanceId, input.graphIdentifier).runExclusive(async () => {
      const current = await this.requireGraphCurrentRevision(input);
      const node = this.requireNode(current, input.contextNodeIdentifier);
      if (!this.isClosedState(node.state)) {
        throw new DomainError(
          "context-node-not-closable",
          "只有已关闭节点可以重新开放: " + input.contextNodeIdentifier,
        );
      }
      const nextNodes = current.nodes.map((candidate) => {
        if (candidate.contextNodeIdentifier === input.contextNodeIdentifier) {
          return {
            ...candidate,
            state: "reopened" as const,
            updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
          };
        }
        return this.incrementParentCounterFor(current, candidate, input.contextNodeIdentifier);
      });
      const next = this.withRevision(current, { nodes: nextNodes });
      await this.persistGraph(input.ownerAgentInstanceId, input.graphIdentifier, next);
      return next;
    });
  }

  private decrementParentCounterFor(
    graph: LocalContextGraph,
    candidate: LocalContextGraphNode,
    closedNodeIdentifier: string,
  ): LocalContextGraphNode {
    const isRequiredParent = graph.edges.some(
      (edge) =>
        edge.edgeType === "required" &&
        edge.fromContextNodeIdentifier === candidate.contextNodeIdentifier &&
        edge.toContextNodeIdentifier === closedNodeIdentifier,
    );
    if (!isRequiredParent || candidate.openRequiredChildCount === 0) {
      return candidate;
    }
    return { ...candidate, openRequiredChildCount: candidate.openRequiredChildCount - 1 };
  }

  private incrementParentCounterFor(
    graph: LocalContextGraph,
    candidate: LocalContextGraphNode,
    reopenedNodeIdentifier: string,
  ): LocalContextGraphNode {
    const isRequiredParent = graph.edges.some(
      (edge) =>
        edge.edgeType === "required" &&
        edge.fromContextNodeIdentifier === candidate.contextNodeIdentifier &&
        edge.toContextNodeIdentifier === reopenedNodeIdentifier,
    );
    if (!isRequiredParent) {
      return candidate;
    }
    return { ...candidate, openRequiredChildCount: candidate.openRequiredChildCount + 1 };
  }

  private wouldCreateCycle(
    graph: LocalContextGraph,
    fromNodeIdentifier: string,
    toNodeIdentifier: string,
  ): boolean {
    const stack: string[] = [toNodeIdentifier];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const currentNodeIdentifier = stack.pop()!;
      if (currentNodeIdentifier === fromNodeIdentifier) {
        return true;
      }
      if (visited.has(currentNodeIdentifier)) {
        continue;
      }
      visited.add(currentNodeIdentifier);
      for (const edge of graph.edges) {
        if (edge.fromContextNodeIdentifier === currentNodeIdentifier) {
          stack.push(edge.toContextNodeIdentifier);
        }
      }
    }
    return false;
  }

  private isClosedState(state: ContextNodeState): boolean {
    return CLOSED_CONTEXT_NODE_STATES.includes(state);
  }

  private requireNode(graph: LocalContextGraph, contextNodeIdentifier: string): LocalContextGraphNode {
    const node = graph.nodes.find((candidate) => candidate.contextNodeIdentifier === contextNodeIdentifier);
    if (node === undefined) {
      throw new DomainError("context-graph-invalid", "上下文节点不存在: " + contextNodeIdentifier);
    }
    return node;
  }

  private async requireGraphCurrentRevision(input: {
    ownerAgentInstanceId: string;
    graphIdentifier: string;
    expectedGraphRevision: number;
  }): Promise<LocalContextGraph> {
    const current = await this.readGraphInternal(input.ownerAgentInstanceId, input.graphIdentifier);
    if (current === null) {
      throw new DomainError("context-graph-not-found", "上下文图不存在: " + input.graphIdentifier);
    }
    if (current.revision !== input.expectedGraphRevision) {
      throw new DomainError(
        "stale-revision",
        "上下文图 revision 不匹配: 现有 " + current.revision + "，期望 " + input.expectedGraphRevision,
      );
    }
    return current;
  }

  private withRevision(
    current: LocalContextGraph,
    changes: { nodes?: LocalContextGraphNode[]; edges?: LocalContextGraph["edges"] },
  ): LocalContextGraph {
    return {
      ...current,
      ...(changes.nodes !== undefined ? { nodes: changes.nodes } : {}),
      ...(changes.edges !== undefined ? { edges: changes.edges } : {}),
      revision: current.revision + 1,
      updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
    };
  }

  private async readGraphInternal(
    ownerAgentInstanceId: string,
    graphIdentifier: string,
  ): Promise<LocalContextGraph | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.graphFilePath(ownerAgentInstanceId, graphIdentifier),
      this.graphBackupFilePath(ownerAgentInstanceId, graphIdentifier),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = localContextGraphSchema.safeParse(readResult.content);
    if (!parsed.success) {
      throw new DomainError(
        "context-graph-invalid",
        "上下文图内容非法（" + (readResult.recoveredFromBackup ? "已从备份恢复" : "主文件") + "）: " + parsed.error.message,
      );
    }
    return parsed.data;
  }

  private async persistGraph(
    ownerAgentInstanceId: string,
    graphIdentifier: string,
    graph: LocalContextGraph,
  ): Promise<void> {
    const parsed = localContextGraphSchema.safeParse(graph);
    if (!parsed.success) {
      throw new DomainError("context-graph-invalid", "上下文图 schema 校验失败: " + parsed.error.message);
    }
    const filePath = this.graphFilePath(ownerAgentInstanceId, graphIdentifier);
    await writeAtomicJson(filePath, parsed.data);
    await backupExistingFile(filePath, this.graphBackupFilePath(ownerAgentInstanceId, graphIdentifier));
  }
}
