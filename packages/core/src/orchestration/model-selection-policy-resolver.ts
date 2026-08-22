/**
 * 模型选择策略解析器（T07C-02 / ADR-0026 §2/§3/§5）。
 *
 * 六级配置优先级（越具体覆盖越宽泛，但不能突破全局禁用/数据策略）：
 *   1. 当前任务的认证用户显式固定模型或预设
 *   2. 具体 agentInstanceId 的会话级覆盖
 *   3. TaskAgentPreset 的任务类型映射
 *   4. Agent 用途允许列表
 *   5. Agent 层级默认列表
 *   6. 会话全局默认列表
 *
 * 四种选择策略：fixed / ordered-fallback / automatic-within-list / manual-each-run。
 * 用户强制允许列表是硬上限；列表耗尽（无健康且满足能力要求的模型）时
 * fail-closed 返回 blocked，不得静默使用列表外模型。
 * 解析结果、选择原因、策略 revision 与 fallback 次序写入审计。
 */
import { DomainError } from "../core/errors.js";
import type {
  ModelCapabilityTag,
  ModelProviderCatalogPublicDto,
} from "./model-provider-catalog.js";

export const MODEL_SELECTION_STRATEGIES = [
  "fixed",
  "ordered-fallback",
  "automatic-within-list",
  "manual-each-run",
] as const;
export type ModelSelectionStrategy =
  (typeof MODEL_SELECTION_STRATEGIES)[number];

/** 目录访问端口（本地控制面注入；公开 DTO 无凭据）。 */
export interface ModelCatalogAccessPort {
  listPublicDtos(): ModelProviderCatalogPublicDto[];
}

/** 六级中的某一层配置（按优先级 1..6 传入）。 */
export interface ModelSelectionLayer {
  /** 该层允许列表（空 = 该层未配置，继续解析下一层）。 */
  modelProfileIds: string[];
  /** 该层选择策略（null = 继承更具体层/默认）。 */
  strategy: ModelSelectionStrategy | null;
  policyRevision: number;
}

export interface ModelSelectionResolveInput {
  /** 按优先级排列的六层（index 0 = 任务固定 … index 5 = 会话默认）。 */
  layers: ModelSelectionLayer[];
  /** 任务所需能力（如 tool-calling/vision；能力不匹配即过滤）。 */
  requiredCapabilities: ModelCapabilityTag[];
  catalogPort: ModelCatalogAccessPort;
}

export type ModelSelectionResolution =
  | {
      outcome: "selected";
      /** 最终选中的模型（固定/有序回退/自动 的确定结果）。 */
      selectedModelProfileId: string | null;
      /** 可选候选集（automatic-within-list / manual-each-run 使用）。 */
      candidateModelProfileIds: string[];
      selectedStrategy: ModelSelectionStrategy;
      effectiveLayerIndex: number;
      effectivePolicyRevision: number;
      auditEntry: ModelSelectionAuditEntry;
    }
  | {
      outcome: "blocked";
      blockedReason: string;
      auditEntry: ModelSelectionAuditEntry;
    };

export interface ModelSelectionAuditEntry {
  resolvedAtIso: string;
  effectiveLayerIndex: number;
  effectivePolicyRevision: number;
  catalogRevisionNote: string;
  selectionReason: string;
  fallbackOrder: string[];
  requiredCapabilities: ModelCapabilityTag[];
}

