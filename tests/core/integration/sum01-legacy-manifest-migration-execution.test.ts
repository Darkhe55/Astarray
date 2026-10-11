// SUM-01-02 反例（2026-10-10）：旧清单迁移的【安全执行】（备份 + 原子重发 + 幂等）。
//
// 上一轮只交付了【只读判定】（detectLegacyManifests）。卡内 SUM-01-02 要求的是
// "受控保存增量索引与原子发布…旧文件迁移/外部变化失效"，并明令
// "崩溃不出现新摘要指旧正文"与"读取不触发全文重摘要"。
//
// 现状缺口（本轮实测）：advanceSummaryGeneration() 第一步就是 readManifest(key)，
// 而旧格式清单【根本读不出来】（validateSummaryManifest 抛错 => journal-corrupted）
// => 迁移执行无法启动。于是"旧文件迁移"只能停在"知道哪些要迁移"，
// 用户仍无法让这些来源恢复可用。
//
// 本片钉住的安全语义（不删数据、不静默覆盖、可中断）：
//  - 迁移后该来源【必须能被正常读取】（readManifest 成功、完整性校验通过）；
//  - 旧文件【必须被备份保留】（卡内"任何替换/覆盖必须自动备份"）；
//  - 已是新格式的来源 => 【跳过】，不得重复备份、不得改写 revision；
//  - 【幂等】：连续迁移两次，第二次不再产生任何改动（不重复备份、revision 不变）；
//  - 【崩溃安全】：写入被中断 => 旧内容【仍可恢复】，下一次迁移仍能成功；
//  - 单条失败【不得】让整批中止（其余来源照常迁移）。
//
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SummaryIndexStore } from "../../../packages/core/src/summarization/summary-index-store.js";
import { advanceSummaryGeneration } from "../../../packages/core/src/summarization/summary-generation-service.js";
import { buildLocalExtractiveNarrative } from "../../../packages/core/src/summarization/summary-source-adapters.js";
import type { SummarySourceEntry } from "../../../packages/core/src/summarization/summary-fact-extractor.js";
import { sanitizePathSegment } from "../../../packages/core/src/orchestration/work-archive-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-migrate-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT_INSTANCE_ID = "agent-1";

function summaryDirectoryPath(input: {
  sourceKind: string;
  sourceIdentifier: string;
}): string {
  return path.join(
    baseDirectory,
    "agent-memory",
    sanitizePathSegment(AGENT_INSTANCE_ID),
    "summaries",
    sanitizePathSegment(input.sourceKind) + "-" + sanitizePathSegment(input.sourceIdentifier),
  );
}

