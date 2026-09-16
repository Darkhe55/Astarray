/**
 * ACCURACY-03：档位/预算/跳过状态的本地设置存储、跨进程幂等日志与完成校验门。
 *
 * 硬规则（见 docs/adr/0040-accuracy-tiers-budget-and-skip-status.md）：
 * - 设置只允许认证用户修改；**Agent 不得自行降级或关闭**（拒绝并记录原因）；
 * - 关闭后不新增模型审查与人工阻塞，返回独立的 `quality-check-skipped`（原因 `accuracy-disabled`）；
 * - 标准/严格档的模型审查次数与墙钟时间有上界，耗尽记 `quality-check-budget-exhausted`（不是通过）；
 * - 幂等日志落盘，跨进程/重启仍能识别重复派发。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import {
  ACCURACY_TIERS,
  TaskAccuracyVerifier,
  type AcceptanceEntry,
  type AccuracyTier,
  type AccuracyVerificationResult,
  type CompletionDeclaration,
  type EvidenceReference,
} from "../orchestration/task-accuracy-verifier.js";

export const ACCURACY_POLICY_SCHEMA_VERSION = 1;
export const DEFAULT_ACCURACY_BUDGET = {
  maximumModelCallCount: 4,
  maximumWallClockMilliseconds: 120_000,
} as const;

export interface AccuracyBudget {
  maximumModelCallCount: number;
  maximumWallClockMilliseconds: number;
}

export interface AccuracyPolicy {
  schemaVersion: 1;
  isEnabled: boolean;
  tier: AccuracyTier;
  budget: AccuracyBudget;
  taskTierOverrides: Record<string, AccuracyTier>;
  revision: number;
  updatedByUserId: string;
  updatedAtIso: string;
}

export type AccuracyPolicyErrorCode =
  | "accuracy-tier-downgrade-rejected"
  | "accuracy-policy-stale-revision"
  | "accuracy-policy-invalid";

export class AccuracyPolicyError extends Error {
  constructor(
    readonly errorCode: AccuracyPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccuracyPolicyError";
  }
}

const TIER_ORDER: Record<AccuracyTier, number> = {
  fast: 0,
  standard: 1,
  strict: 2,
};

export class AccuracyPolicyStore {
  private readonly filePath: string;

  constructor(private readonly options: {
    baseDirectory: string;
    nowIso?: () => string;
  }) {
    this.filePath = path.join(options.baseDirectory, "settings", "accuracy.json");
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  buildDefaultPolicy(): AccuracyPolicy {
    return {
      schemaVersion: ACCURACY_POLICY_SCHEMA_VERSION,
      isEnabled: true,
      tier: "standard",
      budget: { ...DEFAULT_ACCURACY_BUDGET },
      taskTierOverrides: {},
      revision: 1,
      updatedByUserId: "system-default",
      updatedAtIso: this.nowIso(),
    };
  }

  async readPolicy(): Promise<AccuracyPolicy> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(rawContent) as AccuracyPolicy;
      if (
        parsed.schemaVersion === ACCURACY_POLICY_SCHEMA_VERSION &&
        ACCURACY_TIERS.includes(parsed.tier)
      ) {
        return parsed;
      }
    } catch {
      // 缺失或损坏：返回默认策略（不静默覆盖他人设置，写入时才重建）。
    }
    return this.buildDefaultPolicy();
  }

  /**
   * 认证用户配置策略；Agent（`requestingAgentInstanceId` 非空）不得降级或关闭。
   */
  async configurePolicy(input: {
    tier?: AccuracyTier;
    isEnabled?: boolean;
    budget?: Partial<AccuracyBudget>;
    taskTierOverrides?: Record<string, AccuracyTier>;
    expectedRevision: number;
    updatedByUserId: string;
    requestingAgentInstanceId?: string | null;
  }): Promise<AccuracyPolicy> {
    const current = await this.readPolicy();
    if (current.revision !== input.expectedRevision) {
      throw new AccuracyPolicyError(
        "accuracy-policy-stale-revision",
        "准确性策略 revision 不匹配: 期望 " +
          String(input.expectedRevision) +
          "，现有 " +
          String(current.revision),
      );
    }
    const isAgentRequester =
      input.requestingAgentInstanceId !== undefined &&
      input.requestingAgentInstanceId !== null &&
      input.requestingAgentInstanceId !== "";
    if (isAgentRequester) {
      const isDowngrade =
        (input.tier !== undefined && TIER_ORDER[input.tier] < TIER_ORDER[current.tier]) ||
        input.isEnabled === false;
      if (isDowngrade) {
        throw new AccuracyPolicyError(
          "accuracy-tier-downgrade-rejected",
          "Agent 不得自行降级或关闭准确性检查（仅认证用户可配置）",
        );
      }
    }

    const next: AccuracyPolicy = {
      schemaVersion: ACCURACY_POLICY_SCHEMA_VERSION,
      isEnabled: input.isEnabled ?? current.isEnabled,
      tier: input.tier ?? current.tier,
      budget: {
        maximumModelCallCount:
          input.budget?.maximumModelCallCount ??
          current.budget.maximumModelCallCount,
        maximumWallClockMilliseconds:
          input.budget?.maximumWallClockMilliseconds ??
          current.budget.maximumWallClockMilliseconds,
      },
      taskTierOverrides: {
        ...current.taskTierOverrides,
        ...(input.taskTierOverrides ?? {}),
      },
      revision: current.revision + 1,
      updatedByUserId: input.updatedByUserId,
      updatedAtIso: this.nowIso(),
    };
    if (
      !Number.isInteger(next.budget.maximumModelCallCount) ||
      next.budget.maximumModelCallCount < 0 ||
      !Number.isInteger(next.budget.maximumWallClockMilliseconds) ||
      next.budget.maximumWallClockMilliseconds < 0
    ) {
      throw new AccuracyPolicyError(
        "accuracy-policy-invalid",
        "准确性检查预算必须为非负整数",
      );
    }
    await writeAtomicJson(this.filePath, next);
    return next;
  }
}

