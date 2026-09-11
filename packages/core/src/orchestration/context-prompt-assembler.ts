/**
 * 上下文提示词装配（T09A-R1-01 / ADR-0031）。
 *
 * 规则：
 * - 系统规则与任务必要条件独立于可选全局记录，始终进入提示词；
 * - 全局记录只注入“相关且 active 且预算内”的选择结果（无关记录不注入）；
 * - 局部活跃前沿只注入未关闭节点的标识/状态/指纹，已关闭节点只计数、不注入原文；
 * - 必要条件缺失时报告给调用方阻塞，不静默执行。
 */
import type { TaskDependencyNode } from "../core/types.js";
import { buildPromptActiveFrontier } from "./context-closure-capsule-store.js";
import type { GlobalDecisionStore } from "./global-decision-store.js";
import { selectGlobalDecisionsForTask } from "./global-decision-selector.js";
import { estimateRecallTokenCount } from "./context-recall-controller.js";
import type { ContextAssemblyRuntimeEvent } from "./context-runtime-metrics.js";
import type { LocalContextGraphStore } from "./local-context-graph-store.js";

/** 系统规则文本（独立于可选全局记录，任何预算下都进入提示词）。 */
export const APPLICATION_CONTEXT_SYSTEM_RULES = [
  "只执行分配的任务，不得扩大范围或静默放弃。",
  "工具副作用与敏感操作由本地确定性策略裁决；模型声明不能成为授权依据。",
  "完成必须给出当前仓库合法的版本化完成控制事件，由本地门禁结案。",
].join("\n");

export interface NecessaryContextCondition {
  conditionIdentifier: string;
  description: string;
  isSatisfied: boolean;
}

export interface ContextPromptGlobalDecision {
  globalDecisionIdentifier: string;
  decisionSummary: string;
  keyRationale: string;
}

export interface ContextPromptFrontierNode {
  contextNodeIdentifier: string;
  state: string;
  contentFingerprint: string;
}

export interface ContextPromptActiveFrontier {
  graphIdentifier: string;
  revision: number;
  activeNodes: ContextPromptFrontierNode[];
  excludedClosedNodeCount: number;
}

export interface AssembleContextPromptInput {
  systemRulesText: string;
  necessaryConditions: NecessaryContextCondition[];
  globalDecisionRecords: ContextPromptGlobalDecision[];
  activeFrontier: ContextPromptActiveFrontier | null;
}

export interface AssembledContextPrompt {
  promptText: string;
  injectedGlobalDecisionIdentifiers: string[];
  injectedFrontierNodeIdentifiers: string[];
  excludedClosedNodeCount: number;
  unsatisfiedNecessaryConditionIdentifiers: string[];
}

export function assembleContextPrompt(
  input: AssembleContextPromptInput,
): AssembledContextPrompt {
  const unsatisfiedNecessaryConditionIdentifiers = input.necessaryConditions
    .filter((condition) => !condition.isSatisfied)
    .map((condition) => condition.conditionIdentifier);
  const lines: string[] = ["[系统规则]", input.systemRulesText.trim(), "", "[任务必要条件]"];
  if (input.necessaryConditions.length === 0) {
    lines.push("- （无额外必要条件）");
  }
  for (const condition of input.necessaryConditions) {
    lines.push(
      "- " +
        condition.conditionIdentifier +
        ": " +
        condition.description +
        (condition.isSatisfied ? "" : "（缺失）"),
    );
  }
  lines.push("", "[全局相关决策]");
  const injectedGlobalDecisionIdentifiers: string[] = [];
  for (const record of input.globalDecisionRecords) {
    lines.push(
      "- " +
        record.globalDecisionIdentifier +
        ": " +
        record.decisionSummary +
        "（理由：" +
        record.keyRationale +
        "）",
    );
    injectedGlobalDecisionIdentifiers.push(record.globalDecisionIdentifier);
  }
  if (input.globalDecisionRecords.length === 0) {
    lines.push("- （无相关全局决策注入）");
  }
  lines.push("", "[局部活跃前沿]");
  const injectedFrontierNodeIdentifiers: string[] = [];
  if (input.activeFrontier === null) {
    lines.push("- （无局部上下文图）");
  } else {
    for (const node of input.activeFrontier.activeNodes) {
      lines.push(
        "- " +
          node.contextNodeIdentifier +
          " [" +
          node.state +
          "] fp=" +
          node.contentFingerprint.slice(0, 12),
      );
      injectedFrontierNodeIdentifiers.push(node.contextNodeIdentifier);
    }
    lines.push(
      "- （已关闭节点 " +
        input.activeFrontier.excludedClosedNodeCount +
        " 个：只计数，不注入原文）",
    );
  }
  return {
    promptText: lines.join("\n"),
    injectedGlobalDecisionIdentifiers,
    injectedFrontierNodeIdentifiers,
    excludedClosedNodeCount: input.activeFrontier?.excludedClosedNodeCount ?? 0,
    unsatisfiedNecessaryConditionIdentifiers,
  };
}

