/**
 * T07C-02 测试：六级优先级解析、四种策略与 fail-closed。
 * 验收：越具体覆盖越宽泛；列表耗尽 fail-closed；审计含选择原因与 fallback。
 */
import { describe, expect, it } from "vitest";

import { ModelSelectionPolicyResolver } from "../../../packages/core/src/orchestration/model-selection-policy-resolver.js";
import type {
  ModelCatalogAccessPort,
  ModelSelectionLayer,
} from "../../../packages/core/src/orchestration/model-selection-policy-resolver.js";

function makeCatalogEntry(modelProfileId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    providerProfileId: "openai",
    modelProfileId,
    displayName: modelProfileId,
    modelIdentifier: modelProfileId,
    capabilities: ["text", "tool-calling"],
    contextWindowTokens: 128_000,
    supportsToolCalling: true,
    supportsVision: false,
    costTier: "medium",
    regionLabel: "us-east",
    healthState: "healthy",
    revision: 1,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    updatedAtIso: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeCatalogPort(entries: ReturnType<typeof makeCatalogEntry>[]): ModelCatalogAccessPort {
  return { listPublicDtos: () => entries as never };
}

const resolver = new ModelSelectionPolicyResolver();

function makeLayer(modelProfileIds: string[], strategy: ModelSelectionLayer["strategy"]): ModelSelectionLayer {
  return { modelProfileIds, strategy, policyRevision: 1 };
}

describe("六级优先级解析", () => {
  const catalogPort = makeCatalogPort([
    makeCatalogEntry("openai/gpt-4o"),
    makeCatalogEntry("anthropic/claude-3"),
    makeCatalogEntry("openai/gpt-4o-mini"),
  ]);

  it("优先级 1（任务固定）覆盖其余层级", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer(["openai/gpt-4o"], "fixed"),
        makeLayer(["anthropic/claude-3"], "fixed"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
      ],
      requiredCapabilities: ["text"],
      catalogPort,
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBe("openai/gpt-4o");
      expect(result.effectiveLayerIndex).toBe(0);
    }
  });

  it("优先级 2（个体会话覆盖）：层 1 空 → 使用层 2", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], "fixed"),
        makeLayer(["anthropic/claude-3"], "fixed"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
        makeLayer(["openai/gpt-4o-mini"], "ordered-fallback"),
      ],
      requiredCapabilities: ["text"],
      catalogPort,
    });
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBe("anthropic/claude-3");
      expect(result.effectiveLayerIndex).toBe(1);
    }
  });

  it("全部层级未配置 → blocked（fail-closed）", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["text"],
      catalogPort,
    });
    expect(result.outcome).toBe("blocked");
  });

  it("审计：fallback 次序记录未配置层与过滤原因", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer(["openai/gpt-4o", "openai/ghost-model"], "ordered-fallback"),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["text"],
      catalogPort,
    });
    if (result.outcome === "selected") {
      expect(result.auditEntry.fallbackOrder.join(";")).toContain("layer-1-未配置");
      expect(result.auditEntry.fallbackOrder.join(";")).toContain("目录不存在");
      expect(result.auditEntry.effectivePolicyRevision).toBe(1);
    }
  });
});

describe("四种选择策略", () => {
  const catalogPort = makeCatalogPort([
    makeCatalogEntry("openai/gpt-4o"),
    makeCatalogEntry("openai/gpt-4o-mini"),
    makeCatalogEntry("anthropic/claude-3"),
  ]);

  const baseLayers: ModelSelectionLayer[] = [
    makeLayer([], null),
    makeLayer(["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3"], null),
    makeLayer([], null),
    makeLayer([], null),
    makeLayer([], null),
    makeLayer([], null),
  ];

  it("fixed：只取列表首个（即使后续更优）", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer(["openai/gpt-4o-mini", "openai/gpt-4o"], "fixed"),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["text"],
      catalogPort,
    });
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBe("openai/gpt-4o-mini");
      expect(result.selectedStrategy).toBe("fixed");
    }
  });

  it("ordered-fallback：跳过禁用/能力不匹配后取首个健康模型", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer(
          ["openai/disabled-model", "openai/gpt-4o"],
          "ordered-fallback",
        ),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["text"],
      catalogPort: makeCatalogPort([
        makeCatalogEntry("openai/gpt-4o"),
        makeCatalogEntry("openai/disabled-model", { healthState: "disabled" }),
      ]),
    });
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBe("openai/gpt-4o");
      expect(result.auditEntry.fallbackOrder.join(";")).toContain("已禁用");
    }
  });

  it("automatic-within-list：返回候选集（选择留待安全检查点）", () => {
    const result = resolver.resolveModelSelection({
      layers: baseLayers.map((layer, index) =>
        index === 1 ? { ...layer, strategy: "automatic-within-list" as const } : layer,
      ),
      requiredCapabilities: ["text"],
      catalogPort,
    });
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBeNull();
      expect(result.candidateModelProfileIds).toHaveLength(3);
      expect(result.selectedStrategy).toBe("automatic-within-list");
    }
  });

  it("manual-each-run：返回全部候选由用户逐次手选", () => {
    const result = resolver.resolveModelSelection({
      layers: baseLayers.map((layer, index) =>
        index === 1 ? { ...layer, strategy: "manual-each-run" as const } : layer,
      ),
      requiredCapabilities: ["text"],
      catalogPort,
    });
    if (result.outcome === "selected") {
      expect(result.selectedModelProfileId).toBeNull();
      expect(result.candidateModelProfileIds).toHaveLength(3);
      expect(result.selectedStrategy).toBe("manual-each-run");
    }
  });
});

describe("fail-closed 与能力过滤", () => {
  it("列表耗尽（全部禁用/能力不匹配）→ blocked，不静默用列表外模型", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer(["openai/vision-only"], "ordered-fallback"),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["tool-calling"],
      catalogPort: makeCatalogPort([
        makeCatalogEntry("openai/vision-only", {
          capabilities: ["text", "vision"],
          supportsToolCalling: false,
        }),
      ]),
    });
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.blockedReason).toContain("列表耗尽");
      expect(result.auditEntry.fallbackOrder.join(";")).toContain("能力不匹配");
    }
  });

  it("能力过滤：需要 vision 时只保留视觉模型", () => {
    const result = resolver.resolveModelSelection({
      layers: [
        makeLayer([], null),
        makeLayer(["openai/gpt-4o", "openai/vision-model"], "automatic-within-list"),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
        makeLayer([], null),
      ],
      requiredCapabilities: ["vision"],
      catalogPort: makeCatalogPort([
        makeCatalogEntry("openai/gpt-4o", { supportsVision: false }),
        makeCatalogEntry("openai/vision-model", {
          capabilities: ["text", "vision", "tool-calling"],
          supportsVision: true,
        }),
      ]),
    });
    if (result.outcome === "selected") {
      expect(result.candidateModelProfileIds).toEqual(["openai/vision-model"]);
    }
  });
});