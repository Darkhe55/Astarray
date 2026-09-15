/**
 * SUM-02-02：完整请求计量与包装/输出预留（只分页，不裁剪存档）。
 *
 * 规则（见 ADR-0035 §9–14）：
 * - 预算取全局配置（默认 4096，可调）与模型可用输入空间的较小值，再扣除输出与包装预留；
 * - 选入的是**完整记录**（记录级选择，绝不截断正文），必要约束必须整体放下；
 * - 放不下的记录进入**分页**而不是被丢弃；必要约束放不下时 `blocked`，绝不静默降级；
 * - 目标模型/tokenizer/序列化版本变化时**重新计量**，同目标且版本一致才复用。
 */
import type { TokenMeasurement } from "./token-measurement.js";
import {
  isMeasurementReusableFor,
  type TokenMeasurementService,
} from "./token-measurement.js";

export interface RequestBudgetRecord {
  recordIdentifier: string;
  /** 0 = 用户层级；数值越大优先级越低（与任务偏序一致）。 */
  priorityTier: number;
  /** 完整记录正文；本模块只做选择，不修改、不截断。 */
  text: string;
  /** 必要约束（放不下即 blocked，不允许丢弃）。 */
  isMandatory: boolean;
  measurement: TokenMeasurement;
}

export interface RequestMeasurementTarget {
  providerIdentifier: string | null;
  modelIdentifier: string | null;
  tokenizerIdentifier?: string | null;
  tokenizerVersion?: string | null;
  serializationVersion: number;
}

export interface RequestBudgetAssemblyInput {
  /** 全局上下文预算（GlobalContextBudgetStore，默认 4096，可调）。 */
  configuredGlobalContextTokenCount: number;
  /** 模型可用输入空间；null/undefined 表示未知（按配置值处理）。 */
  modelInputSpaceTokenCount?: number | null;
  /** 输出预留（本轮生成的回复）。 */
  reservedOutputTokenCount: number;
  /** 请求包装/序列化预留。 */
  reservedPackagingTokenCount: number;
  records: RequestBudgetRecord[];
  /** 分页大小（只影响"本次页"的切分，不影响是否保留）。 */
  pageSize?: number;
}

export interface RequestBudgetAssemblyResult {
  status: "fits" | "requires-pagination" | "blocked";
  effectiveBudgetTokenCount: number;
  configuredBudgetTokenCount: number;
  selectedRecordIdentifiers: string[];
  /** 未选入记录的完整分页（全部保留，仅分页）。 */
  pagedRecordIdentifiers: string[][];
  totalSelectedTokenCount: number;
  totalRecordTokenCount: number;
  blockedReason: string | null;
  notes: string[];
}

function totalTokens(records: RequestBudgetRecord[]): number {
  return records.reduce(
    (total, record) => total + record.measurement.estimatedTokenCount,
    0,
  );
}

/** 稳定排序：优先级升序，同级按标识升序（全序，无隐性哈希依赖）。 */
function sortRecordsStably(
  records: RequestBudgetRecord[],
): RequestBudgetRecord[] {
  return [...records].sort((left, right) => {
    if (left.priorityTier !== right.priorityTier) {
      return left.priorityTier - right.priorityTier;
    }
    return left.recordIdentifier.localeCompare(right.recordIdentifier);
  });
}

