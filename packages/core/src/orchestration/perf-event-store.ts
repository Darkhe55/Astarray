/**
 * PERF-01-02：进程/任务测量的**持久聚合、分页与告警**（2026-10-02）。
 *
 * 契约来源：OBS-01-01 冻结的共享最小事件契约 §4.1（通用信封）与 §4.3（PERF 事件）。
 * 设计原则（沿用既有 T09A-R1-04 的成熟做法）：
 *  - 事件为**追加式 JSONL**（原始样本可复算，指标不由内存状态拼凑）；
 *  - 聚合为**纯函数**，输出**样本量与分母**；
 *  - **无法测量时不得报 0**：样本不足/监测器失败一律显式表达为"不可报告"。
 *
 * 卡内点名的五类故障各有明确行为：
 *  ① 高并发：并发追加必须原子（单次 write 调用写整行），不得丢样本或损坏行边界；
 *  ② 进程退出：尾部半行必须被跳过，且必须**报告被丢弃的行数**（不静默当作零）；
 *  ③ 队列溢出：超过容量的样本必须显式计入 droppedSampleCount 并产生降级告警；
 *  ④ 时钟变化：时间倒退不得产生负区间，且必须标注 hasClockAnomaly；
 *  ⑤ 监测器失败：给出 measurementFailureReason 时产生 monitor-unmeasurable 告警。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 共享事件信封（OBS-01-01 §4.1）。 */
export interface PerfEventEnvelope {
  observeEventVersion: 1;
  eventType: "perf" | "usage" | "diagnostic";
  recordedAtIso: string;
  /** 具体个体（不可复用）；沿用既有 agentInstanceId 隔离规则。 */
  sourceAgentInstanceId: string;
  missionIdentifier: string | null;
  taskIdentifier: string | null;
  /** 请求级标识（稳定，可跨重启对上）。 */
  requestIdentifier: string;
  /** 同一请求的修订（终值/重算依据）。 */
  requestRevision: number;
  origin: { kind: "provider" | "local-estimate" | "system" };
}

/** PERF 样本（OBS-01-01 §4.3）。 */
export interface PerfSampleEvent extends PerfEventEnvelope {
  eventType: "perf";
  operationKind: string;
  durationMilliseconds: number;
  outcome: "success" | "failure" | "cancelled" | "unknown";
  /** 排队深度（可选；用于队列溢出观测）。 */
  queueDepth?: number;
}

export interface PerfIntegrityReport {
  samples: PerfSampleEvent[];
  /** 无法解析而被丢弃的行数（进程退出造成的半行等）。 */
  discardedLineCount: number;
}

export interface PerfOverflowReport {
  isOverflowed: boolean;
  droppedSampleCount: number;
}

export interface PerfSamplePersistenceOptions {
  baseDirectory: string;
  /**
   * 内存中保留的样本上限（避免长会话内存无界）。
   * 超出的样本**仍然落盘**（供复算），但计入 droppedSampleCount 以显式暴露观测降级。
   */
  maximumPendingSampleCount?: number;
}

const DEFAULT_MAXIMUM_PENDING_SAMPLE_COUNT = 1_000;

const PERF_SAMPLE_EVENT_TYPES = new Set(["perf", "usage", "diagnostic"]);

export class PerfEventStore {
  private readonly filePath: string;
  private readonly maximumPendingSampleCount: number;
  private readonly inMemorySamples: PerfSampleEvent[] = [];
  private droppedSampleCount = 0;

  constructor(options: PerfSamplePersistenceOptions) {
    this.filePath = path.join(options.baseDirectory, "perf", "samples.jsonl");
    this.maximumPendingSampleCount =
      options.maximumPendingSampleCount ?? DEFAULT_MAXIMUM_PENDING_SAMPLE_COUNT;
  }

  /**
   * 追加一个样本。
   *
   * 原子性：`fs.appendFile` 以**单次写入**提交整行（含换行），
   * 使高并发追加不会交错撕裂行边界（反例①）。内存保留量超限即计入溢出（反例③）。
   */
  async append(sample: PerfSampleEvent): Promise<void> {
    const line = JSON.stringify(sample) + "\n";
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf8");
    if (this.inMemorySamples.length >= this.maximumPendingSampleCount) {
      this.droppedSampleCount += 1;
      return;
    }
    this.inMemorySamples.push(sample);
  }

