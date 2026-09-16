/**
 * GUIDE-01-02：运行中指导的控制队列与安全点应用。
 *
 * - 控制队列与普通报告是**两条独立通道**：两者都**不唤醒主 Agent**；
 *   控制队列由正在运行的任务在安全点即时消费（不等整链结束），普通报告仅排队待读。
 * - 同一条指导（id + revision）只应用一次（幂等）；过期/跨作用域在安全点被丢弃并给出原因。
 * - 跨进程投递复用独立反馈进程的信封（`instruction` / `success`），
 *   桥接只负责投递，不做任何权限或作用域判断（判断在本队列）。
 */
import { randomUUID } from "node:crypto";

import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";
import type { FeedbackMessage, FeedbackMessageSource } from "../core/types.js";
import {
  RuntimeGuidanceController,
  type GuidanceSourceRegistry,
  type GuidanceAcceptanceResult,
  type GuidanceScopeTarget,
  type RuntimeGuidanceEvent,
} from "./runtime-guidance.js";

export const GUIDANCE_SAFE_POINT_KINDS = [
  "before-model-call",
  "before-tool-execution",
] as const;
export type GuidanceSafePointKind = (typeof GUIDANCE_SAFE_POINT_KINDS)[number];

export interface AppliedGuidance {
  guidanceIdentifier: string;
  guidanceRevision: number;
  behaviorTier: RuntimeGuidanceEvent["behaviorTier"];
  instructionText: string;
  appliedAtSafePoint: GuidanceSafePointKind;
}

export interface DroppedGuidance {
  guidanceIdentifier: string;
  guidanceRevision: number;
  reason: "expired-at-safe-point" | "cross-scope-at-safe-point";
}

export interface SafePointConsumption {
  applied: AppliedGuidance[];
  dropped: DroppedGuidance[];
}

export interface PlainReport {
  reportIdentifier: string;
  recipientId: string;
  sourceIdentifier: string;
  summary: string;
  queuedAtIso: string;
  /** 普通报告永不唤醒主 Agent；只排队等待按需读取。 */
  shouldWakeMainAgent: false;
}

export interface GuidanceWakePolicy {
  lane: "control" | "report";
  wakesMainAgent: false;
  isAppliedToRunningMissionAtSafePoint: boolean;
  isQueuedOnly: boolean;
}

export function evaluateWakePolicy(lane: "control" | "report"): GuidanceWakePolicy {
  return lane === "control"
    ? {
        lane,
        wakesMainAgent: false,
        isAppliedToRunningMissionAtSafePoint: true,
        isQueuedOnly: false,
      }
    : {
        lane,
        wakesMainAgent: false,
        isAppliedToRunningMissionAtSafePoint: false,
        isQueuedOnly: true,
      };
}

interface PendingGuidance {
  event: RuntimeGuidanceEvent;
  target: GuidanceScopeTarget;
}

function guidanceKey(event: RuntimeGuidanceEvent): string {
  return event.guidanceIdentifier + "@" + String(event.guidanceRevision);
}

function isSameScope(
  scope: RuntimeGuidanceEvent["scope"],
  target: GuidanceScopeTarget,
): boolean {
  return (
    scope.missionIdentifier === target.missionIdentifier &&
    (scope.taskIdentifier ?? null) === (target.taskIdentifier ?? null) &&
    (scope.resourceIdentifier ?? null) === (target.resourceIdentifier ?? null)
  );
}

export class GuidanceControlQueue {
  private readonly controller: RuntimeGuidanceController;
  private readonly pending = new Map<string, PendingGuidance>();
  private readonly applied = new Map<string, AppliedGuidance>();
  private readonly reports: PlainReport[] = [];

  constructor(private readonly options: {
    sourceRegistry: GuidanceSourceRegistry;
    nowIso?: () => string;
  }) {
    this.controller = new RuntimeGuidanceController(options.sourceRegistry);
  }

  get guidanceController(): RuntimeGuidanceController {
    return this.controller;
  }

  /** 控制队列投递（校验在 GUIDE-01-01 控制器内完成；拒绝不产生副作用）。 */
  enqueueControlGuidance(input: {
    event: RuntimeGuidanceEvent;
    target: GuidanceScopeTarget;
    nowIso: string;
  }): GuidanceAcceptanceResult {
    const result = this.controller.acceptGuidance(input);
    if (result.status !== "rejected" && result.behaviorTier !== "record-only") {
      this.pending.set(guidanceKey(input.event), {
        event: input.event,
        target: input.target,
      });
    }
    return result;
  }