/** 确定性解析：取第一个配置了列表的层；策略取该层或继承最近更具体层。 */
export class ModelSelectionPolicyResolver {
  resolveModelSelection(
    input: ModelSelectionResolveInput,
  ): ModelSelectionResolution {
    const auditFallbackOrder: string[] = [];
    let effectiveLayerIndex = -1;
    let effectiveLayer: ModelSelectionLayer | null = null;
    for (let index = 0; index < input.layers.length; index++) {
      const layer = input.layers[index]!;
      if (layer.modelProfileIds.length > 0) {
        effectiveLayerIndex = index;
        effectiveLayer = layer;
        break;
      }
      auditFallbackOrder.push(`layer-${index + 1}-未配置`);
    }
    if (effectiveLayer === null) {
      return {
        outcome: "blocked",
        blockedReason: "全部六级配置均未提供允许列表（fail-closed）",
        auditEntry: this.buildAuditEntry({
          effectiveLayerIndex: -1,
          effectivePolicyRevision: 0,
          selectionReason: "无有效配置层",
          fallbackOrder: auditFallbackOrder,
          requiredCapabilities: input.requiredCapabilities,
        }),
      };
    }
    // 策略：取有效层策略；为空则继承（向更具体层回退）
    let selectedStrategy = effectiveLayer.strategy;
    let strategySourceLayerIndex = effectiveLayerIndex;
    for (let index = effectiveLayerIndex - 1; index >= 0; index--) {
      if (selectedStrategy !== null) {
        break;
      }
      const candidateLayer = input.layers[index]!;
      if (candidateLayer.strategy !== null) {
        selectedStrategy = candidateLayer.strategy;
        strategySourceLayerIndex = index;
        break;
      }
    }
    const strategy = selectedStrategy ?? "automatic-within-list";
    void strategySourceLayerIndex;

    // 目录过滤：健康 + 能力满足（列表是硬上限，过滤后不引入列表外模型）
    const catalogEntries = new Map(
      input.catalogPort.listPublicDtos().map((dto) => [dto.modelProfileId, dto]),
    );
    const filteredCandidates: string[] = [];
    const fallbackOrder: string[] = [];
    for (const modelProfileId of effectiveLayer.modelProfileIds) {
      const entry = catalogEntries.get(modelProfileId);
      if (entry === undefined) {
        fallbackOrder.push(`${modelProfileId}(目录不存在)`);
        continue;
      }
      if (entry.healthState === "disabled") {
        fallbackOrder.push(`${modelProfileId}(已禁用)`);
        continue;
      }
      const hasAllCapabilities = input.requiredCapabilities.every(
        (capability) => entry.capabilities.includes(capability),
      );
      if (!hasAllCapabilities) {
        fallbackOrder.push(`${modelProfileId}(能力不匹配)`);
        continue;
      }
      filteredCandidates.push(modelProfileId);
    }

    if (filteredCandidates.length === 0) {
      return {
        outcome: "blocked",
        blockedReason: "允许列表耗尽（无健康且满足能力要求的模型）；不得静默使用列表外模型",
        auditEntry: this.buildAuditEntry({
          effectiveLayerIndex,
          effectivePolicyRevision: effectiveLayer.policyRevision,
          selectionReason: "列表耗尽 fail-closed",
          fallbackOrder: [...auditFallbackOrder, ...fallbackOrder],
          requiredCapabilities: input.requiredCapabilities,
        }),
      };
    }

    let selectedModelProfileId: string | null = null;
    switch (strategy) {
      case "fixed":
        selectedModelProfileId = filteredCandidates[0]!;
        break;
      case "ordered-fallback":
        selectedModelProfileId = filteredCandidates[0]!;
        break;
      case "automatic-within-list":
        // 由运行时在候选集内选择（本解析器返回候选集；选择留待安全检查点）
        selectedModelProfileId = null;
        break;
      case "manual-each-run":
        selectedModelProfileId = null;
        break;
    }

    return {
      outcome: "selected",
      selectedModelProfileId,
      candidateModelProfileIds: filteredCandidates,
      selectedStrategy: strategy,
      effectiveLayerIndex,
      effectivePolicyRevision: effectiveLayer.policyRevision,
      auditEntry: this.buildAuditEntry({
        effectiveLayerIndex,
        effectivePolicyRevision: effectiveLayer.policyRevision,
        selectionReason:
          strategy === "fixed" || strategy === "ordered-fallback"
            ? `选择 ${filteredCandidates[0]}`
            : `提供候选集（${filteredCandidates.length} 个）`,
        fallbackOrder: [...auditFallbackOrder, ...fallbackOrder],
        requiredCapabilities: input.requiredCapabilities,
      }),
    };
  }

  private buildAuditEntry(input: {
    effectiveLayerIndex: number;
    effectivePolicyRevision: number;
    selectionReason: string;
    fallbackOrder: string[];
    requiredCapabilities: ModelCapabilityTag[];
  }): ModelSelectionAuditEntry {
    return {
      resolvedAtIso: new Date().toISOString(),
      effectiveLayerIndex: input.effectiveLayerIndex,
      effectivePolicyRevision: input.effectivePolicyRevision,
      catalogRevisionNote: "catalog-revision-tracked-locally",
      selectionReason: input.selectionReason,
      fallbackOrder: input.fallbackOrder,
      requiredCapabilities: input.requiredCapabilities,
    };
  }
}

/** 用途模型策略（含选择策略；revision 绑定）。 */
export interface PurposeModelPolicy {
  purposeId: string;
  strategy: ModelSelectionStrategy;
  allowedModelProfileIds: string[];
  revision: number;
}

/** 校验策略 revision 匹配（变化需重新解析）。 */
export function assertPurposePolicyRevision(
  actualRevision: number,
  expectedRevision: number,
): void {
  if (actualRevision !== expectedRevision) {
    throw new DomainError(
      "stale-revision",
      `用途模型策略 revision 不匹配: ${actualRevision}，期望 ${expectedRevision}`,
    );
  }
}