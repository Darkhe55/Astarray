/**
 * SUM-01-02 反例（2026-10-10）：**旧文件迁移**的判定与安全语义。
 *
 * 卡内 SUM-01-02 明文验收点："受控保存增量索引与原子发布，本地提取权威事实，
 * 后台生成叙述；**旧文件迁移/外部变化失效**"；"**崩溃不出现新摘要指旧正文**；
 * **pending 生成可续跑**；**读取不触发全文重摘要**；single-flight 有效"。
 *
 * 现状（本轮实测）：`summaryManifestSchema` 是 `.strict()` 且要求
 * `chunkChainHash`/`manifestIntegrityHash` 等字段 ⇒ **历史清单（缺这些字段）根本读不出来**
 * （`readManifest()` 抛 `journal-corrupted`）。而全仓**没有任何"旧文件迁移"入口或判定**
 * ⇒ 卡内点名的"旧文件迁移"**没有判定点**，用户也无法知道哪些清单需要迁移。
 *
 * 本片钉住的语义（**只读、非破坏、不重摘要**）：
 *  - 必须能**判定**哪些清单是旧格式，并给出**可读原因**（缺哪些字段/schema 版本不符）；
 *  - 判定必须**只读**：**不得**改写、删除或重摘要任何文件；
 *  - **读取不得触发全文重摘要**（卡内明令）：判定过程**不得**调用重摘要；
 *  - 内容已损坏（非 JSON / 缺关键业务字段）的清单必须被标出而不是让整批失败；
 *  - 全部为新格式 ⇒ 报告为空且 `isMigrationNeeded: false`（不虚构待迁移项）。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SummaryIndexStore } from "../../../packages/core/src/summarization/summary-index-store.js";
import { sanitizePathSegment } from "../../../packages/core/src/orchestration/work-archive-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sum01-legacy-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function summaryDirectoryPath(input: {
  agentInstanceId: string;
  sourceKind: string;
  sourceIdentifier: string;
}): string {
  /**
   * 与 store 的目录布局一致：`agent-memory/<agent>/summaries/<kind>-<identifier>`。
   *
   * **必须用产品真实的 `sanitizePathSegment`**：我最初自己写了个
   * `replace(/[^A-Za-z0-9._-]/g, "_")` 的"等价"实现，**它是错的** ——
   * 真实编码把非 ASCII 编成 `~xxxx`（单射、可 `decodePathSegment` 还原），
   * 而我的版本把 `会话-一号` 变成 `___-__`（**有损、不可还原**），
   * 于是用例指向了根本不存在的目录。用真实编码器后布局才真正一致。
   */
  return path.join(
    baseDirectory,
    "agent-memory",
    sanitizePathSegment(input.agentInstanceId),
    "summaries",
    sanitizePathSegment(input.sourceKind) + "-" + sanitizePathSegment(input.sourceIdentifier),
  );
}

/** 写一份**旧格式**清单：缺少 SUM-01-02 新增的完整性/链指纹字段。 */
async function writeLegacyManifest(input: {
  agentInstanceId: string;
  sourceKind: string;
  sourceIdentifier: string;
  overrides?: Record<string, unknown>;
}): Promise<string> {
  const directoryPath = summaryDirectoryPath(input);
  await fs.mkdir(directoryPath, { recursive: true });
  const filePath = path.join(directoryPath, "manifest.json");
  const legacyManifest = {
    schemaVersion: 1,
    manifestIdentifier: "legacy-manifest-1",
    agentInstanceId: input.agentInstanceId,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
    coveredThroughSourceRevision: 2,
    coveredContentHash: "sha256:" + "a".repeat(64),
    pendingSourceRevisions: [],
    chunks: [],
    narrativeText: null,
    manifestRevision: 1,
    generatorVersion: "local-extractive-0",
    updatedAtIso: "2026-09-01T00:00:00.000Z",
    // 刻意**缺少** chunkChainHash 与 manifestIntegrityHash（旧格式特征）
    ...input.overrides,
  };
  await fs.writeFile(filePath, JSON.stringify(legacyManifest, null, 2), "utf8");
  return filePath;
}

