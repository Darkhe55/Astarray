/**
 * T07C-04 测试：有界 fallback、Provider 健康、数据出境与活锁保护。
 * 验收：预算/退避/数据出境拒绝/fallback 环检测；故障矩阵行为确定。
 */
import { describe, expect, it } from "vitest";

import { BoundedProviderFallbackGuard } from "../../../packages/core/src/orchestration/bounded-provider-fallback-guard.js";
import type { DataEgressPolicyPort } from "../../../packages/core/src/orchestration/bounded-provider-fallback-guard.js";

function makeEgressPort(
  allowed: Array<{ region: string; category: string }>,
): DataEgressPolicyPort {
  return {
    isContentEgressAllowed: ({ regionLabel, contentCategory }) =>
      allowed.some(
        (rule) => rule.region === regionLabel && rule.category === contentCategory,
      ),
  };
}

function makeGuard(options: Partial<ConstructorParameters<typeof BoundedProviderFallbackGuard>[0]> = {}) {
  return new BoundedProviderFallbackGuard({
    maxFallbackAttemptsPerTask: 3,
    baseBackoffMilliseconds: 2_000,
    dataEgressPolicyPort: makeEgressPort([
      { region: "us-east", category: "code" },
      { region: "eu-west", category: "code" },
    ]),
    ...options,
  });
}

describe("BoundedProviderFallbackGuard 预算与退避", () => {
  it("预算内且退避满足 → 允许", () => {
    const guard = makeGuard();
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "anthropic/claude-3",
      previouslyAttemptedModelProfileIds: ["openai/gpt-4o"],
      currentFallbackCount: 1,
      elapsedSinceLastFallbackMilliseconds: 4_000,
      contentCategory: "code",
      targetRegionLabel: "eu-west",
    });
    expect(result).toEqual({ isAllowed: true, blockedReason: null });
  });

  it("预算耗尽 → 阻塞", () => {
    const guard = makeGuard();
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "anthropic/claude-3",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 3,
      elapsedSinceLastFallbackMilliseconds: 100_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.blockedReason).toContain("预算");
  });

  it("退避不足 → 阻塞（指数退避 base × 2^n）", () => {
    const guard = makeGuard();
    // 第 2 次 fallback（count=2）需 8_000ms；只过了 5_000ms → 拒绝
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "anthropic/claude-3",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 2,
      elapsedSinceLastFallbackMilliseconds: 5_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.blockedReason).toContain("退避中");
  });
});

describe("BoundedProviderFallbackGuard 数据出境", () => {
  it("内容类别不允许出境到目标区域 → 阻塞（不因故障切换转移受限内容）", () => {
    const guard = makeGuard();
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "openai/gpt-4o",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 0,
      elapsedSinceLastFallbackMilliseconds: 10_000,
      contentCategory: "sensitive-pii",
      targetRegionLabel: "us-east",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.blockedReason).toContain("数据出境策略");
  });

  it("内容类别允许出境 → 允许（故障矩阵行为确定）", () => {
    const guard = makeGuard();
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "openai/gpt-4o",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 0,
      elapsedSinceLastFallbackMilliseconds: 10_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(result.isAllowed).toBe(true);
  });
});

describe("BoundedProviderFallbackGuard 活锁保护", () => {
  it("fallback 环（A→B→A）：目标已尝试过 → 阻塞", () => {
    const guard = makeGuard();
    const result = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "openai/gpt-4o",
      previouslyAttemptedModelProfileIds: ["openai/gpt-4o", "anthropic/claude-3"],
      currentFallbackCount: 2,
      elapsedSinceLastFallbackMilliseconds: 10_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.blockedReason).toContain("fallback 环检测");
  });

  it("无进展重试：同一目标连续请求且预算耗尽 → 阻塞", () => {
    const guard = makeGuard({ maxFallbackAttemptsPerTask: 1 });
    const first = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "openai/gpt-4o",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 0,
      elapsedSinceLastFallbackMilliseconds: 10_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(first.isAllowed).toBe(true);
    const second = guard.guardFallbackAttempt({
      taskIdentifier: "task-1",
      targetModelProfileId: "openai/gpt-4o",
      previouslyAttemptedModelProfileIds: [],
      currentFallbackCount: 1,
      elapsedSinceLastFallbackMilliseconds: 10_000,
      contentCategory: "code",
      targetRegionLabel: "us-east",
    });
    expect(second.isAllowed).toBe(false);
    expect(second.blockedReason).toContain("预算");
  });
});