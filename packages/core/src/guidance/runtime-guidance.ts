/**
 * GUIDE-01-01：运行中指导的事件来源、作用域、sequence/有效期与取消能力契约。
 *
 * 三档行为：`record-only`（仅记录）、`safe-point-guidance`（安全点指导）、
 * `gate-and-request-pause`（立即门禁并请求暂停/取消；紧急仲裁属 EVENT-01）。
 *
 * 硬规则（见 docs/adr/0038-runtime-guidance-contract.md）：
 * - 来源必须在本地注册表内（伪造一律拒绝）；
 * - sequence 单调、revision 单调，重放只去重不重复应用；
 * - 作用域必须精确匹配目标（跨作用域拒绝），依赖传播必须显式；
 * - 指导派生任务只能层级 1 或更低：**紧急等级不得篡改 task priorityTier**；
 * - 不假定 Provider 支持在途插入；未知停止结果一律 blocked（GUIDE-01-03）。
 */
import { z } from "zod";

export const RUNTIME_GUIDANCE_SCHEMA_VERSION = 1;

export const GUIDANCE_SOURCE_KINDS = [
  "authenticated-user",
  "registered-local-tool",
  "file-task-observation",
] as const;
export type GuidanceSourceKind = (typeof GUIDANCE_SOURCE_KINDS)[number];

export const GUIDANCE_BEHAVIOR_TIERS = [
  "record-only",
  "safe-point-guidance",
  "gate-and-request-pause",
] as const;
export type GuidanceBehaviorTier = (typeof GUIDANCE_BEHAVIOR_TIERS)[number];

