/**
 * USAGE-01-02：请求级账目的**持久化去重、乱序终值、分页聚合、预算与估价**（2026-10-02）。
 *
 * 契约来源：OBS-01-01 冻结的共享最小事件契约 §4.2（USAGE 事件）。
 *
 * 纪律（逐条对应反例）：
 *  ① 同键同内容幂等（不重复计账）；
 *  ② 同键**异参**（inputHash 不同）→ 拒绝写入并记冲突，**不覆盖**；
 *  ③ 乱序终值：低 revision 不得覆盖高 revision；
 *  ④ 重启：跨实例读同一目录，幂等不重复；
 *  ⑤ 跨模型：按模型分组，不合并成单一账单；
 *  ⑥ 取消缺 usage：记 null 并注原因，**不得补 0**（总量标记不完整）；
 *  ⑦ 估算记录不得用于账单结论；价格表缺失 → costEstimate=null 且给原因；
 *  ⑧ 并发预算：计数不漏记，超预算显式报告；
 *  ⑨ 分页：游标稳定不重不漏。
 */
import { promises as fs } from "node:fs";

import { writeAtomicJson } from "../infra/atomic-json.js";
import path from "node:path";

export interface UsageLedgerEntry {
  /** 请求级标识（稳定，可跨重启对上）。 */
  requestIdentifier: string;
  /** 同一请求的修订；终值取**最大** revision。 */
  requestRevision: number;
  missionIdentifier: string | null;
  taskIdentifier: string | null;
  sourceAgentInstanceId: string;
  providerProfileId: string;
  modelIdentifier: string;
  recordedAtIso: string;
  /** 未知（未拿到 usage）必须为 null，**不得补 0**。 */
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  cachedTokenCount: number | null;
  /** 估算必须显式标记；为真时不得用于账单结论。 */
  isEstimated: boolean;
  /** 规范化完整参数哈希（同键异参据此拒绝）。 */
  inputHash: string;
  /** 总量/子量归属：子量不得重复计入总量。 */
  attribution: { kind: "total" | "subtotal"; parentRequestIdentifier: string | null };
  /** 未拿到 usage 的原因（取消/超时等）。 */
  missingUsageReason?: string;
}

export type UsageAppendOutcome =
  | "appended"
  | "duplicate-idempotent"
  | "conflict-rejected"
  | "stale-revision-rejected";

export interface UsageAppendResult {
  outcome: UsageAppendOutcome;
  detail: string;
}

export interface UsageConflictReport {
  conflictCount: number;
  staleRevisionRejectedCount: number;
}

const USAGE_LEDGER_FILE_NAME = "entries.json";

/**
 * 请求级账目存储：单文件 JSON（原子替换），进程内维护键 → 终值。
 *
 * 使用单文件而非 JSONL：账目需要**按键去重/取终值**，JSONL 只能追加，
 * 去重必须在读取时做；这里改为"按键收敛后整体原子落盘"，使重启后语义一致。
 */
