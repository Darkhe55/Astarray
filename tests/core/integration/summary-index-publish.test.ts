/**
 * SUM-01-02 集成测试：增量索引受控保存与原子发布。
 *
 * 反例优先：中断发布产生"新摘要指旧正文"、清单被篡改仍返回、陈旧发布覆盖、
 * 崩溃后重复提取、并发重复生成、读取触发重摘要、跨 Agent 串档。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SummaryIndexStore } from "../../../packages/core/src/summarization/summary-index-store.js";
import { advanceSummaryGeneration } from "../../../packages/core/src/summarization/summary-generation-service.js";
import {
  extractSummaryFacts,
  type SummaryFact,
  type SummarySourceEntry,
} from "../../../packages/core/src/summarization/summary-fact-extractor.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-02-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function expectErrorCode(
  task: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    expect((error as { errorCode?: string }).errorCode).toBe(expectedCode);
    return;
  }
  throw new Error("未抛出预期错误: " + expectedCode);
}

function buildEntries(count: number): SummarySourceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceKind: "conversation" as const,
    sourceIdentifier: "session-sum-1",
    sourceRevision: index + 1,
    contentHash: "h" + (index + 1),
    entryType: "message" as const,
    text: "第 " + (index + 1) + " 条消息",
    recordedAtIso: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }));
}

function createGenerator(counter: { calls: number }, delayMilliseconds = 0) {
  return {
    async generateNarrative(input: {
      facts: SummaryFact[];
      pendingSourceRevisions: number[];
      previousNarrative: string | null;
    }): Promise<string> {
      counter.calls += 1;
      if (delayMilliseconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      }
      return "叙述：" + input.facts.length + " 条事实";
    },
  };
}

describe("SUM-01-02 摘要索引受控保存与原子发布", () => {
  it("首次生成：本地事实 + 后台叙述 + 原子发布 + pending 清理", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    const generatorCounter = { calls: 0 };
    const result = await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(3),
      narrativeGenerator: createGenerator(generatorCounter),
    });
    expect(result.publishedManifestRevision).toBe(4);
    const manifest = await store.readManifest({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    expect(manifest?.chunks).toHaveLength(3);
    expect(manifest?.narrativeText).toBe("叙述：3 条事实");
    expect(manifest?.coveredThroughSourceRevision).toBe(3);
    expect(await store.readPendingGeneration({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    })).toBeNull();
    expect(generatorCounter.calls).toBe(1);
  });

  it("中断发布：不产生新摘要，pending 可续跑且不重复提取", async () => {
    const extractorCalls = { count: 0 };
    const countingExtractor = (entries: SummarySourceEntry[]): SummaryFact[] => {
      extractorCalls.count += 1;
      return extractSummaryFacts(entries);
    };
    const failingStore = new SummaryIndexStore({
      baseDirectory: stateDirectory,
      manifestWriteHook: async () => {
        throw new Error("模拟发布中断");
      },
    });
    const generatorCounter = { calls: 0 };
    await expect(
      advanceSummaryGeneration({
        store: failingStore,
        agentInstanceId: "agent-sum-1",
        sourceKind: "conversation",
        sourceIdentifier: "session-sum-1",
        entries: buildEntries(3),
        narrativeGenerator: createGenerator(generatorCounter),
        factExtractor: countingExtractor,
      }),
    ).rejects.toThrow("模拟发布中断");

    // 未发布任何清单：不存在"新摘要指向旧正文"。
    await expect(
      failingStore.readManifest({
        agentInstanceId: "agent-sum-1",
        sourceKind: "conversation",
        sourceIdentifier: "session-sum-1",
      }),
    ).resolves.toBeNull();
    const pending = await failingStore.readPendingGeneration({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    expect(pending?.facts).toHaveLength(3);
    expect(pending?.draftNarrative).toBe("叙述：3 条事实");
    expect(extractorCalls.count).toBe(1);
    expect(generatorCounter.calls).toBe(1);

    // 续跑：复用已提取事实与已生成叙述，不再重复提取/生成。
    const recoveredStore = new SummaryIndexStore({ baseDirectory: stateDirectory });
    const resumed = await advanceSummaryGeneration({
      store: recoveredStore,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(3),
      narrativeGenerator: createGenerator(generatorCounter),
      factExtractor: countingExtractor,
    });
    expect(resumed.publishedManifestRevision).toBe(4);
    expect(extractorCalls.count).toBe(1);
    expect(generatorCounter.calls).toBe(1);
    const manifest = await recoveredStore.readManifest({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    expect(manifest?.chunks).toHaveLength(3);
    expect(manifest?.narrativeText).toBe("叙述：3 条事实");
  });

  it("清单被篡改：读取 fail-closed，绝不返回指向旧正文的摘要", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(2),
      narrativeGenerator: createGenerator({ calls: 0 }),
    });
    const manifestPath = path.join(
      stateDirectory,
      "agent-memory",
      "agent-sum-1",
      "summaries",
      "conversation-session-sum-1",
      "manifest.json",
    );
    const tampered = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      coveredThroughSourceRevision: number;
      chunks: Array<{ summaryText: string }>;
    };
    tampered.coveredThroughSourceRevision += 5;
    await fs.writeFile(manifestPath, JSON.stringify(tampered, null, 2), "utf8");
    await expectErrorCode(
      () =>
        store.readManifest({
          agentInstanceId: "agent-sum-1",
          sourceKind: "conversation",
          sourceIdentifier: "session-sum-1",
        }),
      "journal-corrupted",
    );

    // 只改正文（覆盖元数据不动）：完整性指纹必须发现。
    const manifestPath2 = manifestPath;
    const original = JSON.parse(await fs.readFile(manifestPath2, "utf8")) as {
      coveredThroughSourceRevision: number;
      chunks: Array<{ summaryText: string }>;
    };
    original.coveredThroughSourceRevision -= 5;
    original.chunks[0]!.summaryText = "被替换的旧正文";
    await fs.writeFile(manifestPath2, JSON.stringify(original, null, 2), "utf8");
    await expectErrorCode(
      () =>
        store.readManifest({
          agentInstanceId: "agent-sum-1",
          sourceKind: "conversation",
          sourceIdentifier: "session-sum-1",
        }),
      "journal-corrupted",
    );
  });

  it("陈旧发布被拒绝（CAS），不覆盖更新版本", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(1),
      narrativeGenerator: createGenerator({ calls: 0 }),
    });
    const manifest = await store.readManifest({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    expect(manifest).not.toBeNull();
    await expectErrorCode(
      () =>
        store.publishManifest({
          agentInstanceId: "agent-sum-1",
          sourceKind: "conversation",
          sourceIdentifier: "session-sum-1",
          manifest: {
            ...manifest!,
            manifestRevision: manifest!.manifestRevision + 1,
          },
          expectedRevision: manifest!.manifestRevision - 1,
        }),
      "stale-publish",
    );
  });

  it("single-flight：并发生成只执行一次叙述", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    const generatorCounter = { calls: 0 };
    const [first, second] = await Promise.all([
      advanceSummaryGeneration({
        store,
        agentInstanceId: "agent-sum-1",
        sourceKind: "conversation",
        sourceIdentifier: "session-sum-1",
        entries: buildEntries(2),
        narrativeGenerator: createGenerator(generatorCounter, 30),
      }),
      advanceSummaryGeneration({
        store,
        agentInstanceId: "agent-sum-1",
        sourceKind: "conversation",
        sourceIdentifier: "session-sum-1",
        entries: buildEntries(2),
        narrativeGenerator: createGenerator(generatorCounter, 30),
      }),
    ]);
    expect(generatorCounter.calls).toBe(1);
    expect(first.publishedManifestRevision).toBe(second.publishedManifestRevision);
  });

  it("读取失效检测不触发重摘要", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    const generatorCounter = { calls: 0 };
    let extractorCallCount = 0;
    await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(2),
      narrativeGenerator: createGenerator(generatorCounter),
      factExtractor: (entries) => {
        extractorCallCount += 1;
        return extractSummaryFacts(entries);
      },
    });
    const invalidation = await store.detectSourceInvalidation({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      observedSourceRevision: 5,
      observedContentHash: "h5",
    });
    expect(invalidation.isInvalidated).toBe(true);
    expect(invalidation.reason).toBe("source-advanced");
    expect(generatorCounter.calls).toBe(1);
    expect(extractorCallCount).toBe(1);

    const contentChanged = await store.detectSourceInvalidation({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      observedSourceRevision: 2,
      observedContentHash: "changed",
    });
    expect(contentChanged.reason).toBe("source-content-changed");
    expect(generatorCounter.calls).toBe(1);
  });

  it("跨 Agent 隔离：各 Agent 的摘要清单互不可见", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: buildEntries(1),
      narrativeGenerator: createGenerator({ calls: 0 }),
    });
    await expect(
      store.readManifest({
        agentInstanceId: "agent-sum-2",
        sourceKind: "conversation",
        sourceIdentifier: "session-sum-1",
      }),
    ).resolves.toBeNull();

    await advanceSummaryGeneration({
      store,
      agentInstanceId: "agent-sum-2",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
      entries: [
        {
          sourceKind: "conversation",
          sourceIdentifier: "session-sum-1",
          sourceRevision: 1,
          contentHash: "b1",
          entryType: "note",
          text: "另一个 Agent 的记录",
          recordedAtIso: new Date(2026, 0, 1).toISOString(),
        },
      ],
      narrativeGenerator: createGenerator({ calls: 0 }),
    });
    const first = await store.readManifest({
      agentInstanceId: "agent-sum-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    const second = await store.readManifest({
      agentInstanceId: "agent-sum-2",
      sourceKind: "conversation",
      sourceIdentifier: "session-sum-1",
    });
    expect(first?.chunks[0]?.summaryText).toBe("第 1 条消息");
    expect(second?.chunks[0]?.summaryText).toBe("另一个 Agent 的记录");
  });
});