  /** 普通报告通道：只排队，永不唤醒主 Agent。 */
  enqueueOrdinaryReport(input: {
    reportIdentifier: string;
    recipientId: string;
    sourceIdentifier: string;
    summary: string;
  }): PlainReport {
    const report: PlainReport = {
      reportIdentifier: input.reportIdentifier,
      recipientId: input.recipientId,
      sourceIdentifier: input.sourceIdentifier,
      summary: input.summary,
      queuedAtIso: this.options.nowIso?.() ?? new Date().toISOString(),
      shouldWakeMainAgent: false,
    };
    this.reports.push(report);
    return { ...report };
  }

  /**
   * 安全点消费：busy 期间即可应用（不等整链结束）。
   * 过期/跨作用域在消费点丢弃并给出原因，绝不套用到别的任务。
   */
  consumeAtSafePoint(input: {
    safePointKind: GuidanceSafePointKind;
    target: GuidanceScopeTarget;
    nowIso: string;
  }): SafePointConsumption {
    const applied: AppliedGuidance[] = [];
    const dropped: DroppedGuidance[] = [];
    for (const [key, entry] of [...this.pending.entries()]) {
      if (this.applied.has(key)) {
        this.pending.delete(key);
        continue;
      }
      if (!isSameScope(entry.event.scope, input.target)) {
        dropped.push({
          guidanceIdentifier: entry.event.guidanceIdentifier,
          guidanceRevision: entry.event.guidanceRevision,
          reason: "cross-scope-at-safe-point",
        });
        this.pending.delete(key);
        continue;
      }
      if (
        entry.event.expiresAtIso !== null &&
        Date.parse(input.nowIso) > Date.parse(entry.event.expiresAtIso)
      ) {
        dropped.push({
          guidanceIdentifier: entry.event.guidanceIdentifier,
          guidanceRevision: entry.event.guidanceRevision,
          reason: "expired-at-safe-point",
        });
        this.pending.delete(key);
        continue;
      }
      const application: AppliedGuidance = {
        guidanceIdentifier: entry.event.guidanceIdentifier,
        guidanceRevision: entry.event.guidanceRevision,
        behaviorTier: entry.event.behaviorTier,
        instructionText: entry.event.instructionText,
        appliedAtSafePoint: input.safePointKind,
      };
      this.applied.set(key, application);
      this.pending.delete(key);
      applied.push(application);
    }
    return { applied, dropped };
  }

  listPendingGuidance(): Array<{
    guidanceIdentifier: string;
    guidanceRevision: number;
    behaviorTier: RuntimeGuidanceEvent["behaviorTier"];
  }> {
    return [...this.pending.values()].map((entry) => ({
      guidanceIdentifier: entry.event.guidanceIdentifier,
      guidanceRevision: entry.event.guidanceRevision,
      behaviorTier: entry.event.behaviorTier,
    }));
  }

  listAppliedGuidance(): AppliedGuidance[] {
    return [...this.applied.values()].map((application) => ({ ...application }));
  }

  listPlainReports(): PlainReport[] {
    return this.reports.map((report) => ({ ...report }));
  }

  readWakePolicy(): { control: GuidanceWakePolicy; report: GuidanceWakePolicy } {
    return {
      control: evaluateWakePolicy("control"),
      report: evaluateWakePolicy("report"),
    };
  }
}

export interface GuidanceFeedbackLanePublisher {
  publishAppliedGuidance(application: AppliedGuidance): Promise<void>;
  publishPlainReport(report: PlainReport): Promise<void>;
}

/**
 * 跨进程投递桥：把已应用的指导与普通报告封装为独立反馈进程信封
 * （`instruction` / `success`）。桥接不做权限/作用域判断，也不唤醒主 Agent。
 */
export function createGuidanceFeedbackLanePublisher(input: {
  transport: { enqueue(message: FeedbackMessage): Promise<void> };
  recipientId: string;
  source: FeedbackMessageSource;
  nowIso?: () => string;
}): GuidanceFeedbackLanePublisher {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  return {
    async publishAppliedGuidance(application: AppliedGuidance): Promise<void> {
      await input.transport.enqueue({
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: randomUUID(),
        source: input.source,
        recipientId: input.recipientId,
        priority: "instruction",
        createdAtIso: nowIso(),
        idempotencyKey:
          "guidance:" +
          application.guidanceIdentifier +
          "@" +
          String(application.guidanceRevision),
        payload: {
          kind: "instruction",
          instructionText: application.instructionText,
        },
      });
    },
    async publishPlainReport(report: PlainReport): Promise<void> {
      await input.transport.enqueue({
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: randomUUID(),
        source: input.source,
        recipientId: input.recipientId,
        priority: "success",
        createdAtIso: nowIso(),
        idempotencyKey: "report:" + report.reportIdentifier,
        payload: { kind: "success", summary: report.summary },
      });
    },
  };
}