/** 完整请求装配：记录级选入 + 剩余记录分页（不裁剪）。 */
export function assembleRequestBudget(
  input: RequestBudgetAssemblyInput,
): RequestBudgetAssemblyResult {
  const notes: string[] = [];
  const configuredBudgetTokenCount = Math.max(
    0,
    Math.trunc(input.configuredGlobalContextTokenCount),
  );
  const modelInputSpace =
    input.modelInputSpaceTokenCount ?? configuredBudgetTokenCount;
  const reservations =
    Math.max(0, Math.trunc(input.reservedOutputTokenCount)) +
    Math.max(0, Math.trunc(input.reservedPackagingTokenCount));
  const effectiveBudgetTokenCount =
    Math.min(configuredBudgetTokenCount, modelInputSpace) - reservations;
  const totalRecordTokenCount = totalTokens(input.records);

  if (effectiveBudgetTokenCount <= 0) {
    return {
      status: "blocked",
      effectiveBudgetTokenCount: 0,
      configuredBudgetTokenCount,
      selectedRecordIdentifiers: [],
      pagedRecordIdentifiers: [],
      totalSelectedTokenCount: 0,
      totalRecordTokenCount,
      blockedReason: "budget-exhausted-by-reservations",
      notes,
    };
  }

  const sortedRecords = sortRecordsStably(input.records);
  const mandatoryRecords = sortedRecords.filter((record) => record.isMandatory);
  const optionalRecords = sortedRecords.filter((record) => !record.isMandatory);
  const mandatoryTokenCount = totalTokens(mandatoryRecords);
  if (mandatoryTokenCount > effectiveBudgetTokenCount) {
    // 必要约束放不下：blocked（调用方可拆分任务），绝不丢弃。
    return {
      status: "blocked",
      effectiveBudgetTokenCount,
      configuredBudgetTokenCount,
      selectedRecordIdentifiers: [],
      pagedRecordIdentifiers: [],
      totalSelectedTokenCount: 0,
      totalRecordTokenCount,
      blockedReason: "mandatory-context-exceeds-budget",
      notes: [
        "mandatory=" +
          String(mandatoryTokenCount) +
          " > effective=" +
          String(effectiveBudgetTokenCount),
      ],
    };
  }

  const selected: RequestBudgetRecord[] = [...mandatoryRecords];
  let usedTokenCount = mandatoryTokenCount;
  const paged: RequestBudgetRecord[] = [];
  for (const record of optionalRecords) {
    const recordTokenCount = record.measurement.estimatedTokenCount;
    if (usedTokenCount + recordTokenCount <= effectiveBudgetTokenCount) {
      selected.push(record);
      usedTokenCount += recordTokenCount;
    } else {
      paged.push(record);
    }
  }

  const pageSize = Math.max(
    1,
    Math.trunc(input.pageSize ?? (paged.length === 0 ? 1 : paged.length)),
  );
  const pagedRecordIdentifiers: string[][] = [];
  for (let index = 0; index < paged.length; index += pageSize) {
    pagedRecordIdentifiers.push(
      paged
        .slice(index, index + pageSize)
        .map((record) => record.recordIdentifier),
    );
  }

  if (paged.length > 0) {
    notes.push(
      "paged=" + String(paged.length) + "（完整保留，等待后续页/拆分，不裁剪）",
    );
  }
  return {
    status: paged.length > 0 ? "requires-pagination" : "fits",
    effectiveBudgetTokenCount,
    configuredBudgetTokenCount,
    selectedRecordIdentifiers: selected.map(
      (record) => record.recordIdentifier,
    ),
    pagedRecordIdentifiers,
    totalSelectedTokenCount: usedTokenCount,
    totalRecordTokenCount,
    blockedReason: null,
    notes,
  };
}

export function buildMeasurementTargetKey(
  target: RequestMeasurementTarget,
): string {
  return [
    target.providerIdentifier ?? "-",
    target.modelIdentifier ?? "-",
    target.tokenizerIdentifier ?? "-",
    target.tokenizerVersion ?? "-",
    String(target.serializationVersion),
  ].join("|");
}

/** 同目标且版本一致才复用既有计量；否则必须重新计量。 */
export function isMeasurementReusableForTarget(
  measurement: TokenMeasurement,
  target: RequestMeasurementTarget,
): boolean {
  if (
    measurement.providerIdentifier !== target.providerIdentifier ||
    measurement.modelIdentifier !== target.modelIdentifier
  ) {
    return false;
  }
  return isMeasurementReusableFor(measurement, {
    serializationVersion: target.serializationVersion,
    tokenizerIdentifier: target.tokenizerIdentifier ?? null,
    tokenizerVersion: target.tokenizerVersion ?? null,
  });
}

export interface RemeasureRecordsResult {
  records: RequestBudgetRecord[];
  remeasuredRecordCount: number;
  reusedRecordCount: number;
  targetKey: string;
}

/**
 * 目标模型切换后的重新计量：可复用则复用，否则调用计量服务重新计算。
 * 记录正文原样保留（只更新 measurement）。
 */
export async function remeasureRecordsForTarget(input: {
  records: RequestBudgetRecord[];
  target: RequestMeasurementTarget;
  measurementService: TokenMeasurementService;
  nowIso?: () => string;
}): Promise<RemeasureRecordsResult> {
  const remeasuredRecords: RequestBudgetRecord[] = [];
  let remeasuredRecordCount = 0;
  let reusedRecordCount = 0;
  for (const record of input.records) {
    if (isMeasurementReusableForTarget(record.measurement, input.target)) {
      reusedRecordCount += 1;
      remeasuredRecords.push(record);
      continue;
    }
    const measurement = await input.measurementService.measureTokenCount({
      text: record.text,
      providerIdentifier: input.target.providerIdentifier,
      modelIdentifier: input.target.modelIdentifier,
      tokenizerIdentifier: input.target.tokenizerIdentifier ?? null,
      tokenizerVersion: input.target.tokenizerVersion ?? null,
      serializationVersion: input.target.serializationVersion,
      ...(input.nowIso !== undefined ? { nowIso: input.nowIso() } : {}),
    });
    remeasuredRecordCount += 1;
    remeasuredRecords.push({ ...record, measurement });
  }
  return {
    records: remeasuredRecords,
    remeasuredRecordCount,
    reusedRecordCount,
    targetKey: buildMeasurementTargetKey(input.target),
  };
}
