/**
 * DIAG-01-02：错误的**持久汇总、分页、故障链与证据边界**（2026-10-02）。
 *
 * 契约来源：OBS-01-01 冻结的共享最小事件契约 §4.4（DIAG 事件）。
 *
 * 纪律（逐条对应反例）：
 *  ① 重复风暴：按**指纹**合并计数，明细保留有界并显式报告折叠；
 *  ② 敏感错误文本：落盘前脱敏（凭据样式绝不进入记录）；
 *  ③ 故障链：保留根因与包装码**顺序**，不只留最外层；
 *  ④ 不足证据：`insufficient-evidence` 与 `suspected-cause`、`deterministic-fact` 分开统计，
 *     不得把推断写成确定根因；
 *  ⑤ 诊断自身失败：报"不可测量"，**不得报一切正常**；
 *  ⑥ 首次/最近发生时间与影响范围（mission 集合）；
 *  ⑦ 分页稳定；
 *  ⑧ 纯函数可复算。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type DiagnosticEventClassification =
  | "deterministic-fact"
  | "suspected-cause"
  | "insufficient-evidence";

export interface DiagnosticEvent {
  observeEventVersion: 1;
  eventType: "diagnostic";
  recordedAtIso: string;
  sourceAgentInstanceId: string;
  missionIdentifier: string | null;
  taskIdentifier: string | null;
  requestIdentifier: string;
  requestRevision: number;
  origin: { kind: "provider" | "local-estimate" | "system" };
  /** 复用既有稳定 DomainErrorCode。 */
  errorCode: string;
  stage: "dispatch" | "provider" | "tool" | "git" | "recovery" | "config" | "unknown";
  severity: "info" | "warning" | "error";
  /** 组件标识（指纹的一部分；相同文本不保证同因）。 */
  component: string;
  /** 错误文本（落盘前脱敏）。 */
  messageText: string;
  recoveryState: "known-resolved" | "recovering" | "blocked-uncertain" | "unknown";
  classification: DiagnosticEventClassification;
  /** 故障链：根因 + 包装码顺序。 */
  chain: { rootErrorCode: string | null; wrapperErrorCodes: string[] };
}

export interface DiagnosticRetentionReport {
  detailedEventCount: number;
  maximumDetailedEventCount: number;
  isStormCollapsed: boolean;
  droppedDetailedEventCount: number;
}

const DIAGNOSTIC_FILE_NAME = "events.jsonl";

/**
 * 脱敏（反例②）：把常见凭据样式替换为 [REDACTED]。
 * 只做**文本级**替换，不改动错误码与结构；宁可多脱敏，不可漏泄。
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[REDACTED]")
    // 长随机串（≥32 位字母数字组合）按凭据处理
    .replace(/\b[A-Za-z0-9]{32,}\b/g, "[REDACTED]");
}

/** 指纹：错误码 + 组件 + 阶段（**相同文本不保证同因**，故文本不参与指纹）。 */
export function computeDiagnosticFingerprint(event: DiagnosticEvent): string {
  return [event.errorCode, event.component, event.stage].join("|");
}

export class DiagnosticEventStore {
  private readonly filePath: string;
  private readonly maximumDetailedEventCount: number;
  private droppedDetailedEventCount = 0;
  private writtenEventCount = 0;

  constructor(options: { baseDirectory: string; maximumDetailedEventCount?: number }) {
    this.filePath = path.join(options.baseDirectory, "diagnostics", DIAGNOSTIC_FILE_NAME);
    this.maximumDetailedEventCount = options.maximumDetailedEventCount ?? 1_000;
  }

  /** 追加一条诊断事件（落盘前脱敏；明细保留有界）。 */
  async append(event: DiagnosticEvent): Promise<void> {
    const redactedEvent: DiagnosticEvent = {
      ...event,
      messageText: redactSensitiveText(event.messageText),
      chain: {
        rootErrorCode: event.chain.rootErrorCode,
        wrapperErrorCodes: [...event.chain.wrapperErrorCodes],
      },
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(redactedEvent) + "\n", "utf8");
    this.writtenEventCount += 1;
    if (this.writtenEventCount > this.maximumDetailedEventCount) {
      // 明细保留有界（反例①）：超出部分只保留在汇总计数里，不静默丢弃证据。
      this.droppedDetailedEventCount += 1;
    }
  }

  async readAll(): Promise<DiagnosticEvent[]> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const events: DiagnosticEvent[] = [];
    for (const line of rawContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as DiagnosticEvent;
        if (parsed.eventType === "diagnostic" && typeof parsed.errorCode === "string") {
          events.push(parsed);
        }
      } catch {
        // 损坏行跳过（不阻塞其余错误记录）
      }
    }
    return events;
  }

  getRetentionReport(): DiagnosticRetentionReport {
    return {
      detailedEventCount: Math.min(this.writtenEventCount, this.maximumDetailedEventCount),
      maximumDetailedEventCount: this.maximumDetailedEventCount,
      isStormCollapsed: this.writtenEventCount > this.maximumDetailedEventCount,
      droppedDetailedEventCount: this.droppedDetailedEventCount,
    };
  }

  async readWithIntegrity(): Promise<{ events: DiagnosticEvent[]; discardedLineCount: number }> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch {
      return { events: [], discardedLineCount: 0 };
    }
    const events: DiagnosticEvent[] = [];
    let discardedLineCount = 0;
    for (const line of rawContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as DiagnosticEvent;
        if (parsed.eventType === "diagnostic" && typeof parsed.errorCode === "string") {
          events.push(parsed);
        } else {
          discardedLineCount += 1;
        }
      } catch {
        discardedLineCount += 1;
      }
    }
    return { events, discardedLineCount };
  }
}