export function resolveAccuracyTier(
  policy: AccuracyPolicy,
  taskIdentifier: string,
): AccuracyTier {
  return policy.taskTierOverrides[taskIdentifier] ?? policy.tier;
}

/** 跨进程幂等日志（`<state>/accuracy/attempts.json`）。 */
export class FileAccuracyAttemptJournal {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "accuracy", "attempts.json");
  }

  private async readAllInternal(): Promise<Record<string, AccuracyVerificationResult>> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(rawContent) as {
        schemaVersion: number;
        resultsByAttemptId: Record<string, AccuracyVerificationResult>;
      };
      if (parsed.schemaVersion === 1 && typeof parsed.resultsByAttemptId === "object") {
        return parsed.resultsByAttemptId;
      }
    } catch {
      // 缺失或损坏：视为空日志。
    }
    return {};
  }

  async findProcessedAttempt(
    completionAttemptId: string,
  ): Promise<AccuracyVerificationResult | null> {
    const results = await this.readAllInternal();
    const result = results[completionAttemptId];
    return result === undefined ? null : { ...result };
  }

  async recordProcessedAttempt(
    completionAttemptId: string,
    result: AccuracyVerificationResult,
  ): Promise<void> {
    const results = await this.readAllInternal();
    results[completionAttemptId] = { ...result };
    await writeAtomicJson(this.filePath, {
      schemaVersion: 1,
      resultsByAttemptId: results,
    });
  }

  async size(): Promise<number> {
    return Object.keys(await this.readAllInternal()).length;
  }
}

export interface AccuracyBudgetState {
  taskIdentifier: string;
  consumedModelCallCount: number;
  startedAtIso: string;
}

export class AccuracyBudgetTracker {
  private readonly statesByTaskIdentifier = new Map<string, AccuracyBudgetState>();

  constructor(private readonly policy: AccuracyPolicy) {}

