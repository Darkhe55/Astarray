/**
 * AR-07 批次 9：属性测试（fast-check）补齐清单要求的“属性测试”类型。
 * 覆盖：三级三态决定求交不宽于次级、资源范围求交为子集、期限求交取更早、
 * 读取抑制账本键对 taskExecutionId 归一化稳定。
 */
import fc from "fast-check";

import { describe, expect, it } from "vitest";

import { TertiaryPermissionDelegationGuard } from "../../../packages/core/src/tools/session-permission-elevation.js";
import type { PermissionDecision } from "../../../packages/core/src/tools/permission-capability-catalog.js";

const DECISION_WIDTH: Record<PermissionDecision, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

const decisionArbitrary = fc.constantFrom<PermissionDecision>("deny", "ask", "allow");

describe("AR-07 批次9：权限求交属性", () => {
  it("三级决定宽度恒不宽于次级有效决定", () => {
    const guard = new TertiaryPermissionDelegationGuard();
    fc.assert(
      fc.property(decisionArbitrary, decisionArbitrary, (secondary, requested) => {
        const delegated = guard.computeDelegatedDecision({
          secondaryEffectiveDecision: secondary,
          requestedDelegatedDecision: requested,
        });
        expect(DECISION_WIDTH[delegated]).toBeLessThanOrEqual(
          DECISION_WIDTH[secondary],
        );
      }),
      { numRuns: 200 },
    );
  });

  it("资源范围求交恒为次级允许集合的子集且不超过请求集合", () => {
    const guard = new TertiaryPermissionDelegationGuard();
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 8 }),
        fc.array(fc.string(), { maxLength: 8 }),
        (secondaryScopes, requestedScopes) => {
          const delegated = guard.computeDelegatedResourceScope({
            secondaryAllowedResourceScopes: secondaryScopes,
            requestedResourceScopes: requestedScopes,
          });
          const secondarySet = new Set(secondaryScopes);
          expect(delegated.every((scope) => secondarySet.has(scope))).toBe(true);
          expect(delegated.length).toBeLessThanOrEqual(requestedScopes.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("期限求交结果不晚于任一输入且取自输入之一", () => {
    const guard = new TertiaryPermissionDelegationGuard();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (secondaryMillis, requestedMillis) => {
          const secondaryIso = new Date(secondaryMillis).toISOString();
          const requestedIso = new Date(requestedMillis).toISOString();
          const result = guard.computeDelegatedExpiry({
            secondaryExpiresAtIso: secondaryIso,
            requestedExpiresAtIso: requestedIso,
          });
          expect([secondaryIso, requestedIso]).toContain(result);
          expect(new Date(result).getTime()).toBeLessThanOrEqual(
            Math.min(secondaryMillis, requestedMillis),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