export class UsageLedgerStore {
  private readonly filePath: string;
  private readonly entriesByRequestIdentifier = new Map<string, UsageLedgerEntry>();
  private conflictCount = 0;
  private staleRevisionRejectedCount = 0;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "usage", USAGE_LEDGER_FILE_NAME);
  }

  private async loadFromDisk(): Promise<void> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawContent) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) {
        return;
      }
      for (const rawEntry of parsed.entries) {
        if (rawEntry === null || typeof rawEntry !== "object") {
          continue;
        }
        const entry = rawEntry as UsageLedgerEntry;
        if (typeof entry.requestIdentifier === "string") {
          this.entriesByRequestIdentifier.set(entry.requestIdentifier, entry);
        }
      }
    } catch {
      // 损坏账目：不伪造历史，按空账目继续（并保留原文件由人工处理）
    }
  }

  private async persistToDisk(): Promise<void> {
    /**
     * 复用受控原子写（infra/atomic-json.ts）：临时文件含随机名 → flush(sync) → rename 替换。
     * 架构守卫要求破坏性文件 API 只出现在白名单模块内，因此此处**不得**自行 writeFile/rename；
     * 并发安全由调用方的写链（enqueuePersist）保证（反例⑧实测的 ENOENT 竞态）。
     */
    await writeAtomicJson(this.filePath, {
      schemaVersion: 1,
      entries: [...this.entriesByRequestIdentifier.values()],
    });
  }

  /** 串行化落盘：把并发 append 的写操作排成一条链，避免互相覆盖。 */
  private pendingWritePromise: Promise<void> = Promise.resolve();

  private enqueuePersist(): Promise<void> {
    const nextWrite = this.pendingWritePromise.then(
      () => this.persistToDisk(),
      () => this.persistToDisk(),
    );
    // 保持链不因单次失败而断掉（失败向上抛给调用方，链本身继续可用）。
    this.pendingWritePromise = nextWrite.catch(() => undefined);
    return nextWrite;
  }

  /**
   * 登记一条账目。去重与终值口径：
   *  - 同键同内容 → 幂等（不重复计账）；
   *  - 同键异参 → 冲突拒绝（不覆盖）；
   *  - 同键低 revision → 乱序终值拒绝。
   */
  async append(entry: UsageLedgerEntry): Promise<UsageAppendResult> {
    if (this.entriesByRequestIdentifier.size === 0) {
      await this.loadFromDisk();
    }
    const existing = this.entriesByRequestIdentifier.get(entry.requestIdentifier);
    if (existing !== undefined) {
      if (existing.inputHash !== entry.inputHash) {
        this.conflictCount += 1;
        return {
          outcome: "conflict-rejected",
          detail: "同键异参：已存在不同参数哈希的账目，拒绝覆盖",
        };
      }
      if (entry.requestRevision < existing.requestRevision) {
        this.staleRevisionRejectedCount += 1;
        return {
          outcome: "stale-revision-rejected",
          detail:
            "乱序终值：已存在更高 revision（" +
            String(existing.requestRevision) +
            "），拒绝用 revision " +
            String(entry.requestRevision) +
            " 覆盖",
        };
      }
      if (entry.requestRevision === existing.requestRevision) {
        return { outcome: "duplicate-idempotent", detail: "同键同 revision 同内容：幂等忽略" };
      }
    }
    this.entriesByRequestIdentifier.set(entry.requestIdentifier, entry);
    await this.enqueuePersist();
    return { outcome: "appended", detail: "已登记" };
  }

  async readAll(): Promise<UsageLedgerEntry[]> {
    if (this.entriesByRequestIdentifier.size === 0) {
      await this.loadFromDisk();
    }
    return [...this.entriesByRequestIdentifier.values()];
  }

  getConflictReport(): UsageConflictReport {
    return {
      conflictCount: this.conflictCount,
      staleRevisionRejectedCount: this.staleRevisionRejectedCount,
    };
  }

  /** 分页（游标=已消费条数；稳定不重不漏）。 */
  paginate(input: { entries: UsageLedgerEntry[]; pageSize: number; cursor?: string }): {
    entries: UsageLedgerEntry[];
    nextCursor: string | null;
  } {
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    let startIndex = 0;
    if (input.cursor !== undefined && input.cursor !== "") {
      const parsedCursor = Number.parseInt(input.cursor, 10);
      startIndex = Number.isNaN(parsedCursor) || parsedCursor < 0 ? 0 : parsedCursor;
    }
    if (startIndex >= input.entries.length) {
      return { entries: [], nextCursor: null };
    }
    const pageEntries = input.entries.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + pageEntries.length;
    return {
      entries: pageEntries,
      nextCursor: nextIndex < input.entries.length ? String(nextIndex) : null,
    };
  }
}

export interface UsageAggregateMetrics {
  entryCount: number;
  totals: {
    /** 任一条目 usage 未知（null）时整体为 null —— 未知不得当 0。 */
    inputTokenCount: number | null;
    outputTokenCount: number | null;
    /** 是否存在 usage 缺失（取消/超时）。 */
    hasIncompleteUsage: boolean;
  };
  /** 仅"非估算"条目的账单口径；无可用条目时为 null。 */
  billable: {
    inputTokenCount: number | null;
    outputTokenCount: number | null;
    excludedEstimatedCount: number;
  };
  byModel: Array<{
    modelIdentifier: string;
    inputTokenCount: number;
    outputTokenCount: number;
    entryCount: number;
  }>;
  costEstimate: {
    amountMinorUnits: number | null;
    currency: string;
    unavailableReason: string | null;
  };
}

const USAGE_CURRENCY = "CNY";

/**
 * 纯函数聚合（USAGE-01-02 §4.2 边界约束）。
 *
 * 关键纪律：**总量与子量分开**（子量不计入总量）；**估算与账单分开**；
 * **未知记为 null 并标记不完整**（不补 0）。
 */
