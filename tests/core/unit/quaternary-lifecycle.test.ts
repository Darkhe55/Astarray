/**
 * T08C-06 测试：四级生命周期、权限求交与 Git 子分支集成。
 * 验收：无第五级；四级不越权；三级不能向项目级分支合并；
 * 四级 Git 只写隔离分支。
 */
import { describe, expect, it } from "vitest";

import { QuaternaryLifecycleController } from "../../../packages/core/src/orchestration/quaternary-lifecycle-controller.js";
import {
  QuaternaryGitBranchPolicy,
  QuaternaryPermissionIntersectionGuard,
} from "../../../packages/core/src/orchestration/quaternary-boundary-guards.js";
import { QUATERNARY_DELEGATION_SCHEMA_VERSION } from "../../../packages/core/src/orchestration/agent-routing-schemas.js";

function makeDelegation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: QUATERNARY_DELEGATION_SCHEMA_VERSION as 1,
    delegationId: "delegation-1",
    delegatingTertiaryAgentInstanceId: "tertiary-1",
    quaternaryAgentInstanceId: "quaternary-1",
    boundSubchainTaskIds: ["t3.1"],
    permissionSubset: "三级权限的严格子集",
    allowedToolNamesSubset: ["project.read"],
    resourceScopeSubset: "任务链内范围",
    expiresAtIso: "2026-08-20T00:00:00.000Z",
    createdAtIso: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("QuaternaryLifecycleController", () => {
  it("三级创建四级：绑定上级三级、严格子链、可查询", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: () => true,
    });
    const record = controller.createQuaternaryAgent({
      delegation: makeDelegation(),
    });
    expect(record.delegation.delegatingTertiaryAgentInstanceId).toBe("tertiary-1");
    expect(record.delegation.boundSubchainTaskIds).toEqual(["t3.1"]);
    expect(record.lifecycle.status).toBe("active");
    expect(
      controller.getQuaternaryLifecycle("quaternary-1")?.delegation.delegationId,
    ).toBe("delegation-1");
  });

  it("上级三级不活跃 → 拒绝创建四级", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: (tertiaryId) => tertiaryId === "tertiary-other",
    });
    expect(() =>
      controller.createQuaternaryAgent({ delegation: makeDelegation() }),
    ).toThrowError(/上级三级 Agent 不活跃/);
  });

  it("四级身份不可复用（重复创建拒绝）", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: () => true,
    });
    controller.createQuaternaryAgent({ delegation: makeDelegation() });
    expect(() =>
      controller.createQuaternaryAgent({
        delegation: makeDelegation({ delegationId: "delegation-2" }),
      }),
    ).toThrowError(/身份不可复用/);
  });

  it("收口：关闭后不再活跃；重复收口幂等", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: () => true,
    });
    controller.createQuaternaryAgent({ delegation: makeDelegation() });
    const beforeExpiry = new Date("2026-08-19T10:00:00.000Z").getTime();
    expect(
      controller.isQuaternaryAgentActive("quaternary-1", beforeExpiry),
    ).toBe(true);
    expect(controller.closeQuaternaryAgent("quaternary-1")).toBe(true);
    expect(controller.closeQuaternaryAgent("quaternary-1")).toBe(false);
    expect(
      controller.isQuaternaryAgentActive("quaternary-1", beforeExpiry),
    ).toBe(false);
  });

  it("到期后不活跃；不存在返回 false", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: () => true,
    });
    controller.createQuaternaryAgent({
      delegation: makeDelegation({ expiresAtIso: "2026-08-19T12:00:00.000Z" }),
    });
    const afterExpiry = new Date("2026-08-19T13:00:00.000Z").getTime();
    expect(
      controller.isQuaternaryAgentActive("quaternary-1", afterExpiry),
    ).toBe(false);
    expect(controller.isQuaternaryAgentActive("ghost", afterExpiry)).toBe(false);
  });

  it("无第五级：控制器不提供创建第五级入口（编译期契约，文档断言）", () => {
    const controller = new QuaternaryLifecycleController({
      isTertiaryAgentActive: () => true,
    });
    // 控制器只暴露 createQuaternaryAgent / close / query；
    // 无 createFifthLevelAgent 方法（可断言类型层面）。
    expect(typeof controller.createQuaternaryAgent).toBe("function");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(controller))).not.toContain(
      "createFifthLevelAgent",
    );
  });
});

describe("QuaternaryPermissionIntersectionGuard", () => {
  it("四级决定 = 三级 ⊓ 请求（不宽于三级）", () => {
    const guard = new QuaternaryPermissionIntersectionGuard({
      tertiaryEffectiveDecision: "ask",
      tertiaryAllowedResourceScopes: ["scope-a"],
      tertiaryExpiresAtIso: "2026-08-20T00:00:00.000Z",
    });
    expect(guard.computeQuaternaryDecision("allow")).toBe("ask");
    expect(guard.computeQuaternaryDecision("deny")).toBe("deny");
  });

  it("资源范围 ⊆ 三级允许范围；期限不晚于三级", () => {
    const guard = new QuaternaryPermissionIntersectionGuard({
      tertiaryEffectiveDecision: "allow",
      tertiaryAllowedResourceScopes: ["scope-a", "scope-b"],
      tertiaryExpiresAtIso: "2026-08-20T00:00:00.000Z",
    });
    expect(
      guard.computeQuaternaryResourceScopes(["scope-b", "scope-c"]),
    ).toEqual(["scope-b"]);
    expect(
      guard.computeQuaternaryExpiry("2026-08-21T00:00:00.000Z"),
    ).toBe("2026-08-20T00:00:00.000Z");
  });

  it("请求宽于三级 → 拒绝分发", () => {
    const guard = new QuaternaryPermissionIntersectionGuard({
      tertiaryEffectiveDecision: "ask",
      tertiaryAllowedResourceScopes: [],
      tertiaryExpiresAtIso: "2026-08-20T00:00:00.000Z",
    });
    expect(() =>
      guard.assertQuaternaryDelegationAllowed("allow"),
    ).toThrowError(/宽于次级有效决定/);
  });
});

describe("QuaternaryGitBranchPolicy", () => {
  const policy = new QuaternaryGitBranchPolicy();

  it("四级只能提交到四级隔离分支（禁止远端/集成/目标分支）", () => {
    policy.assertQuaternaryCommitTarget({
      agentRole: "quaternary",
      targetBranchKind: "quaternary-isolation-branch",
    });
    for (const forbidden of [
      "tertiary-task-branch",
      "mission-integration-branch",
      "user-goal-branch",
      "remote",
    ] as const) {
      expect(() =>
        policy.assertQuaternaryCommitTarget({
          agentRole: "quaternary",
          targetBranchKind: forbidden,
        }),
      ).toThrowError(/只能提交到隔离分支/);
    }
  });

  it("三级只可向自己的任务分支合并（禁止向上合并）", () => {
    policy.assertTertiaryMergeTarget({ targetBranchKind: "tertiary-task-branch" });
    for (const forbidden of [
      "mission-integration-branch",
      "user-goal-branch",
      "remote",
    ] as const) {
      expect(() =>
        policy.assertTertiaryMergeTarget({ targetBranchKind: forbidden }),
      ).toThrowError(/最终向上集成只属于次级/);
    }
  });
});