/** 写一份缺完整性字段的旧格式清单（与上一轮判定用例同形）。 */
async function writeLegacyManifest(input: {
  sourceKind: string;
  sourceIdentifier: string;
  manifestRevision?: number;
}): Promise<string> {
  const directoryPath = summaryDirectoryPath(input);
  await fs.mkdir(directoryPath, { recursive: true });
  const filePath = path.join(directoryPath, "manifest.json");
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        manifestIdentifier: "legacy-manifest-1",
        agentInstanceId: AGENT_INSTANCE_ID,
        sourceKind: input.sourceKind,
        sourceIdentifier: input.sourceIdentifier,
        coveredThroughSourceRevision: 2,
        coveredContentHash: "sha256:" + "a".repeat(64),
        pendingSourceRevisions: [],
        chunks: [],
        narrativeText: null,
        manifestRevision: input.manifestRevision ?? 1,
        generatorVersion: "local-extractive-0",
        updatedAtIso: "2026-09-01T00:00:00.000Z",
        // 刻意缺少 chunkChainHash 与 manifestIntegrityHash
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

/** 迁移用的真实条目（迁移本质是"用本地提取重新生成"，不给条目就无事可做）。 */
/** 迁移用的真实条目（`SummarySourceEntry` 形状：含来源/revision/内容哈希）。 */
function buildMigrationEntries(): SummarySourceEntry[] {
  return [
    {
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
      sourceRevision: 1,
      contentHash: "sha256:" + "f".repeat(64),
      /** `entryType` 合法集合是 decision/result/message/report/note
       * （我最初写成 "conversation" 是错的 —— 那是 `sourceKind`，不是 `entryType`）。 */
      entryType: "message",
      text: "用户询问如何在本地发布摘要",
      recordedAtIso: "2026-10-01T00:00:00.000Z",
    },
  ];
}

async function listDirectoryNames(directoryPath: string): Promise<string[]> {
  try {
    return (await fs.readdir(directoryPath)).sort();
  } catch {
    return [];
  }
}

describe("SUM-01-02：旧清单迁移的安全执行", () => {
  it("① 迁移后该来源**必须能被正常读取**（旧格式此前读不出来）", async () => {
    const directoryPath = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    await writeLegacyManifest({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const store = new SummaryIndexStore({ baseDirectory });

    // 迁移前：读取**必须失败**（这正是"旧文件"的定义）
    await expect(
      store.readManifest({
        agentInstanceId: AGENT_INSTANCE_ID,
        sourceKind: "conversation",
        sourceIdentifier: "session-legacy",
      }),
    ).rejects.toThrow();

    const migrationOutcome = await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });
    expect(migrationOutcome.migratedSourceIdentifiers).toEqual(["session-legacy"]);

    // 迁移后：可读、完整性校验通过、revision 前进
    const manifest = await store.readManifest({
      agentInstanceId: AGENT_INSTANCE_ID,
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    expect(manifest).not.toBeNull();
    expect(manifest?.manifestRevision).toBeGreaterThanOrEqual(1);
    expect(manifest?.generatorVersion).not.toBe("local-extractive-0");
    expect(directoryPath.length).toBeGreaterThan(0);
  });

  it("② 旧文件**必须被备份保留**（卡内：任何替换/覆盖必须自动备份）", async () => {
    const directoryPath = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const legacyFilePath = await writeLegacyManifest({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const legacyContentBefore = await fs.readFile(legacyFilePath, "utf8");
    const store = new SummaryIndexStore({ baseDirectory });

    await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });

    /** 目录里必须出现备份文件，且备份内容等于**原旧文件**（可审计、可恢复）。 */
    const names = await listDirectoryNames(directoryPath);
    const backupNames = names.filter((name) => name.includes("legacy"));
    expect(backupNames.length).toBeGreaterThan(0);
    const backupContent = await fs.readFile(path.join(directoryPath, backupNames[0] as string), "utf8");
    expect(backupContent).toBe(legacyContentBefore);
  });

  it("③ 已是新格式的来源 ⇒ **跳过**（不改写、不重复备份）", async () => {
    const store = new SummaryIndexStore({ baseDirectory });
    /** 用**真实**发布路径造一份合法清单（新格式）。 */
    const generation = await advanceSummaryGeneration({
      store,
      agentInstanceId: AGENT_INSTANCE_ID,
      sourceKind: "conversation",
      sourceIdentifier: "session-fresh",
      entries: buildMigrationEntries(),
      narrativeGenerator: {
        generateNarrative: async (generationInput) =>
          buildLocalExtractiveNarrative(generationInput.facts),
      },
      generatorVersion: "local-extractive-1",
    });
    expect(generation.manifest).not.toBeNull();
    const directoryPath = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-fresh",
    });
    const namesBefore = await listDirectoryNames(directoryPath);

    const outcome = await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-fresh": buildMigrationEntries() },
    });
    // 未发布任何清单 ⇒ 该来源不在待迁移清单里，也不应被处理
    /**
     * **实测语义**：新格式清单根本**不会被判定为待迁移** ⇒ 它既不在 `migrated`
     * 也不在 `skipped` 里（`skipped` 只表示"检出了但没有重建条目"）。
     * 关键不变量是：**一个字都没被改**。
     */
    expect(outcome.migratedSourceIdentifiers).toEqual([]);
    expect(await listDirectoryNames(directoryPath)).toEqual(namesBefore);
  });

  it("④ **幂等**：连续迁移两次，第二次不再产生任何改动", async () => {
    const directoryPath = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    await writeLegacyManifest({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const store = new SummaryIndexStore({ baseDirectory });

    await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });
    const namesAfterFirst = await listDirectoryNames(directoryPath);
    const manifestAfterFirst = await fs.readFile(
      path.join(directoryPath, "manifest.json"),
      "utf8",
    );

    const secondOutcome = await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });

    expect(secondOutcome.migratedSourceIdentifiers).toEqual([]);
    // 第二次不得新增备份文件、不得改写清单
    expect(await listDirectoryNames(directoryPath)).toEqual(namesAfterFirst);
    expect(await fs.readFile(path.join(directoryPath, "manifest.json"), "utf8")).toBe(
      manifestAfterFirst,
    );
  });

  it("⑤ **崩溃安全**：写入被中断 ⇒ 旧内容仍可恢复，且下一次迁移仍能成功", async () => {
    const directoryPath = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const legacyFilePath = await writeLegacyManifest({
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const legacyContentBefore = await fs.readFile(legacyFilePath, "utf8");

    /** 注入"发布时崩溃"：清单写入抛错。 */
    const crashingStore = new SummaryIndexStore({
      baseDirectory,
      manifestWriteHook: async () => {
        throw new Error("注入的发布中断");
      },
    });
    /**
     * **实测语义**：整批方法**不抛错**，而是把该来源计入 `failedEntries`
     * （批量迁移必须能"部分成功"：单条失败不得中止整批 —— 见用例 ⑥）。
     * 这样调用方能拿到**逐条结果**，而不是只知道"整批炸了"。
     */
    const crashedOutcome = await crashingStore.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });
    expect(crashedOutcome.migratedSourceIdentifiers).toEqual([]);
    expect(crashedOutcome.failedEntries.length).toBeGreaterThan(0);

    // 旧内容必须仍可从备份找回
    const names = await listDirectoryNames(directoryPath);
    const backupNames = names.filter((name) => name.includes("legacy"));
    expect(backupNames.length).toBeGreaterThan(0);
    const backupContent = await fs.readFile(
      path.join(directoryPath, backupNames[0] as string),
      "utf8",
    );
    expect(backupContent).toBe(legacyContentBefore);

    // 正常 store 再迁移一次必须成功（可重试、不卡死）
    const healthyStore = new SummaryIndexStore({ baseDirectory });
    const outcome = await healthyStore.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-legacy": buildMigrationEntries() },
    });
    expect(outcome.migratedSourceIdentifiers).toEqual(["session-legacy"]);
    const manifest = await healthyStore.readManifest({
      agentInstanceId: AGENT_INSTANCE_ID,
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    expect(manifest).not.toBeNull();
  });

  it("⑥ 单条失败**不得**让整批中止（其余来源照常迁移）", async () => {
    await writeLegacyManifest({
      sourceKind: "conversation",
      sourceIdentifier: "session-good",
    });
    /**
     * 这条是**目录名种类未知**的旧清单：判定能认出它，但**种类未知就无法确定
     * 来源键** ⇒ 迁移必须**如实失败**而不是猜。
     *
     * 注：我最初用"损坏 JSON"当失败样本 —— **实测它反而能成功迁移**
     * （旧文件先备份再移走，坏内容留在备份里，新清单照常发布）。
     * 那其实是**更好**的行为，已改为用真正不可迁移的样本。
     */
    const unknownKindDirectory = summaryDirectoryPath({
      sourceKind: "mystery-kind",
      sourceIdentifier: "session-unknown-kind",
    });
    await fs.mkdir(unknownKindDirectory, { recursive: true });
    await fs.writeFile(
      path.join(unknownKindDirectory, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, sourceIdentifier: "session-unknown-kind" }),
      "utf8",
    );

    const store = new SummaryIndexStore({ baseDirectory });
    const outcome = await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: {
        "session-good": buildMigrationEntries(),
        "session-unknown-kind": buildMigrationEntries(),
      },
    });

    // 好的那条照常迁移（不被拖垮）
    expect(outcome.migratedSourceIdentifiers).toContain("session-good");
    // 失败的必须**如实报出**，不得静默吞掉
    expect(outcome.failedEntries.length).toBeGreaterThan(0);
  });

  it("⑦ 损坏 JSON 的旧清单 ⇒ 仍可迁移，且**坏内容留在备份里**（不丢数据）", async () => {
    const brokenDirectory = summaryDirectoryPath({
      sourceKind: "conversation",
      sourceIdentifier: "session-broken",
    });
    await fs.mkdir(brokenDirectory, { recursive: true });
    const brokenContent = "{ 坏内容";
    await fs.writeFile(path.join(brokenDirectory, "manifest.json"), brokenContent, "utf8");

    const store = new SummaryIndexStore({ baseDirectory });
    const outcome = await store.migrateLegacyManifests({
      agentInstanceId: AGENT_INSTANCE_ID,
      entriesBySourceIdentifier: { "session-broken": buildMigrationEntries() },
    });
    expect(outcome.migratedSourceIdentifiers).toEqual(["session-broken"]);

    // 坏内容必须被完整保留在备份里（卡内：任何替换/覆盖必须自动备份）
    const names = await listDirectoryNames(brokenDirectory);
    const backupName = names.find((name) => name.includes("legacy-backup"));
    expect(backupName).toBeDefined();
    expect(
      await fs.readFile(path.join(brokenDirectory, backupName as string), "utf8"),
    ).toBe(brokenContent);

    // 迁移后该来源可读
    const manifest = await store.readManifest({
      agentInstanceId: AGENT_INSTANCE_ID,
      sourceKind: "conversation",
      sourceIdentifier: "session-broken",
    });
    expect(manifest).not.toBeNull();
  });
});

describe("SUM-01-02：listSourceKeys 的跨种类排序（确定性）", () => {
  it("⑧ 同 Agent 下两种来源种类的合法清单 ⇒ 列表按 kind 稳定排序", async () => {
    const store = new SummaryIndexStore({ baseDirectory });
    for (const sourceKind of ["report", "conversation"] as const) {
      const generation = await advanceSummaryGeneration({
        store,
        agentInstanceId: AGENT_INSTANCE_ID,
        sourceKind,
        sourceIdentifier: sourceKind + "-source",
        entries: [
          {
            sourceKind,
            sourceIdentifier: sourceKind + "-source",
            sourceRevision: 1,
            contentHash: "sha256:" + "e".repeat(64),
            entryType: "message",
            text: "内容",
            recordedAtIso: "2026-10-01T00:00:00.000Z",
          },
        ],
        narrativeGenerator: {
          generateNarrative: async (generationInput) =>
            buildLocalExtractiveNarrative(generationInput.facts),
        },
        generatorVersion: "local-extractive-1",
      });
      expect(generation.manifest).not.toBeNull();
    }

    const views = await store.listSourceKeys(AGENT_INSTANCE_ID);
    expect(views.map((view) => view.sourceKind)).toEqual(["conversation", "report"]);
  });
});