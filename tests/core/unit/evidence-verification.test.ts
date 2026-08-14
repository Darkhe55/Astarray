/**
 * T06D 单测：高严谨性事实验证（ADR-0016）。
 * 覆盖：严谨性规则（含上调不降）、证据包三层排序/矛盾展示、
 * 完成门禁（未调用/无覆盖/仅推理拒绝）、搜索代理结构化查询与指纹缓存/
 * 预算/敏感查询拒绝、factVerification 工具四动作、输出无合格判定。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { LocalRigorPolicyEngine } from "../../../packages/core/src/tools/local-rigor-policy-engine.js";
import { EvidenceBundleBuilder } from "../../../packages/core/src/tools/evidence-bundle-builder.js";
import { EvidenceCompletionGate } from "../../../packages/core/src/tools/evidence-completion-gate.js";
import {
  EvidenceQueryGuard,
  buildNormalizedQueryFingerprint,
} from "../../../packages/core/src/tools/evidence-search-agent-port.js";
import type { EvidenceSourceSearchResult } from "../../../packages/core/src/tools/evidence-search-agent-port.js";
import type { EvidenceBundleEntry } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06d-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function buildContext(overrides: Record<string, unknown> = {}) {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "agent-fact",
    taskExecutionId: "task-fact-1",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    factVerificationClaimIdentifier: "claim-1",
    ...overrides,
  };
}

function makeFakeSearchAgent(results: EvidenceSourceSearchResult[]) {
  let callCount = 0;
  return {
    agent: {
      searchSources: async () => {
        callCount += 1;
        return results;
      },
    },
    getCallCount: () => callCount,
  };
}

function makeSourceEntry(overrides: Partial<EvidenceBundleEntry> = {}) {
  return {
    entryType: "source",
    claimIdentifier: "claim-1",
    title: "官方文档",
    publisherOrAuthor: "发布方",
    directLinkOrDocumentId: "https://example.com/doc",
    publishedAtIso: "2026-01-01T00:00:00.000Z",
    retrievedAtIso: "2026-08-13T00:00:00.000Z",
    relevantExcerptSummary: "正文摘要",
    contentHash: `sha256:${"a".repeat(64)}`,
    sourceType: "official",
    ...overrides,
  } as EvidenceBundleEntry;
}

describe("LocalRigorPolicyEngine", () => {
  const engine = new LocalRigorPolicyEngine();

  it("法律/医疗/财务/安全/破坏性/发布/身份/时效性任务默认 high", () => {
    const highDescriptions = [
      "请依据最新法律规定评估",
      "给出医疗用药建议",
      "分析本季度财务数据并给出投资结论",
      "修改权限边界",
      "删除该目录（不可逆）",
      "发布到生产环境",
      "轮换 API key",
      "今天的股价是",
    ];
    for (const description of highDescriptions) {
      expect(engine.classifyRigor(description).rigorLevel).toBe("high");
    }
    expect(
      engine.classifyRigor("重构模块 A 的内部实现").rigorLevel,
    ).toBe("standard");
  });

  it("模型只能上调不能下调严谨性", () => {
    expect(
      engine.resolveRigorLevel({ baseLevel: "standard", requestedLevel: "high" }),
    ).toEqual({ rigorLevel: "high", isDowngradeRejected: false });
    expect(
      engine.resolveRigorLevel({ baseLevel: "high", requestedLevel: "standard" }),
    ).toEqual({ rigorLevel: "high", isDowngradeRejected: true });
    expect(
      engine.resolveRigorLevel({ baseLevel: "standard", requestedLevel: "standard" }),
    ).toEqual({ rigorLevel: "standard", isDowngradeRejected: false });
  });

  it("分类携带规则版本与命中规则 ID", () => {
    const classification = engine.classifyRigor("删除数据库（不可逆）");
    expect(classification.rulesVersion).toBeGreaterThanOrEqual(1);
    expect(classification.matchedRuleIds).toContain("destructive-operation");
  });
});

describe("EvidenceBundleBuilder", () => {
  const builder = new EvidenceBundleBuilder();

  it("三层证据按固定权重排序：source > experiment > reasoning", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        {
          entryType: "reasoning",
          claimIdentifier: "claim-1",
          premises: ["前提 A"],
          uncertainty: "高",
        } as EvidenceBundleEntry,
        makeSourceEntry(),
        {
          entryType: "local-experiment",
          claimIdentifier: "claim-1",
          environmentSummary: "node 20",
          stepsOrCommands: ["node test.mjs"],
          inputSummary: "输入",
          exitStatus: "success",
          observation: "观察",
          artifactHash: null,
          replayableLimitation: null,
        } as EvidenceBundleEntry,
      ],
    });
    expect(bundle.entries.map((entry) => entry.entryType)).toEqual([
      "source",
      "local-experiment",
      "reasoning",
    ]);
    expect(bundle.coverageNotes.length).toBe(3);
  });

  it("全部资料为 Agent 自述 → 局限提示（不能作为独立依据）", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        makeSourceEntry({ sourceType: "agent-self" }),
        {
          entryType: "reasoning",
          claimIdentifier: "claim-1",
          premises: ["前提"],
          uncertainty: "中",
        } as EvidenceBundleEntry,
      ],
    });
    expect(bundle.relation).toBe("supported");
    expect(
      bundle.limitations.some((limitation) => limitation.includes("Agent 自述")),
    ).toBe(true);
  });

  it("空证据包与 claim 不一致被拒绝", () => {
    expect(() =>
      builder.buildEvidenceBundle({
        claimIdentifier: "claim-1",
        builderAgentInstanceId: "agent-fact",
        entries: [],
      }),
    ).toThrowError(/不能为空/);
    expect(() =>
      builder.buildEvidenceBundle({
        claimIdentifier: "claim-1",
        builderAgentInstanceId: "agent-fact",
        entries: [makeSourceEntry({ claimIdentifier: "claim-2" })],
      }),
    ).toThrowError(/不一致/);
  });

  it("输出只含证据关系，无合格判定字段", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [makeSourceEntry()],
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("qualified");
    expect(serialized).not.toContain('"safe"');
    expect(["supported", "contradicted", "mixed", "insufficient", "unavailable"]).toContain(
      bundle.relation,
    );
  });

  it("显式矛盾/不可用关系被保留并生成局限提示", () => {
    const contradictedBundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        makeSourceEntry(),
        makeSourceEntry({
          title: "相反结论",
          contentHash: `sha256:${"c".repeat(64)}`,
        }),
      ],
      requestedRelation: "contradicted",
    });
    expect(contradictedBundle.relation).toBe("contradicted");
    expect(
      contradictedBundle.limitations.some((limitation) =>
        limitation.includes("矛盾证据"),
      ),
    ).toBe(true);

    const unavailableBundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [makeSourceEntry()],
      requestedRelation: "unavailable",
    });
    expect(unavailableBundle.relation).toBe("unavailable");
    expect(
      unavailableBundle.limitations.some((limitation) =>
        limitation.includes("不可用"),
      ),
    ).toBe(true);
  });

  it("仅本地实验（无来源正文）→ insufficient 且提示证据不足", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        {
          entryType: "local-experiment",
          claimIdentifier: "claim-1",
          environmentSummary: "node 20",
          stepsOrCommands: ["node test.mjs"],
          inputSummary: "输入",
          exitStatus: "success",
          observation: "观察",
          artifactHash: null,
          replayableLimitation: null,
        } as EvidenceBundleEntry,
      ],
    });
    expect(bundle.relation).toBe("insufficient");
    expect(
      bundle.limitations.some((limitation) => limitation.includes("证据不足")),
    ).toBe(true);
  });
});

describe("EvidenceCompletionGate", () => {
  const gate = new EvidenceCompletionGate();
  const builder = new EvidenceBundleBuilder();

  it("无证据包 → 未满足", () => {
    const result = gate.evaluateEvidenceBundle(null, {
      requiredClaimIdentifier: "claim-1",
      requireSourceText: true,
    });
    expect(result.isPassable).toBe(false);
    expect(result.unmetRequirements.join()).toContain("factVerification");
  });

  it("仅纯推理 → 未满足（缺来源正文）", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [
        {
          entryType: "reasoning",
          claimIdentifier: "claim-1",
          premises: ["前提"],
          uncertainty: "高",
        } as EvidenceBundleEntry,
      ],
    });
    const result = gate.evaluateEvidenceBundle(bundle, {
      requiredClaimIdentifier: "claim-1",
      requireSourceText: true,
    });
    expect(result.isPassable).toBe(false);
    expect(result.unmetRequirements.join()).toContain("资料正文");
  });

  it("有来源正文且主张一致 → 门禁通过（仅流程已执行）", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [makeSourceEntry()],
    });
    const result = gate.evaluateEvidenceBundle(bundle, {
      requiredClaimIdentifier: "claim-1",
      requireSourceText: true,
    });
    expect(result.isPassable).toBe(true);
  });

  it("unavailable（离线/搜索失败）→ 不得宣称已证实", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-1",
      builderAgentInstanceId: "agent-fact",
      entries: [makeSourceEntry()],
    });
    const unavailableBundle = { ...bundle, relation: "unavailable" as const };
    const result = gate.evaluateEvidenceBundle(unavailableBundle, {
      requiredClaimIdentifier: "claim-1",
      requireSourceText: true,
    });
    expect(result.isPassable).toBe(false);
    expect(result.unmetRequirements.join()).toContain("不可用");
  });

  it("证据包主张与任务关键主张不一致 → 未满足", () => {
    const bundle = builder.buildEvidenceBundle({
      claimIdentifier: "claim-other",
      builderAgentInstanceId: "agent-fact",
      entries: [makeSourceEntry({ claimIdentifier: "claim-other" })],
    });
    const result = gate.evaluateEvidenceBundle(bundle, {
      requiredClaimIdentifier: "claim-1",
      requireSourceText: true,
    });
    expect(result.isPassable).toBe(false);
    expect(result.unmetRequirements.join()).toContain("不一致");
  });
});

describe("EvidenceQueryGuard（防换词活锁/泄密）", () => {
  it("等价查询指纹一致且缓存复用", async () => {
    const fake = makeFakeSearchAgent([
      {
        title: "t",
        publisherOrAuthor: "p",
        directLinkOrDocumentId: "d",
        publishedAtIso: null,
        retrievedExcerptText: "正文",
        retrievedAtIso: "2026-08-13T00:00:00.000Z",
        sourceType: "official",
      },
    ]);
    const guard = new EvidenceQueryGuard();
    expect(
      buildNormalizedQueryFingerprint("  Delete   DB "),
    ).toBe(buildNormalizedQueryFingerprint("delete db"));
    const first = await guard.searchSafely({
      structuredQuery: "delete db",
      claimIdentifier: "claim-1",
      agent: fake.agent,
    });
    expect(first.fromCache).toBe(false);
    const second = await guard.searchSafely({
      structuredQuery: "Delete  DB",
      claimIdentifier: "claim-1",
      agent: fake.agent,
    });
    expect(second.fromCache).toBe(true);
    expect(fake.getCallCount()).toBe(1);
  });

  it("每主张查询预算用尽后换词查询被阻断", async () => {
    const fake = makeFakeSearchAgent([]);
    const guard = new EvidenceQueryGuard(3);
    for (let index = 0; index < 3; index++) {
      await guard.searchSafely({
        structuredQuery: `查询变体 ${index}`,
        claimIdentifier: "claim-1",
        agent: fake.agent,
      });
    }
    await expect(
      guard.searchSafely({
        structuredQuery: "第 4 个变体",
        claimIdentifier: "claim-1",
        agent: fake.agent,
      }),
    ).rejects.toMatchObject({ errorCode: "livelock-guard-triggered" });
  });

  it("含凭据/私钥的查询被本地阻断（不上传）", async () => {
    const fake = makeFakeSearchAgent([]);
    const guard = new EvidenceQueryGuard();
    await expect(
      guard.searchSafely({
        structuredQuery: "检查 token=abcdefghijklmnopqrstuvwxyz123456 是否有效",
        claimIdentifier: "claim-1",
        agent: fake.agent,
      }),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    expect(fake.getCallCount()).toBe(0);
  });

  it("缓存超出上限时淘汰最旧条目", async () => {
    const fake = makeFakeSearchAgent([]);
    const guard = new EvidenceQueryGuard(20, 1);
    await guard.searchSafely({
      structuredQuery: "查询 A",
      claimIdentifier: "claim-1",
      agent: fake.agent,
    });
    await guard.searchSafely({
      structuredQuery: "查询 B",
      claimIdentifier: "claim-1",
      agent: fake.agent,
    });
    expect(guard.getCacheSize()).toBe(1);
    expect(fake.getCallCount()).toBe(2);
  });
});

describe("factVerification 工具", () => {
  it("search-sources 返回资料结果与来源字段", async () => {
    const fake = makeFakeSearchAgent([
      {
        title: "官方文档",
        publisherOrAuthor: "发布方",
        directLinkOrDocumentId: "https://example.com/doc",
        publishedAtIso: "2026-01-01T00:00:00.000Z",
        retrievedExcerptText: "实际取得的正文内容",
        retrievedAtIso: "2026-08-13T00:00:00.000Z",
        sourceType: "official",
      },
    ]);
    const result = await executeBuiltinTool(
      "factVerification",
      JSON.stringify({
        action: "search-sources",
        structuredQuery: "astarray evidence",
      }),
      buildContext({
        evidenceSearchAgent: fake.agent,
        evidenceQueryGuard: new EvidenceQueryGuard(),
      }),
    );
    const parsed = JSON.parse(result.outputText) as {
      relation: string;
      results: Array<{ title: string; directLinkOrDocumentId: string }>;
    };
    expect(parsed.relation).toBe("supported");
    expect(parsed.results[0]?.title).toBe("官方文档");
    expect(parsed.results[0]?.directLinkOrDocumentId).toContain("example.com");
  });

  it("search-sources 无资料 → unavailable；未装配代理 → 报错（离线）", async () => {
    const fake = makeFakeSearchAgent([]);
    const result = await executeBuiltinTool(
      "factVerification",
      JSON.stringify({
        action: "search-sources",
        structuredQuery: "查不到",
      }),
      buildContext({
        evidenceSearchAgent: fake.agent,
        evidenceQueryGuard: new EvidenceQueryGuard(),
      }),
    );
    expect(JSON.parse(result.outputText).relation).toBe("unavailable");
    await expect(
      executeBuiltinTool(
        "factVerification",
        JSON.stringify({
          action: "search-sources",
          structuredQuery: "x",
        }),
        buildContext({ evidenceSearchAgent: null }),
      ),
    ).rejects.toThrowError(/未装配/);
  });

  it("record-reasoning 标记 insufficient（纯推理不构成证实）", async () => {
    const result = await executeBuiltinTool(
      "factVerification",
      JSON.stringify({
        action: "record-reasoning",
        premises: ["前提"],
        uncertainty: "高",
      }),
      buildContext(),
    );
    const parsed = JSON.parse(result.outputText) as { relation: string };
    expect(parsed.relation).toBe("insufficient");
  });

  it("build-evidence-bundle 输出 schema 校验后的证据包", async () => {
    const builder = new EvidenceBundleBuilder();
    const sourceEntry = {
      entryType: "source",
      claimIdentifier: "claim-1",
      title: "文档",
      publisherOrAuthor: "发布方",
      directLinkOrDocumentId: "doc-1",
      publishedAtIso: null,
      retrievedAtIso: "2026-08-13T00:00:00.000Z",
      relevantExcerptSummary: "摘要",
      contentHash: `sha256:${"b".repeat(64)}`,
      sourceType: "official",
    };
    const result = await executeBuiltinTool(
      "factVerification",
      JSON.stringify({
        action: "build-evidence-bundle",
        entries: [sourceEntry],
      }),
      buildContext({ evidenceBundleBuilder: builder }),
    );
    const bundle = JSON.parse(result.outputText) as {
      schemaVersion: number;
      relation: string;
      entries: Array<{ entryType: string }>;
    };
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.relation).toBe("supported");
    expect(bundle.entries[0]?.entryType).toBe("source");
  });

  it("非法 action/缺失参数报错", async () => {
    await expect(
      executeBuiltinTool(
        "factVerification",
        JSON.stringify({ action: "purge" }),
        buildContext(),
      ),
    ).rejects.toThrowError(/action 非法/);
    await expect(
      executeBuiltinTool(
        "factVerification",
        JSON.stringify({ action: "search-sources" }),
        buildContext(),
      ),
    ).rejects.toThrowError(/structuredQuery/);
  });
});