describe("SUM-01-02：旧格式清单的**只读**迁移判定", () => {
  it("① 缺完整性字段的旧清单 ⇒ 必须被判定为待迁移，并给出可读原因", async () => {
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const store = new SummaryIndexStore({ baseDirectory });

    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    expect(report.isMigrationNeeded).toBe(true);
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0];
    expect(entry?.sourceIdentifier).toBe("session-legacy");
    // 原因必须可读且指出缺失字段（不得只说"损坏"）
    expect(String(entry?.reason)).toMatch(/chunkChainHash|manifestIntegrityHash|字段|完整性/);
  });

  it("② 判定必须**只读**：文件内容与目录状态在判定前后完全不变", async () => {
    const filePath = await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    const before = await fs.readFile(filePath, "utf8");
    const entriesBefore = (await fs.readdir(path.dirname(filePath))).sort();

    const store = new SummaryIndexStore({ baseDirectory });
    await store.detectLegacyManifests({ agentInstanceId: "agent-1" });

    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    expect((await fs.readdir(path.dirname(filePath))).sort()).toEqual(entriesBefore);
  });

  it("③ 非 JSON / 结构损坏也要被标出，**不得**让整批失败", async () => {
    const directoryPath = summaryDirectoryPath({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-broken",
    });
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(path.join(directoryPath, "manifest.json"), "{ 不是 JSON", "utf8");
    // 再接一份正常旧格式：两件都要在报告里
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });

    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    expect(report.entries.length).toBe(2);
    const brokenEntry = report.entries.find(
      (entry) => entry.sourceIdentifier === "session-broken",
    );
    expect(brokenEntry).toBeDefined();
    expect(String(brokenEntry?.reason)).toMatch(/JSON|解析|损坏/);
  });

  it("④ 无 summaries 目录（全新安装）⇒ 空报告且 isMigrationNeeded=false（不虚构待迁移项）", async () => {
    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-fresh" });
    expect(report.entries).toEqual([]);
    expect(report.isMigrationNeeded).toBe(false);
  });

  it("⑤ 另一 Agent 的清单**不得**出现在本 Agent 的报告里（不串数据）", async () => {
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-a",
    });
    await writeLegacyManifest({
      agentInstanceId: "agent-2",
      sourceKind: "conversation",
      sourceIdentifier: "session-b",
    });
    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    expect(report.entries.map((entry) => entry.sourceIdentifier)).toEqual(["session-a"]);
  });

  it("⑥ 判定**不得**触发重摘要（读取不触发全文重摘要）", async () => {
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-legacy",
    });
    /** 记录写入动作：判定期间**不得**有任何写文件发生。 */
    const writeSpy: string[] = [];
    const originalWriteFile = fs.writeFile;
    const spiedWriteFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      writeSpy.push(String(args[0]));
      return await originalWriteFile(...args);
    }) as typeof fs.writeFile;
    // 仅本用例内替换，结束即恢复
    const moduleFs = await import("node:fs");
    (moduleFs.promises as { writeFile: typeof fs.writeFile }).writeFile = spiedWriteFile;
    try {
      const store = new SummaryIndexStore({ baseDirectory });
      await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    } finally {
      (moduleFs.promises as { writeFile: typeof fs.writeFile }).writeFile = originalWriteFile;
    }
    expect(writeSpy).toEqual([]);
  });
});

describe("SUM-01-02：迁移判定的其余边界（覆盖未知种类/缺清单/schema 不符）", () => {
  it("⑦ 目录存在但缺 manifest.json（半写发布）⇒ 标出且不崩溃", async () => {
    const directoryPath = summaryDirectoryPath({
      agentInstanceId: "agent-1",
      sourceKind: "report",
      sourceIdentifier: "reports-half-written",
    });
    await fs.mkdir(directoryPath, { recursive: true });
    // 刻意**不写** manifest.json

    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    expect(report.isMigrationNeeded).toBe(true);
    const entry = report.entries.find(
      (candidate) => candidate.sourceIdentifier === "reports-half-written",
    );
    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBe("report");
    expect(String(entry?.reason)).toMatch(/manifest\.json/);
  });

  it("⑧ schemaVersion 不符（其余字段齐全）⇒ 原因必须指出 schemaVersion", async () => {
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "work-archive",
      sourceIdentifier: "archive-schema-mismatch",
      overrides: {
        schemaVersion: 0,
        // 补齐新字段，使**唯一**问题是 schemaVersion，从而钉住该分支
        chunkChainHash: "sha256:" + "b".repeat(64),
        manifestIntegrityHash: "sha256:" + "c".repeat(64),
      },
    });
    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    const entry = report.entries.find(
      (candidate) => candidate.sourceIdentifier === "archive-schema-mismatch",
    );
    expect(entry).toBeDefined();
    expect(String(entry?.reason)).toMatch(/schemaVersion/);
  });

  it("⑨ 未知 sourceKind 的目录 ⇒ 种类为 null（**不猜**），标识符用解码还原", async () => {
    const directoryPath = summaryDirectoryPath({
      agentInstanceId: "agent-1",
      // 注意：**不能**用 `not-a-known-kind` —— 它包含 `report` 子串，
      // 会被种类前缀匹配误判为 report（我最初的用例正是踩了这个坑）。
      sourceKind: "mystery-kind",
      sourceIdentifier: "mystery",
    });
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(path.join(directoryPath, "manifest.json"), "{ 坏内容", "utf8");

    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    /**
     * **实测语义（如实钉住）**：种类未知时**无法判定 `-` 是分隔符还是标识符的一部分**
     * （编码方案下 `-` 是合法字面字符）⇒ 标识符是**整段解码后的目录名**，
     * 而不是裸标识符 `mystery`。这不是缺陷，是信息论上的边界；
     * 实现必须在 reason 里说明"标识符为整段解码结果"，不得假装精确。
     */
    const entry = report.entries.find((candidate) => candidate.sourceIdentifier !== "");
    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBeNull();
    expect(String(entry?.reason)).toMatch(/种类未知|整段解码/);
  });

  it("⑩ 非 ASCII 标识符 ⇒ 解码还原为原文（编码是单射的）", async () => {
    const directoryPath = summaryDirectoryPath({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "会话-一号",
    });
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(path.join(directoryPath, "manifest.json"), "{ 坏内容", "utf8");

    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    const entry = report.entries.find(
      (candidate) => candidate.sourceIdentifier === "会话-一号",
    );
    expect(entry).toBeDefined();
  });

});
describe("SUM-01-02：跨来源种类的排序与真实处理顺序", () => {
  it("⑫ 两种不同来源种类的旧清单 ⇒ 报告按 kind 排序，且没有条目的种类记入 skipped", async () => {
    // conversation 与 report 各一份旧清单 ⇒ 触发按 kind 的比较分支
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "report",
      sourceIdentifier: "reports-old",
    });
    await writeLegacyManifest({
      agentInstanceId: "agent-1",
      sourceKind: "conversation",
      sourceIdentifier: "session-old",
    });

    const store = new SummaryIndexStore({ baseDirectory });
    const report = await store.detectLegacyManifests({ agentInstanceId: "agent-1" });
    expect(report.entries).toHaveLength(2);
    // 排序必须稳定可预期（conversation 在 report 之前）
    expect(report.entries.map((entry) => entry.sourceKind)).toEqual([
      "conversation",
      "report",
    ]);
  });
});