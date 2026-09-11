/**
 * 全局决策相关选择与延后片段（T09A-03 / ADR-0031 §11.2）。
 *
 * 选择只依据版本化显式关系与预算，不使用语义相似度：
 * 1 当前任务直接约束（scope/关联节点）→ 2 必要前驱决策 → 3 接口/产物契约
 * → 4 用户固定关系；同级按 scope/ID 稳定排序。
 *
 * 预算内只注入完整记录；容纳不下时写 `GLOBAL_CONTEXT_DEFERRED_FRAGMENT_V1`
 * （按 agentInstanceId/mission 隔离），绝不截断记录文本。最高优先级类别的
 * 记录仍无法容纳时返回 budgetInsufficient 并要求拆分。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import {
  deferredGlobalContextFragmentSchema,
  type DeferredGlobalContextFragment,
  type GlobalDecisionRecord,
} from "./context-closure-schemas.js";
import { estimateGlobalDecisionTokenCount } from "./global-decision-store.js";

export const GLOBAL_DECISION_RELEVANCE_CATEGORIES = [
  "current-task-constraint",
  "required-predecessor-decision",
  "interface-or-artifact-contract",
  "user-pinned-relation",
] as const;
export type GlobalDecisionRelevanceCategory =
  (typeof GLOBAL_DECISION_RELEVANCE_CATEGORIES)[number];

export interface GlobalContextTaskRelation {
  taskIdentifier: string;
  missionId: string;
  scopeKeys: string[];
  requiredDecisionIdentifiers?: string[];
  relatedArtifactReferences?: string[];
  relatedContextNodeIdentifiers?: string[];
  userPinnedGlobalDecisionIdentifiers?: string[];
}

export interface SelectGlobalDecisionsInput {
  relation: GlobalContextTaskRelation;
  records: GlobalDecisionRecord[];
  maximumGlobalContextTokenCount: number;
}

export interface SelectGlobalDecisionsResult {
  selected: GlobalDecisionRecord[];
  unselectedRelatedDecisions: GlobalDecisionRecord[];
  selectedTokenCount: number;
  budgetInsufficient: boolean;
  highestPriorityUnmetTokenCount: number | null;
  selectionReasonsByIdentifier: Record<string, GlobalDecisionRelevanceCategory>;
}

interface RankedDecision {
  record: GlobalDecisionRecord;
  category: GlobalDecisionRelevanceCategory;
  estimatedTokenCount: number;
}

export function selectGlobalDecisionsForTask(
  input: SelectGlobalDecisionsInput,
): SelectGlobalDecisionsResult {
  const rankedDecisions = input.records
    .map((record) => rankDecision(record, input.relation))
    .filter((entry): entry is RankedDecision => entry !== null)
    .filter((entry) => entry.record.status === "active")
    .sort((left, right) => {
      const categoryDifference =
        GLOBAL_DECISION_RELEVANCE_CATEGORIES.indexOf(left.category) -
        GLOBAL_DECISION_RELEVANCE_CATEGORIES.indexOf(right.category);
      if (categoryDifference !== 0) {
        return categoryDifference;
      }
      const scopeDifference = left.record.appliesToScope.localeCompare(
        right.record.appliesToScope,
      );
      if (scopeDifference !== 0) {
        return scopeDifference;
      }
      return left.record.globalDecisionIdentifier.localeCompare(
        right.record.globalDecisionIdentifier,
      );
    });

  const selected: GlobalDecisionRecord[] = [];
  const unselectedRelatedDecisions: GlobalDecisionRecord[] = [];
  const selectionReasonsByIdentifier: Record<string, GlobalDecisionRelevanceCategory> = {};
  let selectedTokenCount = 0;
  let highestPriorityUnmetTokenCount: number | null = null;

  for (const rankedDecision of rankedDecisions) {
    if (
      selectedTokenCount + rankedDecision.estimatedTokenCount <=
      input.maximumGlobalContextTokenCount
    ) {
      selected.push(rankedDecision.record);
      selectedTokenCount += rankedDecision.estimatedTokenCount;
      selectionReasonsByIdentifier[rankedDecision.record.globalDecisionIdentifier] =
        rankedDecision.category;
      continue;
    }
    unselectedRelatedDecisions.push(rankedDecision.record);
    if (
      rankedDecision.category === "current-task-constraint" &&
      highestPriorityUnmetTokenCount === null
    ) {
      highestPriorityUnmetTokenCount = rankedDecision.estimatedTokenCount;
    }
  }

  return {
    selected,
    unselectedRelatedDecisions,
    selectedTokenCount,
    budgetInsufficient: highestPriorityUnmetTokenCount !== null,
    highestPriorityUnmetTokenCount,
    selectionReasonsByIdentifier,
  };
}

function rankDecision(
  record: GlobalDecisionRecord,
  relation: GlobalContextTaskRelation,
): RankedDecision | null {
  const category = determineRelevanceCategory(record, relation);
  if (category === null) {
    return null;
  }
  return {
    record,
    category,
    estimatedTokenCount: estimateGlobalDecisionTokenCount(record),
  };
}

function determineRelevanceCategory(
  record: GlobalDecisionRecord,
  relation: GlobalContextTaskRelation,
): GlobalDecisionRelevanceCategory | null {
  if (relation.userPinnedGlobalDecisionIdentifiers?.includes(record.globalDecisionIdentifier)) {
    return "user-pinned-relation";
  }
  if (relation.requiredDecisionIdentifiers?.includes(record.globalDecisionIdentifier)) {
    return "required-predecessor-decision";
  }
  if (
    relation.scopeKeys.includes(record.appliesToScope) ||
    relation.relatedContextNodeIdentifiers?.some((identifier) =>
      record.relatedContextNodeIdentifiers.includes(identifier),
    )
  ) {
    return "current-task-constraint";
  }
  if (
    relation.relatedArtifactReferences?.some((reference) =>
      record.artifactOrCommitReferences.includes(reference),
    )
  ) {
    return "interface-or-artifact-contract";
  }
  return null;
}

export interface DeferGlobalDecisionsInput {
  baseDirectory: string;
  ownerAgentInstanceId: string;
  missionId: string;
  sourceContextNodeIdentifier: string;
  sourceNodeRevision: number;
  decisions: GlobalDecisionRecord[];
  createdAtIso?: string;
}

export interface ReadDeferredGlobalContextFragmentsInput {
  baseDirectory: string;
  ownerAgentInstanceId: string;
  missionId?: string;
}

/**
 * 读取某 Agent 自己的延后上下文片段（按 agentInstanceId 目录隔离；
 * 目录内 ownership 不匹配或损坏的条目不返回，绝不跨 Agent 泄漏）。
 */