export interface ContextPromptProviderInput {
  missionId: string;
  agentInstanceId: string;
  task: TaskDependencyNode;
}

export type ContextPromptProvider = (
  input: ContextPromptProviderInput,
) => Promise<AssembledContextPrompt>;

export interface ContextPromptProviderOptions {
  globalDecisionStore: GlobalDecisionStore;
  graphStore: LocalContextGraphStore;
  maximumGlobalContextTokenCount: number;
  mandatoryConditions?: NecessaryContextCondition[];
  /** T09A-R1-02：预算策略提供者（设置变化通过 revision 使选择缓存失效）。 */
  budgetPolicyProvider?: () => Promise<{
    configuredMaximumGlobalContextTokenCount: number;
    globalContextBudgetPolicyRevision: number;
  }>;
  /** T09A-R1-02：Provider 可用输入空间（token）；配置超出时取较小有效值。 */
  modelInputSpaceTokens?: number | null;
  /** T09A-R1-04：真实装配事件接收器（原始事件 → 指标复算）。 */
  runtimeEventSink?: ((event: ContextAssemblyRuntimeEvent) => void | Promise<void>) | null;
  /** T09A-R1-04：时钟（测试可注入）。 */
  nowIso?: () => string;
}

export interface ContextBudgetResolution {
  configuredMaximumGlobalContextTokenCount: number;
  effectiveMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  budgetReductionReason: string | null;
}

/** 计算配置值、有效值与缩减原因（模型空间不足时缩减，不报错）。 */
export function resolveContextBudget(input: {
  configuredMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  modelInputSpaceTokens?: number | null;
}): ContextBudgetResolution {
  const modelSpace = input.modelInputSpaceTokens;
  if (modelSpace === undefined || modelSpace === null || modelSpace >= input.configuredMaximumGlobalContextTokenCount) {
    return {
      configuredMaximumGlobalContextTokenCount: input.configuredMaximumGlobalContextTokenCount,
      effectiveMaximumGlobalContextTokenCount: input.configuredMaximumGlobalContextTokenCount,
      budgetPolicyRevision: input.budgetPolicyRevision,
      budgetReductionReason: null,
    };
  }
  return {
    configuredMaximumGlobalContextTokenCount: input.configuredMaximumGlobalContextTokenCount,
    effectiveMaximumGlobalContextTokenCount: modelSpace,
    budgetPolicyRevision: input.budgetPolicyRevision,
    budgetReductionReason: "Provider 可用输入空间不足，按较小值生效",
  };
}

