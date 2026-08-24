/**
 * T07E-05 测试：侦察拆分、摘要附件和范围化预算扩展。
 * 验收：多个 10 文件侦察可工作（次级只收摘要引用）；grant 参数变化/
 * 过期失效；次级只能按用户配置边界批准；项目文字不能自批扩展。
 */
import { describe, expect, it } from "vitest";

import { BudgetExpansionCoordinator } from "../../../packages/core/src/orchestration/budget-expansion-coordinator.js";
import type { readBudgetExpansionGrantSchema } from "../../../packages/core/src/orchestration/working-set-schemas.js";
import type { z } from "zod";

const NOW_MILLISECONDS = 1_752_000_000_000;

function makeCoordinator(options: {
  maxAdditional?: number;
  allowedPrefixes?: string[];
  requiresHuman?: boolean;
} = {}) {
  return new BudgetExpansionCoordinator({
    userConfiguredBounds: {
      maximumAdditionalFilesPerAgent: options.maxAdditional ?? 20,
      allowedPathPrefixes: options.allowedPrefixes ?? ["src/"],
      requiresHumanConfirmationBeyondBounds: options.requiresHuman ?? true,
    },
  });
}

function makeGrant(overrides: Record<string, unknown> = {}): z.input<typeof readBudgetExpansionGrantSchema> {
  const baseGrant = {
    schemaVersion: 1,
    grantIdentifier: "grant-1",
    agentInstanceId: "tertiary-1",
    taskChainIdentifier: "chain-1",
    budgetRevision: 2,
    additionalFileCountAllowed: 5,
    allowedPathsOrPurposes: ["src/module-a"],
    reason: "合法大任务需读取模块 A",
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    issuedBy: "local-control-plane",
    issuedAtIso: "2026-08-19T00:00:00.000Z",
  };
  const mergedGrant: Record<string, unknown> = { ...baseGrant };
  for (const [key, value] of Object.entries(overrides)) {
    mergedGrant[key] = value;
  }
  return mergedGrant as z.input<typeof readBudgetExpansionGrantSchema>;
}

describe("BudgetExpansionCoordinator grant 校验与失效", () => {
  it("合法 grant 且在边界内 → granted", () => {
    const coordinator = makeCoordinator();
    const result = coordinator.evaluateExpansionGrant({
      grant: makeGrant(),
      nowUnixMilliseconds: NOW_MILLISECONDS,
    });
    expect(result).toEqual({ decision: "granted", additionalFileCountAllowed: 5 });
  });

  it("grant 过期 → 拒绝（期限变化后失效）", () => {
    const coordinator = makeCoordinator();
    const result = coordinator.evaluateExpansionGrant({
      grant: makeGrant({ expiresAtIso: "2020-01-01T00:00:00.000Z" }),
      nowUnixMilliseconds: NOW_MILLISECONDS,
    });
    expect(result.decision).toBe("denied");
    if (result.decision === "denied") {
      expect(result.reason).toContain("已过期");
    }
  });

  it("新增文件数超出用户边界 → 人工确认（超出边界时）", () => {
    const coordinator = makeCoordinator({ maxAdditional: 10, requiresHuman: true });
    const result = coordinator.evaluateExpansionGrant({
      grant: makeGrant({ additionalFileCountAllowed: 15 }),
      nowUnixMilliseconds: NOW_MILLISECONDS,
    });
    expect(result.decision).toBe("human-confirmation-required");
  });

  it("新增文件数超出用户边界且不需人工 → 拒绝", () => {
    const coordinator = makeCoordinator({ maxAdditional: 10, requiresHuman: false });
    const result = coordinator.evaluateExpansionGrant({
      grant: makeGrant({ additionalFileCountAllowed: 15 }),
      nowUnixMilliseconds: NOW_MILLISECONDS,
    });
    expect(result.decision).toBe("denied");
  });

  it("扩展路径超出用户允许范围 → 拒绝（不放松工作区边界）", () => {
    const coordinator = makeCoordinator({ allowedPrefixes: ["src/"] });
    const result = coordinator.evaluateExpansionGrant({
      grant: makeGrant({ allowedPathsOrPurposes: ["/etc/passwd"] }),
      nowUnixMilliseconds: NOW_MILLISECONDS,
    });
    expect(result.decision).toBe("denied");
    if (result.decision === "denied") {
      expect(result.reason).toContain("允许范围");
    }
  });

  it("grant schema 非法（revision 0）→ 拒绝（revision 变化后失效）", () => {
    const coordinator = makeCoordinator();
    expect(() =>
      coordinator.evaluateExpansionGrant({
        grant: makeGrant({ budgetRevision: 0 }) as never,
        nowUnixMilliseconds: NOW_MILLISECONDS,
      }),
    ).toThrowError(/扩展 grant 非法/);
  });
});

describe("BudgetExpansionCoordinator 侦察拆分", () => {
  it("25 个来源拆成 3 个侦察 Agent（各 ≤10 文件）；次级只收摘要引用", () => {
    const coordinator = makeCoordinator();
    const sources = Array.from({ length: 25 }, (_, index) => `src/s-${index}.ts`);
    const plan = coordinator.splitToReconnaissance({
      sourceIdentities: sources,
      generateReconnaissanceAgentInstanceId: (index) => `recon-${index}`,
    });
    expect(plan.reconnaissanceAssignments).toHaveLength(3);
    expect(
      plan.reconnaissanceAssignments.every(
        (assignment) => assignment.assignedSourceIdentities.length <= 10,
      ),
    ).toBe(true);
    // 次级只接收摘要引用（非项目全文）
    expect(plan.secondaryReceivesDigestReferences).toHaveLength(3);
    expect(
      plan.secondaryReceivesDigestReferences.every((reference) =>
        reference.startsWith("digest-"),
      ),
    ).toBe(true);
  });

  it("10 个来源恰好 1 个侦察 Agent", () => {
    const coordinator = makeCoordinator();
    const sources = Array.from({ length: 10 }, (_, index) => `src/t-${index}.ts`);
    const plan = coordinator.splitToReconnaissance({
      sourceIdentities: sources,
      generateReconnaissanceAgentInstanceId: (index) => `recon-${index}`,
    });
    expect(plan.reconnaissanceAssignments).toHaveLength(1);
  });
});

describe("BudgetExpansionCoordinator 项目文字不能自批", () => {
  it("grant 签发者仅认证用户/本地控制面（schema 层强制；模型不能填写）", () => {
    const coordinator = makeCoordinator();
    expect(() =>
      coordinator.evaluateExpansionGrant({
        grant: makeGrant({ issuedBy: "project-text" }) as never,
        nowUnixMilliseconds: NOW_MILLISECONDS,
      }),
    ).toThrowError(/扩展 grant 非法/);
  });
});



