/**
 * SUM-01-02：摘要生成推进（本地事实 → 后台叙述 → 原子发布，可中断续跑）。
 *
 * 流程：single-flight → 读清单 → 读 pending 草稿 → 只提取尚未提取的来源事实
 * （权威、本地）→ 生成叙述（模型端口，后台）→ CAS 发布 → 清理 pending。
 * 任一步骤中断都留下可续跑的 pending 草稿；发布失败绝不产生半份清单。
 */
import { DomainError } from "../core/errors.js";
import {
  createSummaryManifest,
  appendSummarySource,
  type SummaryManifest,
  type SummarySourceKind,
} from "./summary-manifest.js";
import {
  extractSummaryFacts,
  summaryFactDeduplicationKey,
  type SummaryFact,
  type SummarySourceEntry,
} from "./summary-fact-extractor.js";
import type { SummaryIndexStore } from "./summary-index-store.js";

export interface SummaryNarrativeGeneratorPort {
  generateNarrative(input: {
    agentInstanceId: string;
    sourceKind: SummarySourceKind;
    sourceIdentifier: string;
    facts: SummaryFact[];
    pendingSourceRevisions: number[];
    previousNarrative: string | null;
  }): Promise<string>;
}

export interface AdvanceSummaryGenerationInput {
  store: SummaryIndexStore;
  agentInstanceId: string;
  sourceKind: SummarySourceKind;
  sourceIdentifier: string;
  entries: SummarySourceEntry[];
  narrativeGenerator: SummaryNarrativeGeneratorPort;
  factExtractor?: (entries: SummarySourceEntry[]) => SummaryFact[];
  maximumFactsPerBatch?: number;
  nowIso?: () => string;
  /** 叙述生成器版本（本地抽取式 vs 后续模型生成器必须可区分）。 */
  generatorVersion?: string;
}

export interface AdvanceSummaryGenerationResult {
  manifest: SummaryManifest | null;
  didExtractFacts: boolean;
  didGenerateNarrative: boolean;
  publishedManifestRevision: number | null;
  isPendingResumable: boolean;
  factCount: number;
}

function summarizeTextForChunk(fact: SummaryFact): string {
  // 分块文本是本地权威事实（不改写语义）；token 换算留给 SUM-02 计量适配。
  return fact.factText;
}