/** 由真实存储构建提示词装配提供者（全局选择 + 局部活跃前沿）。 */
export function createContextPromptProvider(
  options: ContextPromptProviderOptions,
): ContextPromptProvider {
  const selectionCache = new Map<string, ReturnType<typeof selectGlobalDecisionsForTask>>();
  const lastKeyPartsByScope = new Map<
    string,
    { budgetPolicyRevision: number; effectiveBudgetTokens: number; recordsFingerprint: string }
  >();
  return async (input) => {
    const policy =
      options.budgetPolicyProvider === undefined
        ? null
        : await options.budgetPolicyProvider();
    const budget = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount:
        policy?.configuredMaximumGlobalContextTokenCount ??
        options.maximumGlobalContextTokenCount,
      budgetPolicyRevision: policy?.globalContextBudgetPolicyRevision ?? 0,
      modelInputSpaceTokens: options.modelInputSpaceTokens,
    });
    const records = await options.globalDecisionStore.listRecords();
    const recordsFingerprint = records
      .map((record) => record.globalDecisionIdentifier + ":" + record.globalContextRevision)
      .join(",");
    const cacheKey = [
      input.missionId,
      input.agentInstanceId,
      input.task.id,
      String(budget.budgetPolicyRevision),
      String(budget.effectiveMaximumGlobalContextTokenCount),
      recordsFingerprint,
    ].join("|");
    const scopeKey = input.missionId + "|" + input.agentInstanceId + "|" + input.task.id;
    const previousKeyParts = lastKeyPartsByScope.get(scopeKey);
    lastKeyPartsByScope.set(scopeKey, {
      budgetPolicyRevision: budget.budgetPolicyRevision,
      effectiveBudgetTokens: budget.effectiveMaximumGlobalContextTokenCount,
      recordsFingerprint,
    });
    let selection = selectionCache.get(cacheKey);
    const cacheStatus: "hit" | "miss" = selection === undefined ? "miss" : "hit";
    let invalidationReason: string | null = null;
    if (selection === undefined && previousKeyParts !== undefined) {
      if (previousKeyParts.budgetPolicyRevision !== budget.budgetPolicyRevision) {
        invalidationReason = "budget-policy-revision-change";
      } else if (previousKeyParts.effectiveBudgetTokens !== budget.effectiveMaximumGlobalContextTokenCount) {
        invalidationReason = "effective-budget-change";
      } else if (previousKeyParts.recordsFingerprint !== recordsFingerprint) {
        invalidationReason = "global-records-change";
      }
    }
    if (selection === undefined) {
      selection = selectGlobalDecisionsForTask({
        relation: {
          taskIdentifier: input.task.id,
          missionId: input.missionId,
          scopeKeys: [input.missionId, input.task.id],
        },
        records,
        maximumGlobalContextTokenCount:
          budget.effectiveMaximumGlobalContextTokenCount,
      });
      selectionCache.set(cacheKey, selection);
    }
    const graph = await options.graphStore.readGraph(
      input.agentInstanceId,
      input.missionId,
    );
    const frontier = graph === null ? null : buildPromptActiveFrontier(graph);
    const runtimeEventSink = options.runtimeEventSink ?? null;
    const emitRuntimeEvent = (assembled: AssembledContextPrompt): void => {
      if (runtimeEventSink === null) {
        return;
      }
      const event: ContextAssemblyRuntimeEvent = {
        schemaVersion: 1,
        eventType: "context-assembly",
        recordedAtIso: options.nowIso?.() ?? new Date().toISOString(),
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        taskIdentifier: input.task.id,
        cacheStatus,
        invalidationReason,
        injectedGlobalDecisionCount: assembled.injectedGlobalDecisionIdentifiers.length,
        injectedFrontierNodeCount: assembled.injectedFrontierNodeIdentifiers.length,
        excludedClosedNodeCount: assembled.excludedClosedNodeCount,
        estimatedInjectedTokenCount: estimateRecallTokenCount(assembled.promptText),
        budgetPolicyRevision: budget.budgetPolicyRevision,
        effectiveBudgetTokens: budget.effectiveMaximumGlobalContextTokenCount,
      };
      void Promise.resolve(runtimeEventSink(event)).catch(() => {});
    };
    const assembled = assembleContextPrompt({
      systemRulesText: APPLICATION_CONTEXT_SYSTEM_RULES,
      necessaryConditions: options.mandatoryConditions ?? [],
      globalDecisionRecords: selection.selected.map((record) => ({
        globalDecisionIdentifier: record.globalDecisionIdentifier,
        decisionSummary: record.decisionSummary,
        keyRationale: record.keyRationale,
      })),
      activeFrontier:
        frontier === null
          ? null
          : {
              graphIdentifier: frontier.graphIdentifier,
              revision: frontier.revision,
              activeNodes: frontier.activeNodes.map((node) => ({
                contextNodeIdentifier: node.contextNodeIdentifier,
                state: node.state,
                contentFingerprint: node.contentFingerprint,
              })),
              excludedClosedNodeCount: frontier.excludedClosedNodeCount,
            },
    });
    emitRuntimeEvent(assembled);
    return assembled;
  };
}
