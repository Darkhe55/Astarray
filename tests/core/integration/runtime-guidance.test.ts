/**
 * GUIDE-01-01：运行中指导契约反例（伪造/过期/乱序/重放/跨作用域/层级篡改）。
 */
import { describe, expect, it } from "vitest";

import {
  GuidanceSourceRegistry,
  RuntimeGuidanceController,
  buildRuntimeGuidanceEvent,
  type GuidanceBehaviorTier,
  type GuidanceSourceRegistration,
  type RuntimeGuidanceEvent,
} from "../../../packages/core/src/guidance/runtime-guidance.js";

const NOW = "2026-09-16T00:00:00.000Z";

function createController(): RuntimeGuidanceController {
  const registry = new GuidanceSourceRegistry();
  const registrations: GuidanceSourceRegistration[] = [
    {
      sourceKind: "authenticated-user",
      sourceIdentifier: "user-1",
      maximumBehaviorTier: "gate-and-request-pause",
      registeredAtIso: NOW,
    },
    {
      sourceKind: "registered-local-tool",
      sourceIdentifier: "tool-watchdog",
      maximumBehaviorTier: "safe-point-guidance",
      registeredAtIso: NOW,
    },
    {
      sourceKind: "file-task-observation",
      sourceIdentifier: "observer-1",
      maximumBehaviorTier: "safe-point-guidance",
      registeredAtIso: NOW,
    },
  ];
  for (const registration of registrations) {
    registry.register(registration);
  }
  return new RuntimeGuidanceController(registry);
}

function guidance(
  overrides: Partial<Parameters<typeof buildRuntimeGuidanceEvent>[0]> = {},
): RuntimeGuidanceEvent {
  return buildRuntimeGuidanceEvent({
    guidanceIdentifier: "guide-1",
    guidanceRevision: 1,
    sequence: 1,
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    issuedAtIso: NOW,
    expiresAtIso: null,
    behaviorTier: "safe-point-guidance" as GuidanceBehaviorTier,
    scope: {
      scopeKind: "task",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      resourceIdentifier: null,
    },
    instructionText: "把验收标准改为覆盖真实产物",
    ...overrides,
  });
}

const TARGET = {
  missionIdentifier: "mission-1",
  taskIdentifier: "task-1",
  resourceIdentifier: null,
};