  /** 读取全部样本（含完整性报告；供复算与审计）。 */
  async readWithIntegrity(): Promise<PerfIntegrityReport> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      // 无文件 = 无样本（不是失败，也不是"零耗时正常"）。
      return { samples: [], discardedLineCount: 0 };
    }
    const samples: PerfSampleEvent[] = [];
    let discardedLineCount = 0;
    for (const line of rawContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as PerfSampleEvent;
        if (
          parsed.eventType === "perf" &&
          typeof parsed.durationMilliseconds === "number" &&
          typeof parsed.requestIdentifier === "string"
        ) {
          samples.push(parsed);
        } else {
          discardedLineCount += 1;
        }
      } catch {
        // 半行/损坏行：跳过并计数（反例②），不阻塞其余事件。
        discardedLineCount += 1;
      }
    }
    return { samples, discardedLineCount };
  }

  /** 读取全部样本（便捷封装）。 */
  async readAll(): Promise<PerfSampleEvent[]> {
    return (await this.readWithIntegrity()).samples;
  }

  getOverflowReport(): PerfOverflowReport {
    return {
      isOverflowed: this.droppedSampleCount > 0,
      droppedSampleCount: this.droppedSampleCount,
    };
  }

  /**
   * 内存中保留的样本数（长会话内存有界的可观测证据）。
   * 该值**永远不超过** `maximumPendingSampleCount`，与落盘总量无关。
   */
  getRetainedInMemorySampleCount(): number {
    return this.inMemorySamples.length;
  }
}

/**
 * 把带 `eventType` 的联合类型收窄为 PERF 样本。
 * 供调用方在读取共享事件文件时过滤非 PERF 事件。
 */
export function isPerfSampleEvent(value: unknown): value is PerfSampleEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as { eventType?: unknown; durationMilliseconds?: unknown };
  return (
    typeof candidate.eventType === "string" &&
    PERF_SAMPLE_EVENT_TYPES.has(candidate.eventType) &&
    candidate.eventType === "perf" &&
    typeof candidate.durationMilliseconds === "number"
  );
}

export interface PerfAggregateMetrics {
  sampleSize: number;
  denominators: {
    successCount: number;
    failureCount: number;
    cancelledCount: number;
    unknownCount: number;
  };
  durationMilliseconds: {
    /** 无样本时为 null —— 绝不报 0 冒充"正常"（反例⑧）。 */
    mean: number | null;
    minimum: number | null;
    maximum: number | null;
    p95: number | null;
  };
  windowStartIso: string | null;
  windowEndIso: string | null;
  /** 事件序列中出现时间倒退（反例④）。 */
  hasClockAnomaly: boolean;
  isReportable: boolean;
  unreportableReason: string | null;
}

/** 低于此样本量时不报告耗时结论（避免用极小样本冒充性能结论）。 */
export const MINIMUM_SAMPLE_SIZE_FOR_DURATION_REPORTING = 1;

/**
 * 纯函数复算（OBS-01-01 §4.3）：不依赖内存状态，同一批事件必然得到同一结果。
 */
export function aggregatePerfSamples(samples: PerfSampleEvent[]): PerfAggregateMetrics {
  const denominators = {
    successCount: 0,
    failureCount: 0,
    cancelledCount: 0,
    unknownCount: 0,
  };
  if (samples.length === 0) {
    return {
      sampleSize: 0,
      denominators,
      durationMilliseconds: { mean: null, minimum: null, maximum: null, p95: null },
      windowStartIso: null,
      windowEndIso: null,
      hasClockAnomaly: false,
      isReportable: false,
      unreportableReason: "样本不足：无事件，无法给出耗时结论（不报 0）",
    };
  }

  const durations: number[] = [];
  const timestamps: number[] = [];
  let hasClockAnomaly = false;
  let previousTimestamp: number | null = null;

  for (const sample of samples) {
    for (const [outcomeKey, outcomeValue] of [
      ["success", "successCount"],
      ["failure", "failureCount"],
      ["cancelled", "cancelledCount"],
      ["unknown", "unknownCount"],
    ] as const) {
      if (sample.outcome === outcomeKey) {
        denominators[outcomeValue] += 1;
      }
    }
    if (Number.isFinite(sample.durationMilliseconds) && sample.durationMilliseconds >= 0) {
      durations.push(sample.durationMilliseconds);
    }
    const timestamp = Date.parse(sample.recordedAtIso);
    if (!Number.isNaN(timestamp)) {
      timestamps.push(timestamp);
      if (previousTimestamp !== null && timestamp < previousTimestamp) {
        // 反例④：时间倒退必须被标注，而不是算出一个负区间。
        hasClockAnomaly = true;
      }
      previousTimestamp = timestamp;
    }
  }

  const sampleSize = samples.length;
  const isReportable = sampleSize >= MINIMUM_SAMPLE_SIZE_FOR_DURATION_REPORTING && durations.length > 0;
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const p95Index = Math.min(
    sortedDurations.length - 1,
    Math.max(0, Math.ceil(0.95 * sortedDurations.length) - 1),
  );

  return {
    sampleSize,
    denominators,
    durationMilliseconds: isReportable
      ? {
          mean: durations.reduce((total, value) => total + value, 0) / durations.length,
          minimum: sortedDurations[0] ?? null,
          maximum: sortedDurations[sortedDurations.length - 1] ?? null,
          p95: sortedDurations[p95Index] ?? null,
        }
      : { mean: null, minimum: null, maximum: null, p95: null },
    windowStartIso: timestamps.length === 0 ? null : new Date(Math.min(...timestamps)).toISOString(),
    windowEndIso: timestamps.length === 0 ? null : new Date(Math.max(...timestamps)).toISOString(),
    hasClockAnomaly,
    isReportable,
    unreportableReason: isReportable
      ? null
      : "样本不足：无可用的耗时样本，无法给出耗时结论（不报 0）",
  };
}