  tryConsumeModelCall(input: {
    taskIdentifier: string;
    nowIso: string;
  }): {
    isAllowed: boolean;
    status: "within-budget" | "quality-check-budget-exhausted";
    consumedModelCallCount: number;
    maximumModelCallCount: number;
  } {
    const state =
      this.statesByTaskIdentifier.get(input.taskIdentifier) ??
      {
        taskIdentifier: input.taskIdentifier,
        consumedModelCallCount: 0,
        startedAtIso: input.nowIso,
      };
    this.statesByTaskIdentifier.set(input.taskIdentifier, state);
    const elapsedMilliseconds =
      Date.parse(input.nowIso) - Date.parse(state.startedAtIso);
    if (elapsedMilliseconds > this.policy.budget.maximumWallClockMilliseconds) {
      return {
        isAllowed: false,
        status: "quality-check-budget-exhausted",
        consumedModelCallCount: state.consumedModelCallCount,
        maximumModelCallCount: this.policy.budget.maximumModelCallCount,
      };
    }
    if (state.consumedModelCallCount >= this.policy.budget.maximumModelCallCount) {
      return {
        isAllowed: false,
        status: "quality-check-budget-exhausted",
        consumedModelCallCount: state.consumedModelCallCount,
        maximumModelCallCount: this.policy.budget.maximumModelCallCount,
      };
    }
    state.consumedModelCallCount += 1;
    return {
      isAllowed: true,
      status: "within-budget",
      consumedModelCallCount: state.consumedModelCallCount,
      maximumModelCallCount: this.policy.budget.maximumModelCallCount,
    };
  }

  readState(taskIdentifier: string): AccuracyBudgetState | null {
    const state = this.statesByTaskIdentifier.get(taskIdentifier);
    return state === undefined ? null : { ...state };
  }

  /** 采纳既有预算状态（策略 revision 变化后重建 tracker 时保持累计消耗）。 */
  adoptState(state: AccuracyBudgetState, taskIdentifier: string): void {
    this.statesByTaskIdentifier.set(taskIdentifier, { ...state });
  }
}

export interface AccuracyVerificationAuditPort {
  append(record: AccuracyVerificationAuditRecord): Promise<void>;
  readAll?(): Promise<AccuracyVerificationAuditRecord[]>;
}

export interface AccuracyCompletionVerification {
  verdict: "accepted" | "rejected" | "quality-check-skipped";
  tier: AccuracyTier;
  isSkipped: boolean;
  skipReason: "accuracy-disabled" | "tier-fast" | null;
  budgetStatus: "within-budget" | "quality-check-budget-exhausted";
  reasons: string[];
  verification: AccuracyVerificationResult | null;
}

export interface AccuracyCompletionGatePorts {
  getAcceptanceEntries(taskIdentifier: string): Promise<AcceptanceEntry[]>;
  getCurrentTaskSequenceRevision(taskIdentifier: string): Promise<number>;
  getExpectedRecipientIdentifier(taskIdentifier: string): Promise<string>;
  getArtifactRevision(evidence: EvidenceReference): Promise<number | null>;
  isClarificationRequired(taskIdentifier: string): Promise<boolean>;
}

export interface AccuracyVerificationAuditRecord {
  taskIdentifier: string;
  completionAttemptId: string;
  tier: AccuracyTier;
  verdict: "accepted" | "rejected" | "quality-check-skipped";
  skipReason: "accuracy-disabled" | "tier-fast" | null;
  budgetStatus: "within-budget" | "quality-check-budget-exhausted";
  /** 本次校验是否真的发起了模型审查（关闭/预算耗尽时必须为 false）。 */
  isVerificationLayerInvoked: boolean;
  observedAtIso: string;
}

/** 逐次校验审计日志（`<state>/accuracy/verification-audit.jsonl`）：用于证明关闭时不新增模型审查。 */
export class FileAccuracyVerificationAuditLog {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "accuracy", "verification-audit.jsonl");
  }

  async append(record: AccuracyVerificationAuditRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }

  async readAll(): Promise<AccuracyVerificationAuditRecord[]> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      return rawContent
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AccuracyVerificationAuditRecord);
    } catch {
      return [];
    }
  }
}

export interface AccuracyCompletionGatePorts {
  getAcceptanceEntries(taskIdentifier: string): Promise<AcceptanceEntry[]>;
  getCurrentTaskSequenceRevision(taskIdentifier: string): Promise<number>;
  getExpectedRecipientIdentifier(taskIdentifier: string): Promise<string>;
  getArtifactRevision(evidence: EvidenceReference): Promise<number | null>;
  isClarificationRequired(taskIdentifier: string): Promise<boolean>;
}