export interface DiagnosticGroup {
  fingerprint: string;
  errorCode: string;
  component: string;
  stage: DiagnosticEvent["stage"];
  severity: DiagnosticEvent["severity"];
  classification: DiagnosticEventClassification;
  recoveryState: DiagnosticEvent["recoveryState"];
  occurrenceCount: number;
  firstOccurredAtIso: string;
  lastOccurredAtIso: string;
  impact: { missionIdentifiers: string[]; taskIdentifiers: string[] };
  chain: { rootErrorCode: string | null; wrapperErrorCodes: string[] };
  redactedSampleText: string;
}

export interface DiagnosticAggregateMetrics {
  eventCount: number;
  groups: DiagnosticGroup[];
  byClassification: Record<DiagnosticEventClassification, number>;
  byRecoveryState: Record<DiagnosticEvent["recoveryState"], number>;
  isReportable: boolean;
  unreportableReason: string | null;
  paginateGroups: (input: { pageSize: number; cursor?: string }) => {
    groups: DiagnosticGroup[];
    nextCursor: string | null;
  };
}

/**
 * 纯函数汇总（反例③④⑥⑧）：按指纹合并、保留首次/最近发生与影响范围、保留故障链。
 */
export function aggregateDiagnosticEvents(
  events: DiagnosticEvent[],
  options: { measurementFailureReason?: string } = {},
): DiagnosticAggregateMetrics {
  const byClassification: Record<DiagnosticEventClassification, number> = {
    "deterministic-fact": 0,
    "suspected-cause": 0,
    "insufficient-evidence": 0,
  };
  const byRecoveryState: Record<DiagnosticEvent["recoveryState"], number> = {
    "known-resolved": 0,
    recovering: 0,
    "blocked-uncertain": 0,
    unknown: 0,
  };
  const groupsByFingerprint = new Map<string, DiagnosticGroup>();

  for (const event of events) {
    byClassification[event.classification] += 1;
    byRecoveryState[event.recoveryState] += 1;
    const fingerprint = computeDiagnosticFingerprint(event);
    const existing = groupsByFingerprint.get(fingerprint);
    if (existing === undefined) {
      groupsByFingerprint.set(fingerprint, {
        fingerprint,
        errorCode: event.errorCode,
        component: event.component,
        stage: event.stage,
        severity: event.severity,
        classification: event.classification,
        recoveryState: event.recoveryState,
        occurrenceCount: 1,
        firstOccurredAtIso: event.recordedAtIso,
        lastOccurredAtIso: event.recordedAtIso,
        impact: {
          missionIdentifiers: event.missionIdentifier === null ? [] : [event.missionIdentifier],
          taskIdentifiers: event.taskIdentifier === null ? [] : [event.taskIdentifier],
        },
        chain: {
          rootErrorCode: event.chain.rootErrorCode,
          wrapperErrorCodes: [...event.chain.wrapperErrorCodes],
        },
        redactedSampleText: redactSensitiveText(event.messageText),
      });
      continue;
    }
    existing.occurrenceCount += 1;
    if (Date.parse(event.recordedAtIso) < Date.parse(existing.firstOccurredAtIso)) {
      existing.firstOccurredAtIso = event.recordedAtIso;
    }
    if (Date.parse(event.recordedAtIso) > Date.parse(existing.lastOccurredAtIso)) {
      existing.lastOccurredAtIso = event.recordedAtIso;
    }
    if (
      event.missionIdentifier !== null &&
      !existing.impact.missionIdentifiers.includes(event.missionIdentifier)
    ) {
      existing.impact.missionIdentifiers.push(event.missionIdentifier);
    }
    if (
      event.taskIdentifier !== null &&
      !existing.impact.taskIdentifiers.includes(event.taskIdentifier)
    ) {
      existing.impact.taskIdentifiers.push(event.taskIdentifier);
    }
  }

  const groups = [...groupsByFingerprint.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  const measurementFailureReason = options.measurementFailureReason;
  const isReportable = measurementFailureReason === undefined || measurementFailureReason === "";

  return {
    eventCount: events.length,
    groups,
    byClassification,
    byRecoveryState,
    isReportable,
    unreportableReason: isReportable
      ? null
      : "诊断不可测量（不得视为一切正常）：" + String(measurementFailureReason),
    paginateGroups: (input) => {
      const pageSize = Math.max(1, Math.floor(input.pageSize));
      let startIndex = 0;
      if (input.cursor !== undefined && input.cursor !== "") {
        const parsedCursor = Number.parseInt(input.cursor, 10);
        startIndex = Number.isNaN(parsedCursor) || parsedCursor < 0 ? 0 : parsedCursor;
      }
      if (startIndex >= groups.length) {
        return { groups: [], nextCursor: null };
      }
      const pageGroups = groups.slice(startIndex, startIndex + pageSize);
      const nextIndex = startIndex + pageGroups.length;
      return {
        groups: pageGroups,
        nextCursor: nextIndex < groups.length ? String(nextIndex) : null,
      };
    },
  };
}