export interface PerfSamplePage {
  samples: PerfSampleEvent[];
  nextCursor: string | null;
}

/**
 * 分页（反例⑦）：游标为"已消费条数"的十进制字符串，稳定且不重不漏；
 * 越界游标返回空页并给出 nextCursor=null（不是报错，也不是回到第一页）。
 */
export function paginatePerfSamples(input: {
  samples: PerfSampleEvent[];
  pageSize: number;
  cursor?: string;
}): PerfSamplePage {
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  let startIndex = 0;
  if (input.cursor !== undefined && input.cursor !== "") {
    const parsedCursor = Number.parseInt(input.cursor, 10);
    startIndex = Number.isNaN(parsedCursor) || parsedCursor < 0 ? 0 : parsedCursor;
  }
  if (startIndex >= input.samples.length) {
    return { samples: [], nextCursor: null };
  }
  const pageSamples = input.samples.slice(startIndex, startIndex + pageSize);
  const nextIndex = startIndex + pageSamples.length;
  return {
    samples: pageSamples,
    nextCursor: nextIndex < input.samples.length ? String(nextIndex) : null,
  };
}

export interface PerfOverviewQuery {
  /** 可见范围（按 mission 过滤）；null/未给出表示不过滤。 */
  missionIdentifier?: string | null;
  /** 时间窗下界（ISO，含）；null/未给出表示不限。 */
  windowStartIso?: string | null;
  /** 时间窗上界（ISO，含）；null/未给出表示不限。 */
  windowEndIso?: string | null;
  /** 摘要或明细：摘要只给聚合，明细给分页样本。 */
  detailLevel?: "summary" | "detail";
  pageSize?: number;
  cursor?: string;
}

export interface PerfOverviewResult {
  /** 数据来源与覆盖范围必须显式给出（卡内：样本窗口与覆盖范围必须显示）。 */
  coverage: {
    /** 过滤前总样本数。 */
    totalSampleCount: number;
    /** 命中时间窗与范围的样本数。 */
    matchedSampleCount: number;
    windowStartIso: string | null;
    windowEndIso: string | null;
    missionIdentifier: string | null;
    /** 因无法解析而被丢弃的行数（不静默当零）。 */
    discardedLineCount: number;
  };
  metrics: PerfAggregateMetrics;
  /** 摘要模式为 null；明细模式为分页结果。 */
  page: PerfSamplePage | null;
  alerts: PerfAlert[];
  /** 内存保留有界性的可观测证据：内存中保留的样本数。 */
  retainedInMemorySampleCount: number;
}

/**
 * 受控只读概览查询（PERF-01-03，卡内 §2："查询性能…支持范围、时间窗口、分页和摘要/详情"）。
 *
 * 纪律：
 *  - **只读**：只读取已落盘样本并做纯函数复算，**不发起任何 Provider/业务请求**；
 *  - 范围与时间窗必须真实生效，且覆盖范围必须回显（不得让调用方误以为看的是全量）；
 *  - **无法测量不报零**：无样本时 metrics.mean 为 null 并给出不可报告原因；
 *  - 长会话内存有界：只读文件、不把全量样本堆进内存（分页切片即可）。
 */
