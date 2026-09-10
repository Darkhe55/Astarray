/**
 * T09A-03：全局决策提升、去重/冲突/替代、相关选择、预算与延后片段。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GlobalDecisionStore,
  computeGlobalDecisionContentHash,
  estimateGlobalDecisionTokenCount,
} from "../../../packages/core/src/orchestration/global-decision-store.js";
import {
  deferUnselectedGlobalDecisions,
  selectGlobalDecisionsForTask,
} from "../../../packages/core/src/orchestration/global-decision-selector.js";
import { deferredGlobalContextFragmentSchema } from "../../../packages/core/src/orchestration/context-closure-schemas.js";
import type { GlobalDecisionRecord } from "../../../packages/core/src/orchestration/context-closure-schemas.js";

let temporaryDirectory: string;
let store: GlobalDecisionStore;
let nowMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gd-"));
  nowMilliseconds = 1_800_000_000_000;
  store = new GlobalDecisionStore({
    baseDirectory: temporaryDirectory,
    nowMilliseconds: () => {
      nowMilliseconds += 1_000;
      return nowMilliseconds;
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function buildCandidate(overrides: Record<string, unknown> = {}) {
  return {
    decisionSummary: "采用本地版本化上下文生命周期",
    keyRationale: "降低 token 并保留来源",
    appliesToScope: "core/orchestration",
    informationSource: { sourceType: "user" as const, userId: "u-1" },
    sourceRevision: 1,
    ...overrides,
  };
}

function asRecord(overrides: Partial<GlobalDecisionRecord> = {}): GlobalDecisionRecord {
  const base = {
    schemaVersion: 1 as const,
    globalDecisionIdentifier: "gd-1",
    globalContextRevision: 1,
    decisionSummary: "摘要",
    keyRationale: "理由",
    rejectedAlternatives: [],
    appliesToScope: "scope-a",
    relatedContextNodeIdentifiers: [],
    artifactOrCommitReferences: [],
    informationSource: { sourceType: "user" as const, userId: "u-1" },
    sourceRevision: 1,
    contentHash: "sha256:" + "a".repeat(64),
    createdAtIso: "2026-09-09T10:00:00.000Z",
    status: "active" as const,
  };
  return { ...base, ...overrides };
}

describe("GlobalDecisionStore（T09A-03）", () => {
  it("用户来源提升为 active；Agent 来源只能 pending-human-review", async () => {
    const userPromotion = await store.promoteCandidate(buildCandidate());
    expect(userPromotion.record.status).toBe("active");
    const agentPromotion = await store.promoteCandidate(
      buildCandidate({
        decisionSummary: "另一条 Agent 结论",
        informationSource: { sourceType: "agent", agentInstanceId: "agent-a" },
      }),
    );
    expect(agentPromotion.record.status).toBe("pending-human-review");
  });

  it("同 scope 同内容幂等去重（不新增记录）", async () => {
    const first = await store.promoteCandidate(buildCandidate());
    const second = await store.promoteCandidate(buildCandidate());
    expect(second.outcome).toBe("deduplicated");
    expect(second.record.globalDecisionIdentifier).toBe(
      first.record.globalDecisionIdentifier,
    );
    expect(await store.listRecords()).toHaveLength(1);
  });

  it("同 scope 不同结论：新记录标记 pending-human-review 并报告冲突", async () => {
    await store.promoteCandidate(buildCandidate());
    const conflicting = await store.promoteCandidate(
      buildCandidate({ decisionSummary: "相反的结论" }),
    );
    expect(conflicting.record.status).toBe("pending-human-review");
    expect(conflicting.conflictWithGlobalDecisionIdentifiers).toHaveLength(1);
  });

  it("替代关系只追加事件：旧记录保留且解析为 superseded", async () => {
    const original = await store.promoteCandidate(
      buildCandidate({ globalDecisionIdentifier: "gd-old" }),
    );
    await store.promoteCandidate(
      buildCandidate({
        decisionSummary: "修订结论",
        globalDecisionIdentifier: "gd-new",
        supersedesGlobalDecisionIdentifier: original.record.globalDecisionIdentifier,
      }),
    );
    expect(await store.resolveStatusById("gd-old")).toBe("superseded");
    const records = await store.listRecords();
    expect(records.map((record) => record.globalDecisionIdentifier).sort()).toEqual([
      "gd-new",
      "gd-old",
    ]);
  });

  it("只追加：重复 ID 提升与不存在记录的状态事件均拒绝", async () => {
    await store.promoteCandidate(buildCandidate({ globalDecisionIdentifier: "gd-fixed" }));
    await expect(
      store.promoteCandidate(
        buildCandidate({ globalDecisionIdentifier: "gd-fixed", decisionSummary: "覆盖尝试" }),
      ),
    ).rejects.toMatchObject({ errorCode: "global-decision-invalid" });
    await expect(
      store.appendStatusEvent({
        globalDecisionIdentifier: "gd-missing",
        eventType: "status-changed",
        nextStatus: "disputed",
        reason: "尝试",
      }),
    ).rejects.toMatchObject({ errorCode: "global-decision-not-found" });
  });

  it("损坏记录 fail-closed（journal-corrupted）", async () => {
    await store.promoteCandidate(buildCandidate({ globalDecisionIdentifier: "gd-corrupt" }));
    const filePath = path.join(
      temporaryDirectory,
      "global-decisions",
      "records",
      "gd-corrupt.json",
    );
    await fs.writeFile(filePath, "{ 损坏", "utf8");
    await expect(store.readRecord("gd-corrupt")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });

  it("token 估算确定且最小为 1", () => {
    expect(estimateGlobalDecisionTokenCount({ decisionSummary: "", keyRationale: "" })).toBe(1);
    expect(
      estimateGlobalDecisionTokenCount({ decisionSummary: "1234", keyRationale: "5678" }),
    ).toBe(2);
    expect(
      computeGlobalDecisionContentHash({
        decisionSummary: "a",
        keyRationale: "b",
        appliesToScope: "s",
      }),
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("全局决策相关选择与延后片段（T09A-03）", () => {
  it("仅按显式关系分类选择，且排除非 active 记录", () => {
    const relation = {
      taskIdentifier: "T-001",
      missionId: "mission-1",
      scopeKeys: ["scope-a"],
      requiredDecisionIdentifiers: ["gd-required"],
      relatedArtifactReferences: ["commit:abc"],
      relatedContextNodeIdentifiers: [],
      userPinnedGlobalDecisionIdentifiers: ["gd-pinned"],
    };
    const result = selectGlobalDecisionsForTask({
      relation,
      records: [
        asRecord({ globalDecisionIdentifier: "gd-scope", appliesToScope: "scope-a" }),
        asRecord({ globalDecisionIdentifier: "gd-required", appliesToScope: "scope-z" }),
        asRecord({
          globalDecisionIdentifier: "gd-artifact",
          appliesToScope: "scope-z",
          artifactOrCommitReferences: ["commit:abc"],
        }),
        asRecord({ globalDecisionIdentifier: "gd-pinned", appliesToScope: "scope-z" }),
        asRecord({ globalDecisionIdentifier: "gd-unrelated", appliesToScope: "scope-other" }),
        asRecord({
          globalDecisionIdentifier: "gd-pending",
          appliesToScope: "scope-a",
          status: "pending-human-review",
        }),
      ],
      maximumGlobalContextTokenCount: 10_000,
    });
    expect(result.selected.map((record) => record.globalDecisionIdentifier).sort()).toEqual([
      "gd-artifact",
      "gd-pinned",
      "gd-required",
      "gd-scope",
    ]);
    expect(result.selectionReasonsByIdentifier["gd-scope"]).toBe("current-task-constraint");
    expect(result.selectionReasonsByIdentifier["gd-required"]).toBe(
      "required-predecessor-decision",
    );
    expect(result.selectionReasonsByIdentifier["gd-artifact"]).toBe(
      "interface-or-artifact-contract",
    );
    expect(result.selectionReasonsByIdentifier["gd-pinned"]).toBe("user-pinned-relation");
  });

  it("预算不足：最高优先级记录不注入也不截断，并标记 budgetInsufficient", () => {
    const largeSummary = "x".repeat(400);
    const result = selectGlobalDecisionsForTask({
      relation: {
        taskIdentifier: "T-001",
        missionId: "mission-1",
        scopeKeys: ["scope-a"],
      },
      records: [
        asRecord({
          globalDecisionIdentifier: "gd-large",
          appliesToScope: "scope-a",
          decisionSummary: largeSummary,
          keyRationale: "r",
        }),
      ],
      maximumGlobalContextTokenCount: 5,
    });
    expect(result.selected).toHaveLength(0);
    expect(result.budgetInsufficient).toBe(true);
    expect(result.highestPriorityUnmetTokenCount).toBeGreaterThan(5);
    expect(result.unselectedRelatedDecisions[0]?.decisionSummary).toBe(largeSummary);
  });

  it("延后片段按 agentInstanceId 隔离落盘且 schema 合法", async () => {
    const decision = asRecord({ globalDecisionIdentifier: "gd-defer", appliesToScope: "scope-a" });
    const fragmentIdentifiers = await deferUnselectedGlobalDecisions({
      baseDirectory: temporaryDirectory,
      ownerAgentInstanceId: "agent-a",
      missionId: "mission-1",
      sourceContextNodeIdentifier: "node-1",
      sourceNodeRevision: 2,
      decisions: [decision],
    });
    expect(fragmentIdentifiers).toHaveLength(1);
    const fragmentFilePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-a",
      "deferred-context",
      fragmentIdentifiers[0] + ".json",
    );
    const parsed = deferredGlobalContextFragmentSchema.safeParse(
      JSON.parse(await fs.readFile(fragmentFilePath, "utf8")),
    );
    expect(parsed.success).toBe(true);
    await deferUnselectedGlobalDecisions({
      baseDirectory: temporaryDirectory,
      ownerAgentInstanceId: "agent-b",
      missionId: "mission-1",
      sourceContextNodeIdentifier: "node-1",
      sourceNodeRevision: 2,
      decisions: [decision],
    });
    await expect(
      fs.access(
        path.join(temporaryDirectory, "agent-memory", "agent-a", "deferred-context", fragmentIdentifiers[0] + ".json"),
      ),
    ).resolves.toBeUndefined();
    const agentBDirectoryEntries = await fs.readdir(
      path.join(temporaryDirectory, "agent-memory", "agent-b", "deferred-context"),
    );
    expect(agentBDirectoryEntries).toHaveLength(1);
  });
});