/** 组合校验门：策略（关闭/档位）→ 预算 → ACCURACY-02 校验层；预算与审计在实例内持久。 */
export class AccuracyCompletionGate {
  private readonly budgetStatesByTaskIdentifier = new Map<string, AccuracyBudgetState>();
  private budgetTracker: AccuracyBudgetTracker | null = null;
  private budgetTrackerPolicyRevision: number | null = null;

  constructor(private readonly options: {
    policyStore: AccuracyPolicyStore;
    journal: {
      findProcessedAttempt(
        completionAttemptId: string,
      ): Promise<AccuracyVerificationResult | null>;
      recordProcessedAttempt(
        completionAttemptId: string,
        result: AccuracyVerificationResult,
      ): Promise<void>;
    };
    ports: AccuracyCompletionGatePorts;
    auditLog?: AccuracyVerificationAuditPort;
    nowIso?: () => string;
  }) {}

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  private async readBudgetTracker(policy: AccuracyPolicy): Promise<AccuracyBudgetTracker> {
    if (
      this.budgetTracker === null ||
      this.budgetTrackerPolicyRevision !== policy.revision
    ) {
      const tracker = new AccuracyBudgetTracker(policy);
      for (const [taskIdentifier, state] of this.budgetStatesByTaskIdentifier) {
        tracker.adoptState(state, taskIdentifier);
      }
      this.budgetTracker = tracker;
      this.budgetTrackerPolicyRevision = policy.revision;
    }
    return this.budgetTracker;
  }

  private rememberBudgetState(taskIdentifier: string): void {
    const state = this.budgetTracker?.readState(taskIdentifier) ?? null;
    if (state !== null) {
      this.budgetStatesByTaskIdentifier.set(taskIdentifier, state);
    }
  }

  private async recordAudit(record: AccuracyVerificationAuditRecord): Promise<void> {
    await this.options.auditLog?.append(record);
  }

