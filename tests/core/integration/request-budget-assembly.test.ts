/**
 * SUM-02-02：完整请求计量与包装/输出预留的行为反例（只分页不裁剪、必要约束 blocked、模型切换重新计量）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SummaryIndexStore } from "../../../packages/core/src/summarization/summary-index-store.js";
import { advanceSummaryGeneration } from "../../../packages/core/src/summarization/summary-generation-service.js";
import {
  assembleRequestBudget,
  buildMeasurementTargetKey,
  isMeasurementReusableForTarget,
  remeasureRecordsForTarget,
  type RequestBudgetRecord,
  type RequestMeasurementTarget,
} from "../../../packages/core/src/measurement/request-budget.js";
import {
  TokenMeasurementService,
  type TokenMeasurement,
} from "../../../packages/core/src/measurement/token-measurement.js";

const SERIALIZATION_VERSION = 1;
let stateDirectory = "";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-sum02-02-"),
  );
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function buildRecords(
  input: {
    count: number;
    textLength: number;
    target?: RequestMeasurementTarget;
    priorityTier?: (index: number) => number;
    mandatoryIdentifiers?: string[];
  },
): Promise<{ records: RequestBudgetRecord[]; service: TokenMeasurementService }> {
  const service = new TokenMeasurementService(() => "2026-09-15T00:00:00.000Z");
  const target: RequestMeasurementTarget = input.target ?? {
    providerIdentifier: null,
    modelIdentifier: null,
    serializationVersion: SERIALIZATION_VERSION,
  };
  const records: RequestBudgetRecord[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const recordIdentifier = "record-" + String(index).padStart(3, "0");
    const text = "第 " + String(index) + " 条完整记录 " + "字".repeat(input.textLength);
    const measurement = await service.measureTokenCount({
      text,
      providerIdentifier: target.providerIdentifier,
      modelIdentifier: target.modelIdentifier,
      tokenizerIdentifier: target.tokenizerIdentifier ?? null,
      tokenizerVersion: target.tokenizerVersion ?? null,
      serializationVersion: target.serializationVersion,
    });
    records.push({
      recordIdentifier,
      priorityTier: input.priorityTier?.(index) ?? 0,
      text,
      isMandatory: (input.mandatoryIdentifiers ?? []).includes(recordIdentifier),
      measurement,
    });
  }
  return { records, service };
}

describe("SUM-02-02 请求预算装配", () => {
  it("超预算时只分页：选入+分页无重无漏，正文不被截断", async () => {
    const { records } = await buildRecords({ count: 20, textLength: 200 });
    const recordsSnapshot = JSON.stringify(records);

    const result = assembleRequestBudget({
      configuredGlobalContextTokenCount: 4096,
      reservedOutputTokenCount: 512,
      reservedPackagingTokenCount: 64,
      records,
      pageSize: 3,
    });

    expect(result.status).toBe("requires-pagination");
    expect(result.effectiveBudgetTokenCount).toBe(4096 - 512 - 64);
    expect(result.selectedRecordIdentifiers.length).toBeGreaterThan(0);
    expect(result.selectedRecordIdentifiers.length).toBeLessThan(20);
    // 无重无漏：选入 ∪ 分页 = 全部记录。
    const paged = result.pagedRecordIdentifiers.flat();
    const union = [...result.selectedRecordIdentifiers, ...paged].sort();
    expect(union).toEqual(records.map((record) => record.recordIdentifier).sort());
    expect(new Set(union).size).toBe(union.length);
    // 分页保留完整记录（页大小生效）。
    expect(result.pagedRecordIdentifiers[0]?.length).toBeLessThanOrEqual(3);
    // 输入记录未被修改（不裁剪存档/清单）。
    expect(JSON.stringify(records)).toBe(recordsSnapshot);
    const selectedRecord = records.find(
      (record) => record.recordIdentifier === result.selectedRecordIdentifiers[0],
    );
    expect(selectedRecord?.text).toContain("第 0 条完整记录");
    expect(selectedRecord?.text).toHaveLength(
      ("第 0 条完整记录 " + "字".repeat(200)).length,
    );
  });

  it("必要约束放不下时 blocked，不静默丢弃也不降级", async () => {
    const { records } = await buildRecords({
      count: 3,
      textLength: 4000,
      mandatoryIdentifiers: ["record-000"],
    });
    const result = assembleRequestBudget({
      configuredGlobalContextTokenCount: 512,
      reservedOutputTokenCount: 128,
      reservedPackagingTokenCount: 0,
      records,
    });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("mandatory-context-exceeds-budget");
    expect(result.selectedRecordIdentifiers).toEqual([]);
    expect(result.notes[0]).toContain("mandatory=");
  });

  it("全局预算可调：配置越大选入越多（4096 规则未被绕过）", async () => {
    const { records } = await buildRecords({ count: 60, textLength: 200 });
    const baseInput = {
      reservedOutputTokenCount: 256,
      reservedPackagingTokenCount: 64,
      records,
    };
    const small = assembleRequestBudget({
      ...baseInput,
      configuredGlobalContextTokenCount: 4096,
    });
    const large = assembleRequestBudget({
      ...baseInput,
      configuredGlobalContextTokenCount: 8192,
    });
    expect(small.effectiveBudgetTokenCount).toBe(4096 - 320);
    expect(large.effectiveBudgetTokenCount).toBe(8192 - 320);
    expect(large.selectedRecordIdentifiers.length).toBeGreaterThan(
      small.selectedRecordIdentifiers.length,
    );
    // 总记录数不因预算变化而丢失。
    expect(
      small.selectedRecordIdentifiers.length +
        small.pagedRecordIdentifiers.flat().length,
    ).toBe(60);
    expect(
      large.selectedRecordIdentifiers.length +
        large.pagedRecordIdentifiers.flat().length,
    ).toBe(60);
  });

  it("优先级与稳定顺序：层级 0 优先，同级按标识排序", async () => {
    const { records } = await buildRecords({
      count: 12,
      textLength: 200,
      priorityTier: (index) => (index < 3 ? 2 : index < 6 ? 1 : 0),
    });
    const result = assembleRequestBudget({
      configuredGlobalContextTokenCount: 1024,
      reservedOutputTokenCount: 64,
      reservedPackagingTokenCount: 0,
      records,
    });
    const selected = result.selectedRecordIdentifiers;
    expect(selected.length).toBeGreaterThan(0);
    // 被选中的一定来自更高优先级（层级值更小）的记录集合。
    const tierByIdentifier = new Map(
      records.map((record) => [record.recordIdentifier, record.priorityTier]),
    );
    const lowestSelectedTier = Math.max(
      ...selected.map((identifier) => tierByIdentifier.get(identifier) ?? 99),
    );
    const notSelectedHigherTier = result.pagedRecordIdentifiers
      .flat()
      .filter(
        (identifier) =>
          (tierByIdentifier.get(identifier) ?? 99) < lowestSelectedTier,
      );
    expect(notSelectedHigherTier).toEqual([]);
    expect([...selected].sort()).toEqual(selected);
  });

  it("模型切换重新计量，同目标同版本才复用", async () => {
    const localTarget: RequestMeasurementTarget = {
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenizerIdentifier: "tokenizer-a",
      tokenizerVersion: "1.0.0",
      serializationVersion: SERIALIZATION_VERSION,
    };
    const { records, service } = await buildRecords({
      count: 4,
      textLength: 60,
      target: {
        providerIdentifier: null,
        modelIdentifier: null,
        serializationVersion: SERIALIZATION_VERSION,
      },
    });
    service.registerLocalAdapter({
      adapterKind: "local",
      adapterIdentifier: "local-tokenizer-a",
      providerIdentifier: "provider-a",
      modelIdentifier: "model-a",
      tokenizerIdentifier: "tokenizer-a",
      tokenizerVersion: "1.0.0",
      measureTokenCount: async (text: string) => Math.ceil(text.length / 2),
    });

    const switched = await remeasureRecordsForTarget({
      records,
      target: localTarget,
      measurementService: service,
    });
    expect(switched.remeasuredRecordCount).toBe(4);
    expect(switched.reusedRecordCount).toBe(0);
    expect(switched.targetKey).toBe(buildMeasurementTargetKey(localTarget));
    for (const record of switched.records) {
      expect(record.measurement.measurementSourceKind).toBe("local-tokenizer");
      expect(
        isMeasurementReusableForTarget(record.measurement, localTarget),
      ).toBe(true);
    }
    // 同目标再次计量 → 全部复用。
    const reused = await remeasureRecordsForTarget({
      records: switched.records,
      target: localTarget,
      measurementService: service,
    });
    expect(reused.remeasuredRecordCount).toBe(0);
    expect(reused.reusedRecordCount).toBe(4);
    // 切换回未知模型（保守估算）→ 重新计量且来源不同。
    const unknownTarget: RequestMeasurementTarget = {
      providerIdentifier: "provider-b",
      modelIdentifier: "model-b",
      serializationVersion: SERIALIZATION_VERSION,
    };
    const reestimate = await remeasureRecordsForTarget({
      records: switched.records,
      target: unknownTarget,
      measurementService: service,
    });
    expect(reestimate.remeasuredRecordCount).toBe(4);
    expect(reestimate.records[0]?.measurement.measurementSourceKind).toBe(
      "conservative-estimate",
    );
    // 正文原样保留（只换计量）。
    expect(reestimate.records[0]?.text).toBe(records[0]?.text);
  });

  it("装配不改动已发布摘要清单（存档不被裁剪，仅分页）", async () => {
    const store = new SummaryIndexStore({ baseDirectory: stateDirectory });
    const key = {
      agentInstanceId: "agent-request-budget",
      sourceKind: "conversation" as const,
      sourceIdentifier: "session-request-budget",
    };
    const entries = Array.from({ length: 12 }, (_, index) => ({
      sourceKind: "conversation" as const,
      sourceIdentifier: "session-request-budget",
      sourceRevision: index + 1,
      contentHash: "hash-" + String(index),
      entryType: "message" as const,
      text: "第 " + String(index) + " 条完整记录 " + "字".repeat(400),
      recordedAtIso: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    }));
    await advanceSummaryGeneration({
      store,
      ...key,
      entries,
      narrativeGenerator: {
        generateNarrative: async (input: { facts: Array<unknown> }) =>
          "叙述 " + String(input.facts.length),
      },
    });
    const manifestBefore = await store.readManifest(key);
    const manifestFilePath = path.join(
      stateDirectory,
      "agent-memory",
      key.agentInstanceId,
      "summaries",
      key.sourceKind + "-" + key.sourceIdentifier,
      "manifest.json",
    );
    const bytesBefore = await fs.readFile(manifestFilePath, "utf8");

    // 把清单中的完整记录作为装配输入（记录级选择，不截断正文）。
    const service = new TokenMeasurementService(() => "2026-09-15T00:00:00.000Z");
    const records: RequestBudgetRecord[] = [];
    for (const chunk of manifestBefore?.chunks ?? []) {
      records.push({
        recordIdentifier: chunk.chunkIdentifier,
        priorityTier: 0,
        text: chunk.summaryText,
        isMandatory: false,
        measurement: await service.measureTokenCount({
          text: chunk.summaryText,
          providerIdentifier: null,
          modelIdentifier: null,
          serializationVersion: SERIALIZATION_VERSION,
        }),
      });
    }
    const assembly = assembleRequestBudget({
      configuredGlobalContextTokenCount: 1024,
      reservedOutputTokenCount: 128,
      reservedPackagingTokenCount: 0,
      records,
      pageSize: 4,
    });
    expect(assembly.status).toBe("requires-pagination");
    expect(
      assembly.selectedRecordIdentifiers.length +
        assembly.pagedRecordIdentifiers.flat().length,
    ).toBe(manifestBefore?.chunks.length);

    // 清单文件与 revision 未被装配过程改动（存档不裁剪）。
    const bytesAfter = await fs.readFile(manifestFilePath, "utf8");
    expect(bytesAfter).toBe(bytesBefore);
    const manifestAfter = await store.readManifest(key);
    expect(manifestAfter?.manifestRevision).toBe(manifestBefore?.manifestRevision);
    expect(manifestAfter?.chunks.length).toBe(manifestBefore?.chunks.length);
  });

  it("预留耗尽预算时 blocked（不产生空装配）", () => {
    const measurement: TokenMeasurement = {
      schemaVersion: 1,
      measurementSourceKind: "conservative-estimate",
      providerIdentifier: null,
      modelIdentifier: null,
      tokenizerIdentifier: null,
      tokenizerVersion: null,
      serializationVersion: SERIALIZATION_VERSION,
      estimatedTokenCount: 10,
      isAuthoritative: false,
      accuracyClaim: "none",
      rulesApplied: ["test"],
      fallbackReason: "no-tokenizer-declared",
      measuredAtIso: "2026-09-15T00:00:00.000Z",
    };
    const result = assembleRequestBudget({
      configuredGlobalContextTokenCount: 256,
      modelInputSpaceTokenCount: 200,
      reservedOutputTokenCount: 150,
      reservedPackagingTokenCount: 100,
      records: [
        {
          recordIdentifier: "record-000",
          priorityTier: 0,
          text: "x",
          isMandatory: false,
          measurement,
        },
      ],
    });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("budget-exhausted-by-reservations");
    expect(result.effectiveBudgetTokenCount).toBe(0);
  });
});
