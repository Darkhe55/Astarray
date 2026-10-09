/**
 * 跨项目有效权限判定的**决策矩阵**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * 先逐行读了 `evaluateEffectiveCrossProjectPermission`（L638-727）再写用例。
 * 目标分支（含未覆盖的 L712）：
 *  1) 显式拒绝优先（deny-wins）；
 *  2) 思索模式 + 导入执行 → 拒绝（只读能力）；
 *  3) 目标侧未声明可接收范围 → **不接收**（默认 allow 不等于同意接收）；
 *  4) 超出预设共享范围：放权模式不放行且**无需人工**；协同模式 → **需人工裁决**；
 *  5) 三集合交集成立：协同模式**未获用户预委托 → 仍需人工裁决**（L712）；
 *     预委托成立 → allow-by-preset-shared-scope；放权无预委托 → allow-by-intersection。
 *
 * 断言均为行为断言（decision / isAllowed / isHumanDecisionRequired 三个字段一起断言）。
 */
import { describe, expect, it } from "vitest";

import { evaluateEffectiveCrossProjectPermission } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

const OPEN_SCOPE = { pathPrefixes: ["src/"] };
const REQUESTED_PATH = "src/module.ts";

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateEffectiveCrossProjectPermission({
    sourceExportScope: OPEN_SCOPE,
    targetReceiveScope: OPEN_SCOPE,
    receivingAgentPermissionScope: OPEN_SCOPE,
    requestedResourcePath: REQUESTED_PATH,
    mode: "devolve",
    ...overrides,
  } as Parameters<typeof evaluateEffectiveCrossProjectPermission>[0]);
}

describe("跨项目有效权限：拒绝优先与模式限制", () => {
  it("① 显式拒绝优先：即使其它侧允许也不放行，且无需人工", () => {
    const evaluation = evaluate({ requestedResourceIsDenied: true });
    expect(evaluation.decision).toBe("deny-wins");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
  });

  it("② 思索模式 + 导入执行：拒绝（跨项目 grant 不授予写入/执行）", () => {
    const evaluation = evaluate({ mode: "ponder", requestedOperationKind: "import-copy" });
    expect(evaluation.decision).toBe("deny-ponder-readonly-only");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
  });

  it("③ 目标侧未声明可接收范围：不接收（默认 allow 不自动建立共享关系）", () => {
    const evaluation = evaluate({ targetReceiveScope: { pathPrefixes: [] } });
    expect(evaluation.decision).toBe("deny-target-does-not-receive");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
  });
});

describe("跨项目有效权限：超出预设共享范围", () => {
  it("④ 放权模式超出范围：不放行且无需人工介入", () => {
    const evaluation = evaluate({
      mode: "devolve",
      receivingAgentPermissionScope: { pathPrefixes: ["other/"] },
    });
    expect(evaluation.decision).toBe("deny-out-of-preset-shared-scope");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
    expect(evaluation.detail).toContain("接收 Agent 当前有效权限");
  });

  it("⑤ 协同模式超出范围：不放行且**必须人工裁决**", () => {
    const evaluation = evaluate({
      mode: "assist",
      sourceExportScope: { pathPrefixes: ["other/"] },
    });
    expect(evaluation.decision).toBe("ask-user");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(true);
  });
});

describe("跨项目有效权限：三集合交集成立后的模式判定", () => {
  it("⑥ 协同模式交集成立但未获用户预委托：仍需人工裁决（L712）", () => {
    const evaluation = evaluate({ mode: "assist" });
    expect(evaluation.decision).toBe("ask-user");
    expect(evaluation.isAllowed).toBe(false);
    expect(evaluation.isHumanDecisionRequired).toBe(true);
    expect(evaluation.detail).toContain("未获用户预委托");
  });

  it("⑦ 放权模式交集成立且无预委托：按交集放行", () => {
    const evaluation = evaluate({ mode: "devolve" });
    expect(evaluation.decision).toBe("allow-by-intersection");
    expect(evaluation.isAllowed).toBe(true);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
  });

  it("⑧ 交集成立且用户预委托共享范围：按预设共享范围放行", () => {
    const evaluation = evaluate({ mode: "assist", hasUserPresetDelegation: true });
    expect(evaluation.decision).toBe("allow-by-preset-shared-scope");
    expect(evaluation.isAllowed).toBe(true);
    expect(evaluation.isHumanDecisionRequired).toBe(false);
  });
});