function estimateUnits(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 待并入摘要的来源 revision 在清单缺 revision 时显式记录（不假装已覆盖）。 */
function derivePendingRevisions(
  manifest: SummaryManifest | null,
  facts: SummaryFact[],
): number[] {
  if (manifest === null) {
    return [];
  }
  return facts
    .map((fact) => fact.sourceRevision)
    .filter(
      (revision) => revision <= manifest.coveredThroughSourceRevision,
    );
}

export async function advanceSummaryGeneration(
  input: AdvanceSummaryGenerationInput,
): Promise<AdvanceSummaryGenerationResult> {
  return input.store.withSingleFlight(
    {
      agentInstanceId: input.agentInstanceId,
      sourceKind: input.sourceKind,
      sourceIdentifier: input.sourceIdentifier,
    },
    async () => {
      const store = input.store;
      const extractor = input.factExtractor ?? extractSummaryFacts;
      const key = {
        agentInstanceId: input.agentInstanceId,
        sourceKind: input.sourceKind,
        sourceIdentifier: input.sourceIdentifier,
      };
      const manifest = await store.readManifest(key);
      const existingPending = await store.readPendingGeneration(key);

      const coveredRevisions = new Set<number>(
        manifest === null
          ? []
          : manifest.chunks.flatMap((chunk) => {
              const revisions: number[] = [];
              for (
                let revision = chunk.sourceRevisionFrom;
                revision <= chunk.sourceRevisionTo;
                revision += 1
              ) {
                revisions.push(revision);
              }
              return revisions;
            }),
      );
      const existingFactKeys = new Set(
        (existingPending?.facts ?? []).map((fact) =>
          summaryFactDeduplicationKey(fact),
        ),
      );
      const uncoveredEntries = input.entries.filter(
        (entry) =>
          !coveredRevisions.has(entry.sourceRevision) &&
          !existingFactKeys.has(summaryFactDeduplicationKey(entry)),
      );

      const maximumFactsPerBatch = input.maximumFactsPerBatch;
      const entriesToExtract =
        maximumFactsPerBatch === undefined
          ? uncoveredEntries
          : uncoveredEntries.slice(0, maximumFactsPerBatch);
      // 无可提取条目时不调用提取器（续跑路径不得重复提取已落地事实）。
      const newlyExtractedFacts =
        entriesToExtract.length === 0
          ? []
          : extractor(entriesToExtract).filter(
              (fact) => !existingFactKeys.has(summaryFactDeduplicationKey(fact)),
            );

      if (newlyExtractedFacts.length === 0 && existingPending === null) {
        return {
          manifest,
          didExtractFacts: false,
          didGenerateNarrative: false,
          publishedManifestRevision: null,
          isPendingResumable: false,
          factCount: 0,
        };
      }

      const nowIso =
        input.nowIso ?? (() => new Date().toISOString());
      const facts = [...(existingPending?.facts ?? []), ...newlyExtractedFacts];
      const pendingSourceRevisions = [
        ...new Set([
          ...(existingPending?.pendingSourceRevisions ?? []),
          ...derivePendingRevisions(manifest, newlyExtractedFacts),
        ]),
      ].sort((left, right) => left - right);
      const baseManifestRevision = manifest?.manifestRevision ?? 0;
      const pending = {
        schemaVersion: 1 as const,
        agentInstanceId: input.agentInstanceId,
        sourceKind: input.sourceKind,
        sourceIdentifier: input.sourceIdentifier,
        facts,
        pendingSourceRevisions,
        draftNarrative: existingPending?.draftNarrative ?? null,
        baseManifestRevision,
        createdAtIso: existingPending?.createdAtIso ?? nowIso(),
        updatedAtIso: nowIso(),
      };
      await store.writePendingGeneration(pending);

      if (pending.draftNarrative === null) {
        const narrative = await input.narrativeGenerator.generateNarrative({
          agentInstanceId: input.agentInstanceId,
          sourceKind: input.sourceKind,
          sourceIdentifier: input.sourceIdentifier,
          facts,
          pendingSourceRevisions,
          previousNarrative: manifest?.narrativeText ?? null,
        });
        if (narrative.trim() === "") {
          throw new DomainError(
            "journal-corrupted",
            "叙述生成返回空内容，保留 pending 以便续跑",
          );
        }
        pending.draftNarrative = narrative;
        pending.updatedAtIso = nowIso();
        await store.writePendingGeneration(pending);
      }

      let nextManifest =
        manifest ??
        createSummaryManifest({
          agentInstanceId: input.agentInstanceId,
          sourceKind: input.sourceKind,
          sourceIdentifier: input.sourceIdentifier,
          generatorVersion: input.generatorVersion ?? "generation-service-1",
          nowIso: nowIso(),
        });
      // 续跑时 pending 里已有的事实同样要落地（否则崩溃恢复会丢掉已提取事实）。
      const factsToPublish = pending.facts.filter(
        (fact) => !coveredRevisions.has(fact.sourceRevision),
      );
      for (const fact of factsToPublish) {
        nextManifest = appendSummarySource(nextManifest, {
          sourceRevision: fact.sourceRevision,
          contentHash: fact.contentHash,
          summaryText: summarizeTextForChunk(fact),
          themeIdentifier: fact.entryType,
          estimatedUnitCount: estimateUnits(fact.factText),
          evidencePointers: [
            {
              sourceKind: fact.sourceKind,
              sourceIdentifier: fact.sourceIdentifier,
              sourceRevision: fact.sourceRevision,
              contentHash: fact.contentHash,
            },
          ],
          narrativeText: pending.draftNarrative,
        }).manifest;
      }
      const published = await store.publishManifest({
        ...key,
        manifest: nextManifest,
        expectedRevision: baseManifestRevision,
      });
      await store.clearPendingGeneration(key);
      return {
        manifest: published,
        didExtractFacts: newlyExtractedFacts.length > 0,
        didGenerateNarrative: true,
        publishedManifestRevision: published.manifestRevision,
        isPendingResumable: false,
        factCount: facts.length,
      };
    },
  );
}