describe("GUIDE-01-01 运行中指导契约", () => {
  it("伪造来源与超出登记档位一律拒绝", () => {
    const controller = createController();
    const forged = controller.acceptGuidance({
      event: guidance({ sourceIdentifier: "user-unknown" }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(forged.status).toBe("rejected");
    expect(forged.reasons).toContain("unregistered-source");

    const tierExceeded = controller.acceptGuidance({
      event: guidance({
        sourceKind: "registered-local-tool",
        sourceIdentifier: "tool-watchdog",
        behaviorTier: "gate-and-request-pause",
      }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(tierExceeded.status).toBe("rejected");
    expect(tierExceeded.reasons).toContain("behavior-tier-not-permitted");
  });

  it("过期指导拒绝；有效期内接受", () => {
    const controller = createController();
    const expired = controller.acceptGuidance({
      event: guidance({ expiresAtIso: "2026-09-15T23:59:59.000Z" }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(expired.status).toBe("rejected");
    expect(expired.reasons).toContain("expired-guidance");

    const valid = controller.acceptGuidance({
      event: guidance({ expiresAtIso: "2026-09-16T01:00:00.000Z" }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(valid.status).toBe("accepted");
    expect(valid.shouldApplyAtSafePoint).toBe(true);
  });

  it("sequence 乱序拒绝，单调递增接受；重复投递只去重不重复应用", () => {
    const controller = createController();
    const first = controller.acceptGuidance({
      event: guidance({ sequence: 5 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(first.status).toBe("accepted");

    // 新 revision 但 sequence 倒退 → 乱序拒绝。
    const outOfOrder = controller.acceptGuidance({
      event: guidance({ sequence: 5, guidanceRevision: 2 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(outOfOrder.status).toBe("rejected");
    expect(outOfOrder.reasons).toContain("out-of-order-sequence");

    const nextRevision = controller.acceptGuidance({
      event: guidance({ sequence: 6, guidanceRevision: 3 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(nextRevision.status).toBe("accepted");
    expect(nextRevision.supersededGuidanceIdentifiers).toEqual(["guide-1@1"]);

    // 同 id + 同 revision 再次投递（即使被传输层重新编号）：去重不重复应用。
    const duplicate = controller.acceptGuidance({
      event: guidance({ sequence: 9, guidanceRevision: 3 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(duplicate.isDuplicateDelivery).toBe(true);
    expect(duplicate.status).toBe("recorded");
    expect(duplicate.shouldApplyAtSafePoint).toBe(false);
  });

  it("陈旧 revision 拒绝；新 revision 取代旧指导", () => {
    const controller = createController();
    const first = controller.acceptGuidance({
      event: guidance({ sequence: 1, guidanceRevision: 3 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(first.status).toBe("accepted");
    const stale = controller.acceptGuidance({
      event: guidance({ sequence: 2, guidanceRevision: 2 }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(stale.status).toBe("rejected");
    expect(stale.reasons).toContain("stale-guidance-revision");
  });

  it("跨作用域拒绝（跨任务/跨资源）", () => {
    const controller = createController();
    const crossTask = controller.acceptGuidance({
      event: guidance(),
      target: { ...TARGET, taskIdentifier: "task-2" },
      nowIso: NOW,
    });
    expect(crossTask.status).toBe("rejected");
    expect(crossTask.reasons).toContain("cross-scope-application");

    const crossResource = controller.acceptGuidance({
      event: guidance({
        scope: {
          scopeKind: "resource",
          missionIdentifier: "mission-1",
          taskIdentifier: null,
          resourceIdentifier: "resource-1",
        },
        isDependencyPropagationExplicit: true,
      }),
      target: {
        missionIdentifier: "mission-1",
        taskIdentifier: null,
        resourceIdentifier: "resource-2",
      },
      nowIso: NOW,
    });
    expect(crossResource.reasons).toContain("cross-scope-application");
  });

  it("依赖传播必须显式；资源型指导不得隐式扩散", () => {
    const controller = createController();
    const implicit = controller.acceptGuidance({
      event: guidance({
        scope: {
          scopeKind: "resource",
          missionIdentifier: "mission-1",
          taskIdentifier: null,
          resourceIdentifier: "resource-1",
        },
        isDependencyPropagationExplicit: false,
      }),
      target: {
        missionIdentifier: "mission-1",
        taskIdentifier: null,
        resourceIdentifier: "resource-1",
      },
      nowIso: NOW,
    });
    expect(implicit.status).toBe("rejected");
    expect(implicit.reasons).toContain("implicit-dependency-propagation");

    const explicit = controller.acceptGuidance({
      event: guidance({
        scope: {
          scopeKind: "resource",
          missionIdentifier: "mission-1",
          taskIdentifier: null,
          resourceIdentifier: "resource-1",
        },
        isDependencyPropagationExplicit: true,
      }),
      target: {
        missionIdentifier: "mission-1",
        taskIdentifier: null,
        resourceIdentifier: "resource-1",
      },
      nowIso: NOW,
    });
    expect(explicit.status).toBe("accepted");
  });

  it("紧急等级不得篡改 task priorityTier（派生任务只能层级 ≥1）", () => {
    const controller = createController();
    const tampered = controller.acceptGuidance({
      event: guidance({
        behaviorTier: "gate-and-request-pause",
        derivedTaskPriorityTier: 0,
      }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(tampered.status).toBe("rejected");
    expect(tampered.reasons).toContain("priority-tier-tampering");
    // 门禁档不授予新权限，也不支持在途取消。
    const gated = guidance({ behaviorTier: "gate-and-request-pause" });
    expect(gated.derivedTaskPriorityTier).toBe(1);
    expect(gated.cancellationCapability.canCancelInFlight).toBe(false);
    expect(gated.cancellationCapability.providerSupportsInFlightInsertion).toBe(false);
  });

  it("仅记录档不触发安全点应用", () => {
    const controller = createController();
    const recorded = controller.acceptGuidance({
      event: guidance({ behaviorTier: "record-only" }),
      target: TARGET,
      nowIso: NOW,
    });
    expect(recorded.status).toBe("recorded");
    expect(recorded.shouldApplyAtSafePoint).toBe(false);
  });
});