export async function queryPerfOverview(input: {
  store: PerfEventStore;
  query?: PerfOverviewQuery;
}): Promise<PerfOverviewResult> {
  const query = input.query ?? {};
  const integrity = await input.store.readWithIntegrity();

  const matchWindowStartMilliseconds =
    query.windowStartIso === undefined || query.windowStartIso === null
      ? null
      : Date.parse(query.windowStartIso);
  const matchWindowEndMilliseconds =
    query.windowEndIso === undefined || query.windowEndIso === null
      ? null
      : Date.parse(query.windowEndIso);

  const matchedSamples = integrity.samples.filter((sample) => {
    if (
      query.missionIdentifier !== undefined &&
      query.missionIdentifier !== null &&
      sample.missionIdentifier !== query.missionIdentifier
    ) {
      return false;
    }
    const recordedAtMilliseconds = Date.parse(sample.recordedAtIso);
    if (Number.isNaN(recordedAtMilliseconds)) {
      return false;
    }
    if (
      matchWindowStartMilliseconds !== null &&
      !Number.isNaN(matchWindowStartMilliseconds) &&
      recordedAtMilliseconds < matchWindowStartMilliseconds
    ) {
      return false;
    }
    if (
      matchWindowEndMilliseconds !== null &&
      !Number.isNaN(matchWindowEndMilliseconds) &&
      recordedAtMilliseconds > matchWindowEndMilliseconds
    ) {
      return false;
    }
    return true;
  });

  const metrics = aggregatePerfSamples(matchedSamples);
  const detailLevel = query.detailLevel ?? "summary";
  const page =
    detailLevel === "detail"
      ? paginatePerfSamples({
          samples: matchedSamples,
          pageSize: query.pageSize ?? 20,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        })
      : null;

  return {
    coverage: {
      totalSampleCount: integrity.samples.length,
      matchedSampleCount: matchedSamples.length,
      windowStartIso: metrics.windowStartIso,
      windowEndIso: metrics.windowEndIso,
      missionIdentifier: query.missionIdentifier ?? null,
      discardedLineCount: integrity.discardedLineCount,
    },
    metrics,
    page,
    alerts: derivePerfAlerts({
      metrics,
      overflowReport: input.store.getOverflowReport(),
    }),
    retainedInMemorySampleCount: input.store.getRetainedInMemorySampleCount(),
  };
}

export type PerfAlertKind =
  | "monitor-overflow"
  | "monitor-unmeasurable"
  | "clock-anomaly"
  | "high-failure-ratio"
  | "all-normal";

export interface PerfAlert {
  alertKind: PerfAlertKind;
  severity: "info" | "warning" | "error";
  detail: string;
}

/**
 * 告警/降级推导（反例③⑤⑧）。
 *
 * 关键纪律：**不得把"无法测量"表达为"一切正常"**。只要监测侧不可用、被截断或溢出一律告警；
 * 只有确实有可报告样本且无异常时才给出 all-normal。
 */
export function derivePerfAlerts(input: {
  metrics: PerfAggregateMetrics | null;
  overflowReport: PerfOverflowReport;
  measurementFailureReason?: string;
  failureRatioWarningThreshold?: number;
}): PerfAlert[] {
  const alerts: PerfAlert[] = [];

  if (input.measurementFailureReason !== undefined && input.measurementFailureReason !== "") {
    alerts.push({
      alertKind: "monitor-unmeasurable",
      severity: "warning",
      detail: "监测不可用（显示降级，不得视为一切正常）：" + input.measurementFailureReason,
    });
  }
  if (input.overflowReport.isOverflowed) {
    alerts.push({
      alertKind: "monitor-overflow",
      severity: "warning",
      detail:
        "监测样本溢出：已丢弃 " +
        String(input.overflowReport.droppedSampleCount) +
        " 个样本（内存保留上限）；结论基于部分样本",
    });
  }
  if (input.metrics === null) {
    // 指标缺失本身就是不可测量；不得落入 all-normal。
    if (!alerts.some((alert) => alert.alertKind === "monitor-unmeasurable")) {
      alerts.push({
        alertKind: "monitor-unmeasurable",
        severity: "warning",
        detail: "监测不可用（无指标可用）：不得视为一切正常",
      });
    }
    return alerts;
  }
  if (input.metrics.hasClockAnomaly) {
    alerts.push({
      alertKind: "clock-anomaly",
      severity: "warning",
      detail: "检测到事件时间倒退：时间窗与耗时结论需谨慎解读",
    });
  }
  const warningThreshold = input.failureRatioWarningThreshold ?? 0.5;
  if (input.metrics.sampleSize > 0) {
    const failureRatio = input.metrics.denominators.failureCount / input.metrics.sampleSize;
    if (failureRatio >= warningThreshold) {
      alerts.push({
        alertKind: "high-failure-ratio",
        severity: "error",
        detail:
          "失败占比 " +
          (failureRatio * 100).toFixed(1) +
          "%（样本 " +
          String(input.metrics.sampleSize) +
          "）",
      });
    }
  }
  if (alerts.length === 0) {
    alerts.push({
      alertKind: "all-normal",
      severity: "info",
      detail: "本窗口内监测指标正常（样本 " + String(input.metrics.sampleSize) + "）",
    });
  }
  return alerts;
}