export async function readDeferredGlobalContextFragments(
  input: ReadDeferredGlobalContextFragmentsInput,
): Promise<DeferredGlobalContextFragment[]> {
  const directoryPath = path.join(
    input.baseDirectory,
    "agent-memory",
    sanitizePathSegment(input.ownerAgentInstanceId),
    "deferred-context",
  );
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(directoryPath);
  } catch {
    return [];
  }
  const fragments: DeferredGlobalContextFragment[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
    try {
      const rawContent = await fs.readFile(
        path.join(directoryPath, fileName),
        "utf8",
      );
      const parsed = deferredGlobalContextFragmentSchema.safeParse(
        JSON.parse(rawContent) as unknown,
      );
      if (!parsed.success) {
        continue;
      }
      if (parsed.data.ownerAgentInstanceId !== input.ownerAgentInstanceId) {
        continue;
      }
      if (
        input.missionId !== undefined &&
        parsed.data.missionId !== input.missionId
      ) {
        continue;
      }
      fragments.push(parsed.data);
    } catch {
      // 损坏条目跳过（不泄露、不阻塞其他片段）
    }
  }
  return fragments.sort((left, right) =>
    left.fragmentIdentifier.localeCompare(right.fragmentIdentifier),
  );
}

/** 写入按 agentInstanceId/mission 隔离的延后上下文片段（不进入普通提示词）。 */
export async function deferUnselectedGlobalDecisions(
  input: DeferGlobalDecisionsInput,
): Promise<string[]> {
  const directoryPath = path.join(
    input.baseDirectory,
    "agent-memory",
    sanitizePathSegment(input.ownerAgentInstanceId),
    "deferred-context",
  );
  await fs.mkdir(directoryPath, { recursive: true });
  const fragmentIdentifiers: string[] = [];
  for (const decision of input.decisions) {
    const fragmentIdentifier = "gd-frag-" + decision.globalDecisionIdentifier;
    const fragment = {
      schemaVersion: 1 as const,
      fragmentIdentifier,
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      missionId: input.missionId,
      sourceContextNodeIdentifier: input.sourceContextNodeIdentifier,
      sourceNodeRevision: input.sourceNodeRevision,
      contentHash: decision.contentHash,
      topics: [decision.appliesToScope],
      explicitRelationKeys: [decision.globalDecisionIdentifier],
      estimatedTokenCount: estimateGlobalDecisionTokenCount(decision),
      invalidationCondition: decision.invalidationCondition,
      createdAtIso: input.createdAtIso ?? new Date().toISOString(),
    };
    const parsed = deferredGlobalContextFragmentSchema.safeParse(fragment);
    if (!parsed.success) {
      throw new DomainError(
        "global-decision-invalid",
        "延后上下文片段 schema 校验失败: " + parsed.error.message,
      );
    }
    await writeAtomicJson(
      path.join(directoryPath, sanitizePathSegment(fragmentIdentifier) + ".json"),
      parsed.data,
    );
    fragmentIdentifiers.push(fragmentIdentifier);
  }
  return fragmentIdentifiers;
}