export const runtimeGuidanceEventSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_GUIDANCE_SCHEMA_VERSION),
    guidanceIdentifier: z.string().min(1),
    guidanceRevision: z.number().int().positive(),
    sequence: z.number().int().positive(),
    sourceKind: z.enum(GUIDANCE_SOURCE_KINDS),
    sourceIdentifier: z.string().min(1),
    issuedAtIso: z.iso.datetime(),
    expiresAtIso: z.iso.datetime().nullable(),
    behaviorTier: z.enum(GUIDANCE_BEHAVIOR_TIERS),
    scope: z
      .object({
        scopeKind: z.enum(["task", "resource"]),
        missionIdentifier: z.string().min(1),
        taskIdentifier: z.string().min(1).nullable(),
        resourceIdentifier: z.string().min(1).nullable(),
      })
      .strict(),
    instructionText: z.string().min(1),
    /**
     * 指导派生任务的优先级层级：契约要求 ≥1（用户层级 0 不可被指导占用）。
     * schema 允许 ≥0 以便控制器**显式报告** `priority-tier-tampering` 而不是解析期静默丢弃。
     */
    derivedTaskPriorityTier: z.number().int().min(0),
    /** 依赖传播必须显式声明，禁止隐式扩散到依赖任务。 */
    isDependencyPropagationExplicit: z.boolean(),
    cancellationCapability: z
      .object({
        canCancelAtSafePoint: z.boolean(),
        canCancelInFlight: z.literal(false),
        providerSupportsInFlightInsertion: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type RuntimeGuidanceEvent = z.infer<typeof runtimeGuidanceEventSchema>;

export type GuidanceRejectionReason =
  | "unregistered-source"
  | "behavior-tier-not-permitted"
  | "expired-guidance"
  | "out-of-order-sequence"
  | "stale-guidance-revision"
  | "cross-scope-application"
  | "implicit-dependency-propagation"
  | "priority-tier-tampering";

export type GuidanceAcceptanceStatus = "accepted" | "recorded" | "rejected";

export interface GuidanceAcceptanceResult {
  status: GuidanceAcceptanceStatus;
  behaviorTier: GuidanceBehaviorTier;
  guidanceIdentifier: string;
  guidanceRevision: number;
  reasons: GuidanceRejectionReason[];
  isDuplicateDelivery: boolean;
  supersededGuidanceIdentifiers: string[];
  /** 是否需要本地控制面在安全点应用（仅安全点/门禁档）。 */
  shouldApplyAtSafePoint: boolean;
  notes: string[];
}

export interface GuidanceSourceRegistration {
  sourceKind: GuidanceSourceKind;
  sourceIdentifier: string;
  /** 该来源允许的最高行为档（认证用户可到门禁档；工具/观察默认安全点档）。 */
  maximumBehaviorTier: GuidanceBehaviorTier;
  registeredAtIso: string;
}

export interface GuidanceScopeTarget {
  missionIdentifier: string;
  taskIdentifier?: string | null;
  resourceIdentifier?: string | null;
}

const BEHAVIOR_TIER_ORDER: Record<GuidanceBehaviorTier, number> = {
  "record-only": 0,
  "safe-point-guidance": 1,
  "gate-and-request-pause": 2,
};

/** 本地来源注册表：伪造来源在这里被拒绝。 */
export class GuidanceSourceRegistry {
  private readonly registrations = new Map<string, GuidanceSourceRegistration>();

  private key(sourceKind: GuidanceSourceKind, sourceIdentifier: string): string {
    return sourceKind + "|" + sourceIdentifier;
  }

  register(registration: GuidanceSourceRegistration): void {
    this.registrations.set(
      this.key(registration.sourceKind, registration.sourceIdentifier),
      { ...registration },
    );
  }

  unregister(sourceKind: GuidanceSourceKind, sourceIdentifier: string): void {
    this.registrations.delete(this.key(sourceKind, sourceIdentifier));
  }

  find(
    sourceKind: GuidanceSourceKind,
    sourceIdentifier: string,
  ): GuidanceSourceRegistration | null {
    const registration = this.registrations.get(this.key(sourceKind, sourceIdentifier));
    return registration === undefined ? null : { ...registration };
  }
}

interface GuidanceSourceState {
  lastSequence: number;
  latestRevisionByGuidanceIdentifier: Map<string, number>;
  appliedGuidanceRevisions: Set<string>;
}

export interface AcceptGuidanceInput {
  event: RuntimeGuidanceEvent;
  target: GuidanceScopeTarget;
  nowIso: string;
}

/**
 * 接收并校验一条运行中指导事件；返回是否接受/仅记录/拒绝及原因。
 * 任何拒绝都不得产生副作用（不排入控制队列、不改任务优先级）。
 */
export class RuntimeGuidanceController {
  private readonly stateBySource = new Map<string, GuidanceSourceState>();

  constructor(private readonly sourceRegistry: GuidanceSourceRegistry) {}

  private stateFor(event: RuntimeGuidanceEvent): GuidanceSourceState {
    const key = event.sourceKind + "|" + event.sourceIdentifier;
    const existing = this.stateBySource.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: GuidanceSourceState = {
      lastSequence: 0,
      latestRevisionByGuidanceIdentifier: new Map(),
      appliedGuidanceRevisions: new Set(),
    };
    this.stateBySource.set(key, created);
    return created;
  }

  acceptGuidance(input: AcceptGuidanceInput): GuidanceAcceptanceResult {
    const parsed = runtimeGuidanceEventSchema.parse(input.event);
    const rejectionReasons: GuidanceRejectionReason[] = [];

    const registration = this.sourceRegistry.find(
      parsed.sourceKind,
      parsed.sourceIdentifier,
    );
    if (registration === null) {
      rejectionReasons.push("unregistered-source");
    } else if (
      BEHAVIOR_TIER_ORDER[parsed.behaviorTier] >
      BEHAVIOR_TIER_ORDER[registration.maximumBehaviorTier]
    ) {
      rejectionReasons.push("behavior-tier-not-permitted");
    }

    if (
      parsed.expiresAtIso !== null &&
      Date.parse(input.nowIso) > Date.parse(parsed.expiresAtIso)
    ) {
      rejectionReasons.push("expired-guidance");
    }

    const state = this.stateFor(parsed);

    // 作用域必须精确匹配目标（跨任务/跨资源一律拒绝）。
    const isSameScope =
      parsed.scope.missionIdentifier === input.target.missionIdentifier &&
      (parsed.scope.taskIdentifier ?? null) === (input.target.taskIdentifier ?? null) &&
      (parsed.scope.resourceIdentifier ?? null) ===
        (input.target.resourceIdentifier ?? null);
    if (!isSameScope) {
      rejectionReasons.push("cross-scope-application");
    }

    // 依赖传播必须显式；scopeKind=resource 且未显式声明时不得扩散。
    if (
      parsed.scope.scopeKind === "resource" &&
      parsed.isDependencyPropagationExplicit === false
    ) {
      rejectionReasons.push("implicit-dependency-propagation");
    }

    // 紧急等级不授予新的优先级层级：派生任务只能层级 1 或更低。
    if (parsed.derivedTaskPriorityTier < 1) {
      rejectionReasons.push("priority-tier-tampering");
    }

    // 重复投递（同 id + 同 revision）在来源/有效期/作用域校验通过后即去重，
    // 不再要求 sequence 单调（重放可能由传输层重新编号）。
    const appliedKey = parsed.guidanceIdentifier + "@" + String(parsed.guidanceRevision);
    const isDuplicateDelivery = state.appliedGuidanceRevisions.has(appliedKey);

    const previousRevision = state.latestRevisionByGuidanceIdentifier.get(
      parsed.guidanceIdentifier,
    );
    if (!isDuplicateDelivery && parsed.sequence <= state.lastSequence) {
      rejectionReasons.push("out-of-order-sequence");
    }
    if (
      !isDuplicateDelivery &&
      previousRevision !== undefined &&
      parsed.guidanceRevision <= previousRevision
    ) {
      rejectionReasons.push("stale-guidance-revision");
    }

    if (rejectionReasons.length > 0) {
      return {
        status: "rejected",
        behaviorTier: parsed.behaviorTier,
        guidanceIdentifier: parsed.guidanceIdentifier,
        guidanceRevision: parsed.guidanceRevision,
        reasons: [...new Set(rejectionReasons)],
        isDuplicateDelivery: false,
        supersededGuidanceIdentifiers: [],
        shouldApplyAtSafePoint: false,
        notes: ["拒绝不产生副作用（不排入控制队列、不改任务优先级）"],
      };
    }

    const supersededGuidanceIdentifiers: string[] = [];
    if (previousRevision !== undefined && parsed.guidanceRevision > previousRevision) {
      supersededGuidanceIdentifiers.push(
        parsed.guidanceIdentifier + "@" + String(previousRevision),
      );
    }
    if (!isDuplicateDelivery) {
      state.appliedGuidanceRevisions.add(appliedKey);
      state.latestRevisionByGuidanceIdentifier.set(
        parsed.guidanceIdentifier,
        parsed.guidanceRevision,
      );
      state.lastSequence = parsed.sequence;
    }

    const behaviorTier = parsed.behaviorTier;
    return {
      status:
        isDuplicateDelivery || behaviorTier === "record-only"
          ? "recorded"
          : "accepted",
      behaviorTier,
      guidanceIdentifier: parsed.guidanceIdentifier,
      guidanceRevision: parsed.guidanceRevision,
      reasons: [],
      isDuplicateDelivery,
      supersededGuidanceIdentifiers,
      shouldApplyAtSafePoint:
        !isDuplicateDelivery && behaviorTier !== "record-only",
      notes: [
        isDuplicateDelivery
          ? "重复投递：仅去重，不重复应用"
          : "已受理，将在安全点应用（不假定 Provider 支持在途插入）",
        "紧急等级不授予新权限，也不改变 task priorityTier",
      ],
    };
  }
}

/** 组装一条来源已登记的指导事件（默认层级 1、不支持在途取消）。 */
export function buildRuntimeGuidanceEvent(input: {
  guidanceIdentifier: string;
  guidanceRevision: number;
  sequence: number;
  sourceKind: GuidanceSourceKind;
  sourceIdentifier: string;
  issuedAtIso: string;
  expiresAtIso: string | null;
  behaviorTier: GuidanceBehaviorTier;
  scope: RuntimeGuidanceEvent["scope"];
  instructionText: string;
  derivedTaskPriorityTier?: number;
  isDependencyPropagationExplicit?: boolean;
}): RuntimeGuidanceEvent {
  return runtimeGuidanceEventSchema.parse({
    schemaVersion: RUNTIME_GUIDANCE_SCHEMA_VERSION,
    guidanceIdentifier: input.guidanceIdentifier,
    guidanceRevision: input.guidanceRevision,
    sequence: input.sequence,
    sourceKind: input.sourceKind,
    sourceIdentifier: input.sourceIdentifier,
    issuedAtIso: input.issuedAtIso,
    expiresAtIso: input.expiresAtIso,
    behaviorTier: input.behaviorTier,
    scope: input.scope,
    instructionText: input.instructionText,
    derivedTaskPriorityTier: input.derivedTaskPriorityTier ?? 1,
    isDependencyPropagationExplicit:
      input.isDependencyPropagationExplicit ?? false,
    cancellationCapability: {
      canCancelAtSafePoint: true,
      canCancelInFlight: false,
      providerSupportsInFlightInsertion: false,
    },
  });
}