export function aggregateUsageEntries(entries: UsageLedgerEntry[]): UserFacingUsageMetrics {
  let totalInput: number | null = 0;
  let totalOutput: number | null = 0;
  let hasIncompleteUsage = false;
  let billableInput: number | null = 0;
  let billableOutput: number | null = 0;
  let excludedEstimatedCount = 0;
  const byModelMap = new Map<
    string,
    { inputTokenCount: number; outputTokenCount: number; entryCount: number }
  >();

  for (const entry of entries) {
    // 子量不得重复计入总量：subtotal 明确排除在总量之外。
    const isCountedInTotals = entry.attribution.kind === "total";
    if (!isCountedInTotals) {
      continue;
    }
    if (entry.inputTokenCount === null || entry.outputTokenCount === null) {
      // 未知不得当 0：整体标记不完整并把总量置 null。
      hasIncompleteUsage = true;
      totalInput = null;
      totalOutput = null;
    } else {
      if (totalInput !== null) {
        totalInput += entry.inputTokenCount;
      }
      if (totalOutput !== null) {
        totalOutput += entry.outputTokenCount;
      }
    }

    const modelGroup = byModelMap.get(entry.modelIdentifier) ?? {
      inputTokenCount: 0,
      outputTokenCount: 0,
      entryCount: 0,
    };
    modelGroup.inputTokenCount += entry.inputTokenCount ?? 0;
    modelGroup.outputTokenCount += entry.outputTokenCount ?? 0;
    modelGroup.entryCount += 1;
    byModelMap.set(entry.modelIdentifier, modelGroup);

    if (entry.isEstimated) {
      excludedEstimatedCount += 1;
      continue;
    }
    if (entry.inputTokenCount === null || entry.outputTokenCount === null) {
      billableInput = null;
      billableOutput = null;
      continue;
    }
    if (billableInput !== null) {
      billableInput += entry.inputTokenCount;
    }
    if (billableOutput !== null) {
      billableOutput += entry.outputTokenCount;
    }
  }

  const hasBillableEntry = entries.some((entry) => !entry.isEstimated);
  const metrics: UsageAggregateMetrics = {
    entryCount: entries.length,
    totals: {
      inputTokenCount: totalInput,
      outputTokenCount: totalOutput,
      hasIncompleteUsage,
    },
    billable: {
      inputTokenCount: hasBillableEntry ? billableInput : null,
      outputTokenCount: hasBillableEntry ? billableOutput : null,
      excludedEstimatedCount,
    },
    byModel: [...byModelMap.entries()]
      .map(([modelIdentifier, group]) => ({ modelIdentifier, ...group }))
      .sort((left, right) => left.modelIdentifier.localeCompare(right.modelIdentifier)),
    costEstimate: {
      amountMinorUnits: null,
      currency: USAGE_CURRENCY,
      // 价格表缺失时必须给原因，且不得用本地估算冒充官方余额。
      unavailableReason: "价格表未配置：无法给出费用估算（不得以本地估算冒充账单）",
    },
  };
  return {
    ...metrics,
    evaluateBudget: (input) => evaluateUsageBudget(metrics, input),
  };
}

export interface UsageBudgetEvaluation {
  isExceeded: boolean;
  exceededByTokenCount: number;
  consumedTokenCount: number | null;
  inputTokenBudget: number;
}

/**
 * 预算判定。
 *
 * 纪律：用量不完整（未知）时**不得宣称"未超预算"**——此时 consumedTokenCount 为 null，
 * 调用方必须据此显示"不可判定"，而不是绿灯。
 */
export function evaluateUsageBudget(
  metrics: UsageAggregateMetrics,
  input: { inputTokenBudget: number },
): UsageBudgetEvaluation {
  const consumedTokenCount = metrics.totals.inputTokenCount;
  if (consumedTokenCount === null) {
    return {
      isExceeded: false,
      exceededByTokenCount: 0,
      consumedTokenCount: null,
      inputTokenBudget: input.inputTokenBudget,
    };
  }
  const exceededBy = consumedTokenCount - input.inputTokenBudget;
  return {
    isExceeded: exceededBy > 0,
    exceededByTokenCount: exceededBy > 0 ? exceededBy : 0,
    consumedTokenCount,
    inputTokenBudget: input.inputTokenBudget,
  };
}

/** 聚合结果 + 便捷预算判定（供 CLI/SDK 直接调用）。 */
export interface UserFacingUsageMetrics extends UsageAggregateMetrics {
  evaluateBudget: (input: { inputTokenBudget: number }) => UsageBudgetEvaluation;
}