  /**
   * 组合校验：策略（关闭/档位）→ 预算 → 既有校验层。
   * 关闭时**不调用任何模型审查端口**，返回独立跳过状态。
   */
  async verifyCompletion(input: {
    declaration: CompletionDeclaration;
  }): Promise<AccuracyCompletionVerification> {
    const policy = await this.options.policyStore.readPolicy();
    const tier = resolveAccuracyTier(policy, input.declaration.taskIdentifier);
    const observedAtIso = this.nowIso();

    if (!policy.isEnabled) {
      const verification: AccuracyCompletionVerification = {
        verdict: "quality-check-skipped",
        tier,
        isSkipped: true,
        skipReason: "accuracy-disabled",
        budgetStatus: "within-budget",
        reasons: [
          "quality-check-skipped(accuracy-disabled): 准确性检查已关闭，不新增模型审查或人工阻塞（不等于测试/验收通过）",
        ],
        verification: null,
      };
      await this.recordAudit({
        taskIdentifier: input.declaration.taskIdentifier,
        completionAttemptId: input.declaration.completionAttemptId,
        tier,
        verdict: verification.verdict,
        skipReason: verification.skipReason,
        budgetStatus: verification.budgetStatus,
        isVerificationLayerInvoked: false,
        observedAtIso,
      });
      return verification;
    }

    // 幂等重放：命中既有结论则直接返回，不消耗预算、不再次发起校验层。
    const processed = await this.options.journal.findProcessedAttempt(
      input.declaration.completionAttemptId,
    );
    if (processed !== null) {
      const verification: AccuracyVerificationResult = {
        ...processed,
        isIdempotentReplay: true,
      };
      const composed: AccuracyCompletionVerification = {
        verdict: verification.verdict,
        tier: verification.tier,
        isSkipped: verification.verdict === "quality-check-skipped",
        skipReason:
          verification.verdict === "quality-check-skipped"
            ? verification.tier === "fast"
              ? "tier-fast"
              : null
            : null,
        budgetStatus: "within-budget",
        reasons: [...verification.reasons],
        verification,
      };
      await this.recordAudit({
        taskIdentifier: input.declaration.taskIdentifier,
        completionAttemptId: input.declaration.completionAttemptId,
        tier: composed.tier,
        verdict: composed.verdict,
        skipReason: composed.skipReason,
        budgetStatus: composed.budgetStatus,
        isVerificationLayerInvoked: false,
        observedAtIso,
      });
      return composed;
    }

    const budgetTracker = await this.readBudgetTracker(policy);
    if (budgetTracker.readState(input.declaration.taskIdentifier) === null) {
      // 跨进程累计：已发生的模型审查次数从审计日志恢复（关闭/跳过期间不计入）。
      const priorRecords = await this.readVerificationAudit();
      const priorModelReviewCount = priorRecords.filter(
        (record) =>
          record.taskIdentifier === input.declaration.taskIdentifier &&
          record.isVerificationLayerInvoked,
      ).length;
      budgetTracker.adoptState(
        {
          taskIdentifier: input.declaration.taskIdentifier,
          consumedModelCallCount: priorModelReviewCount,
          startedAtIso: observedAtIso,
        },
        input.declaration.taskIdentifier,
      );
    }
    const budget = budgetTracker.tryConsumeModelCall({
      taskIdentifier: input.declaration.taskIdentifier,
      nowIso: observedAtIso,
    });
    this.rememberBudgetState(input.declaration.taskIdentifier);
    if (!budget.isAllowed) {
      const verification: AccuracyCompletionVerification = {
        verdict: "quality-check-skipped",
        tier,
        isSkipped: true,
        skipReason: null,
        budgetStatus: "quality-check-budget-exhausted",
        reasons: [
          "quality-check-budget-exhausted: 检查预算耗尽（" +
            String(budget.consumedModelCallCount) +
            "/" +
            String(budget.maximumModelCallCount) +
            "），记录检查不足而不是通过",
        ],
        verification: null,
      };
      await this.recordAudit({
        taskIdentifier: input.declaration.taskIdentifier,
        completionAttemptId: input.declaration.completionAttemptId,
        tier,
        verdict: verification.verdict,
        skipReason: verification.skipReason,
        budgetStatus: verification.budgetStatus,
        isVerificationLayerInvoked: false,
        observedAtIso,
      });
      return verification;
    }

    const verifier = new TaskAccuracyVerifier({
      getCurrentTaskSequenceRevision: (taskIdentifier) =>
        this.options.ports.getCurrentTaskSequenceRevision(taskIdentifier),
      getRequiredAcceptanceEntries: (taskIdentifier) =>
        this.options.ports.getAcceptanceEntries(taskIdentifier),
      getArtifactRevision: (evidence) => this.options.ports.getArtifactRevision(evidence),
      getExpectedRecipientIdentifier: (taskIdentifier) =>
        this.options.ports.getExpectedRecipientIdentifier(taskIdentifier),
      getTier: async () => tier,
      isClarificationRequired: (taskIdentifier) =>
        this.options.ports.isClarificationRequired(taskIdentifier),
      findProcessedAttempt: (attemptId) =>
        this.options.journal.findProcessedAttempt(attemptId),
      recordProcessedAttempt: (attemptId, result) =>
        this.options.journal.recordProcessedAttempt(attemptId, result),
    });
    const verification = await verifier.verifyCompletion(input.declaration);
    const composed: AccuracyCompletionVerification = {
      verdict: verification.verdict,
      tier,
      isSkipped: verification.verdict === "quality-check-skipped",
      skipReason: verification.verdict === "quality-check-skipped" ? "tier-fast" : null,
      budgetStatus: "within-budget",
      reasons: verification.reasons,
      verification,
    };
    await this.recordAudit({
      taskIdentifier: input.declaration.taskIdentifier,
      completionAttemptId: input.declaration.completionAttemptId,
      tier,
      verdict: composed.verdict,
      skipReason: composed.skipReason,
      budgetStatus: composed.budgetStatus,
      isVerificationLayerInvoked: true,
      observedAtIso,
    });
    return composed;
  }

  async readVerificationAudit(): Promise<AccuracyVerificationAuditRecord[]> {
    const auditLog = this.options.auditLog;
    if (auditLog?.readAll === undefined) {
      return [];
    }
    return auditLog.readAll();
  }
}