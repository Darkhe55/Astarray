/**
 * 关闭胶囊存储与提示词活跃前沿（T09A-05 / ADR-0031 §11.4）。
 *
 * - CONTEXT_CLOSURE_CAPSULE_V1 按 owner agentInstanceId 隔离、只追加不可变；
 *   同节点同图 revision 重复写入拒绝；内容哈希在写入/读取时校验。
 * - 活跃前沿只包含未关闭节点（含 openRequiredChildCount），已关闭历史不进入
 *   普通提示词；关闭只做逻辑排除，不删除原文。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import {
  CLOSED_CONTEXT_NODE_STATES,
  type LocalContextGraphStore,
} from "./local-context-graph-store.js";
import {
  contextClosureCapsuleSchema,
  type ContextClosureCapsule,
  type LocalContextGraph,
  type LocalContextGraphNode,
} from "./context-closure-schemas.js";

export const CLOSURE_CAPSULE_TOKEN_ESTIMATE_DIVISOR = 4;

export interface ContextClosureCapsuleStoreOptions {
  baseDirectory: string;
}

export interface CreateClosureCapsuleInput {
  capsuleIdentifier: string;
  ownerAgentInstanceId: string;
  contextNodeIdentifier: string;
  missionId: string;
  contextGraphRevision: number;
  finalDecisionSummary: string;
  promotedGlobalDecisionIdentifiers?: string[];
  inputSummary: string;
  outputSummary: string;
  verificationState: "awaiting-user-acceptance" | "accepted-closed" | "deferred-review-closed";
  artifactOrCommitReferences?: string[];
  testEvidenceReferences?: string[];
  informationSource:
    | { sourceType: "agent"; agentInstanceId: string }
    | { sourceType: "user"; userId?: string };
  unresolvedItems?: string[];
  reopenCondition: string;
  createdAtIso?: string;
}

export class ContextClosureCapsuleStore {
  private readonly agentMemoryDirectoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: ContextClosureCapsuleStoreOptions) {
    this.agentMemoryDirectoryPath = path.join(options.baseDirectory, "agent-memory");
  }

  private capsuleDirectoryPath(ownerAgentInstanceId: string): string {
    return path.join(
      this.agentMemoryDirectoryPath,
      sanitizePathSegment(ownerAgentInstanceId),
      "closure-capsules",
    );
  }

  private capsuleFilePath(ownerAgentInstanceId: string, capsuleIdentifier: string): string {
    return path.join(
      this.capsuleDirectoryPath(ownerAgentInstanceId),
      sanitizePathSegment(capsuleIdentifier) + ".json",
    );
  }

  async createCapsule(input: CreateClosureCapsuleInput): Promise<ContextClosureCapsule> {
    return this.writeLock.runExclusive(async () => {
      const contentHash = computeContextClosureCapsuleContentHash({
        contextNodeIdentifier: input.contextNodeIdentifier,
        agentInstanceId: input.ownerAgentInstanceId,
        contextGraphRevision: input.contextGraphRevision,
        finalDecisionSummary: input.finalDecisionSummary,
        inputSummary: input.inputSummary,
        outputSummary: input.outputSummary,
        verificationState: input.verificationState,
        reopenCondition: input.reopenCondition,
      });
      const capsule: ContextClosureCapsule = {
        schemaVersion: 1,
        capsuleIdentifier: input.capsuleIdentifier,
        contextNodeIdentifier: input.contextNodeIdentifier,
        agentInstanceId: input.ownerAgentInstanceId,
        missionId: input.missionId,
        contextGraphRevision: input.contextGraphRevision,
        finalDecisionSummary: input.finalDecisionSummary,
        promotedGlobalDecisionIdentifiers: input.promotedGlobalDecisionIdentifiers ?? [],
        inputSummary: input.inputSummary,
        outputSummary: input.outputSummary,
        verificationState: input.verificationState,
        artifactOrCommitReferences: input.artifactOrCommitReferences ?? [],
        testEvidenceReferences: input.testEvidenceReferences ?? [],
        informationSource: input.informationSource,
        contentHash,
        unresolvedItems: input.unresolvedItems ?? [],
        reopenCondition: input.reopenCondition,
        createdAtIso: input.createdAtIso ?? new Date().toISOString(),
      };
      const parsed = contextClosureCapsuleSchema.safeParse(capsule);
      if (!parsed.success) {
        throw new DomainError(
          "context-graph-invalid",
          "关闭胶囊 schema 校验失败: " + parsed.error.message,
        );
      }
      const filePath = this.capsuleFilePath(input.ownerAgentInstanceId, input.capsuleIdentifier);
      const existing = await this.readCapsule(input.ownerAgentInstanceId, input.capsuleIdentifier);
      if (existing !== null) {
        throw new DomainError(
          "context-graph-invalid",
          "关闭胶囊已存在（不可变，禁止覆盖）: " + input.capsuleIdentifier,
        );
      }
      await fs.mkdir(this.capsuleDirectoryPath(input.ownerAgentInstanceId), { recursive: true });
      await writeAtomicJson(filePath, parsed.data);
      return parsed.data;
    });
  }

  async readCapsule(
    ownerAgentInstanceId: string,
    capsuleIdentifier: string,
  ): Promise<ContextClosureCapsule | null> {
    const filePath = this.capsuleFilePath(ownerAgentInstanceId, capsuleIdentifier);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const parsed = contextClosureCapsuleSchema.safeParse(JSON.parse(rawContent));
    if (!parsed.success) {
      throw new DomainError(
        "context-graph-invalid",
        "关闭胶囊非法: " + parsed.error.message,
      );
    }
    const recomputedHash = computeContextClosureCapsuleContentHash(parsed.data);
    if (recomputedHash !== parsed.data.contentHash) {
      throw new DomainError(
        "journal-corrupted",
        "关闭胶囊内容哈希不匹配，拒绝返回: " + capsuleIdentifier,
      );
    }
    return parsed.data;
  }

  async listCapsules(ownerAgentInstanceId: string): Promise<ContextClosureCapsule[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.capsuleDirectoryPath(ownerAgentInstanceId));
    } catch {
      return [];
    }
    const capsules: ContextClosureCapsule[] = [];
    for (const fileName of fileNames.filter((name) => name.endsWith(".json")).sort()) {
      const capsule = await this.readCapsule(
        ownerAgentInstanceId,
        fileName.slice(0, -".json".length),
      );
      if (capsule !== null) {
        capsules.push(capsule);
      }
    }
    return capsules;
  }
}

export function computeContextClosureCapsuleContentHash(input: {
  contextNodeIdentifier: string;
  agentInstanceId: string;
  contextGraphRevision: number;
  finalDecisionSummary: string;
  inputSummary: string;
  outputSummary: string;
  verificationState: string;
  reopenCondition: string;
}): string {
  const canonicalText = [
    input.contextNodeIdentifier,
    input.agentInstanceId,
    String(input.contextGraphRevision),
    input.finalDecisionSummary,
    input.inputSummary,
    input.outputSummary,
    input.verificationState,
    input.reopenCondition,
  ].join("\u0000");
  return "sha256:" + createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

export interface PromptActiveFrontierEntry {
  contextNodeIdentifier: string;
  state: LocalContextGraphNode["state"];
  openRequiredChildCount: number;
  contentFingerprint: string;
}

export interface PromptActiveFrontier {
  graphIdentifier: string;
  ownerAgentInstanceId: string;
  revision: number;
  activeNodes: PromptActiveFrontierEntry[];
  excludedClosedNodeCount: number;
}

/** 提示词活跃前沿：只含未关闭节点；已关闭历史不注入（逻辑排除）。 */
export function buildPromptActiveFrontier(graph: LocalContextGraph): PromptActiveFrontier {
  const activeNodes = graph.nodes
    .filter((node) => !CLOSED_CONTEXT_NODE_STATES.includes(node.state))
    .map((node) => ({
      contextNodeIdentifier: node.contextNodeIdentifier,
      state: node.state,
      openRequiredChildCount: node.openRequiredChildCount,
      contentFingerprint: node.contentFingerprint,
    }))
    .sort((left, right) => left.contextNodeIdentifier.localeCompare(right.contextNodeIdentifier));
  return {
    graphIdentifier: graph.graphIdentifier,
    ownerAgentInstanceId: graph.ownerAgentInstanceId,
    revision: graph.revision,
    activeNodes,
    excludedClosedNodeCount: graph.nodes.length - activeNodes.length,
  };
}

export interface ActiveFrontierBuilderOptions {
  graphStore: LocalContextGraphStore;
}

/** 由图存储构造活跃前沿（关闭节点计数但不返回其内容）。 */
export async function buildActiveFrontierFromStore(
  options: ActiveFrontierBuilderOptions,
  ownerAgentInstanceId: string,
  graphIdentifier: string,
): Promise<PromptActiveFrontier | null> {
  const graph = await options.graphStore.readGraph(ownerAgentInstanceId, graphIdentifier);
  return graph === null ? null : buildPromptActiveFrontier(graph);
}
