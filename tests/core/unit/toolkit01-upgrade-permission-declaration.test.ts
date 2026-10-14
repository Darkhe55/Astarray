/**
 * 反例（2026-10-24）：工具**升级包**必须显式声明**三种模式的默认权限规则和理由**，
 * 且升级要**新增**新功能的权限开关、**移除**消失功能的旧开关。
 *
 * 依据用户 2026-10-22 澄清：
 * > "工具升级包中**必须显式声明三种模式的默认权限规则和理由**，便于直接添加或修改到
 * > 参数授权规则表中。"
 * > "功能升级…**在授权规则表里增加新的权限规则状态**；**消失的功能也要对应移除旧的权限管理开关**。"
 */
import { describe, expect, it } from "vitest";

import {
  reconcilePermissionRulesForUpgrade,
  TOOL_UPGRADE_DECLARED_MODES,
  validateToolUpgradePermissionDeclaration,
  type ExistingAuthorizationRule,
  type ToolUpgradePermissionDeclaration,
} from "../../../packages/core/src/toolkit/tool-upgrade-permission-declaration.js";

function buildDeclaration(
  overrides: Partial<ToolUpgradePermissionDeclaration> = {},
): ToolUpgradePermissionDeclaration {
  return {
    toolPackageId: "report-formatter",
    fromVersion: 1,
    toVersion: 2,
    declaredModeRules: [
      {
        mode: "ponder",
        rules: [{ action: "render-report", decision: "deny", reason: "思索模式只读，不产出文件" }],
      },
      {
        mode: "assist",
        rules: [{ action: "render-report", decision: "ask", reason: "协同模式产出文件前逐次确认" }],
      },
      {
        mode: "devolve",
        rules: [{ action: "render-report", decision: "allow", reason: "放权模式默认放行常规产出" }],
      },
    ],
    addedFeatures: [],
    removedFeatures: [],
    ...overrides,
  };
}

describe("TOOLKIT-01-04：升级包的权限规则声明必须完整且给理由", () => {
  it("① 三模式齐全且每条规则都有理由 ⇒ 接受", () => {
    const outcome = validateToolUpgradePermissionDeclaration(buildDeclaration());
    expect(outcome.isAccepted).toBe(true);
    expect(outcome.missingModes).toEqual([]);
  });

  it("② **缺少任一模式** ⇒ 拒绝，并**逐项列出**缺哪个（不得默认「没声明就等于默认」）", () => {
    const declaration = buildDeclaration({
      declaredModeRules: [
        {
          mode: "assist",
          rules: [{ action: "render-report", decision: "ask", reason: "协同模式确认" }],
        },
      ],
    });
    const outcome = validateToolUpgradePermissionDeclaration(declaration);

    expect(outcome.isAccepted).toBe(false);
    // 缺失项必须可逐项补齐，而不是笼统报错
    expect(outcome.missingModes).toEqual(["ponder", "devolve"]);
    expect(String(outcome.reason)).toContain("三种模式");
  });

  it("③ 声明了模式但**规则没有理由** ⇒ 拒绝（用户明确要求「和理由」）", () => {
    const declaration = buildDeclaration();
    declaration.declaredModeRules[1]!.rules = [
      { action: "render-report", decision: "ask", reason: "   " },
    ];

    const outcome = validateToolUpgradePermissionDeclaration(declaration);

    expect(outcome.isAccepted).toBe(false);
    expect(String(outcome.reason)).toContain("缺少理由");
  });

  it("④ 三种模式常量与 `AgentMode` 同源（不得两处口径漂移）", () => {
    expect([...TOOL_UPGRADE_DECLARED_MODES]).toEqual(["ponder", "assist", "devolve"]);
  });

  it("⑤ 功能增删项留空或重复 ⇒ 拒绝", () => {
    const blank = buildDeclaration({
      addedFeatures: [{ featureIdentifier: "", ruleIdentifier: "" }],
    });
    expect(validateToolUpgradePermissionDeclaration(blank).isAccepted).toBe(false);

    const duplicated = buildDeclaration({
      addedFeatures: [{ featureIdentifier: "x", ruleIdentifier: "x" }],
      removedFeatures: [{ featureIdentifier: "x", ruleIdentifier: "x" }],
    });
    expect(validateToolUpgradePermissionDeclaration(duplicated).isAccepted).toBe(false);
  });
});

describe("TOOLKIT-01-04：升级要新增新功能的开关、移除消失功能的旧开关", () => {
  const existingRules: ExistingAuthorizationRule[] = [
    {
      ruleIdentifier: "render-report",
      toolName: "report-formatter",
      action: "render-report",
      decision: "ask",
      explanation: "既有：协同模式确认",
    },
    {
      ruleIdentifier: "legacy-export",
      toolName: "report-formatter",
      action: "legacy-export",
      decision: "allow",
      explanation: "既有：旧导出功能（本升级后消失）",
    },
  ];

  it("⑥ **新增功能** ⇒ 规则表新增规则（用协同模式声明落地）", () => {
    const declaration = buildDeclaration({
      declaredModeRules: [
        { mode: "ponder", rules: [{ action: "render-report", decision: "deny", reason: "只读" }, { action: "render-pdf", decision: "deny", reason: "思索只读" }] },
        { mode: "assist", rules: [{ action: "render-report", decision: "ask", reason: "逐次确认" }, { action: "render-pdf", decision: "ask", reason: "新增 PDF 产出需确认" }] },
        { mode: "devolve", rules: [{ action: "render-report", decision: "allow", reason: "放行" }, { action: "render-pdf", decision: "allow", reason: "放行" }] },
      ],
      addedFeatures: [{ featureIdentifier: "render-pdf", ruleIdentifier: "render-pdf" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({ declaration, existingRules });

    expect(outcome.isApplied).toBe(true);
    expect(outcome.addedCount).toBe(1);
    const addedRule = outcome.rules.find((rule) => rule.action === "render-pdf");
    // 理由被带入解释（便于在设置界面看到「为什么有这个开关」）
    expect(addedRule?.explanation).toContain("确认");
    expect(addedRule?.decision).toBe("ask");
  });

  it("⑦ **消失的功能** ⇒ 移除其旧规则（对应「移除旧的权限管理开关」）", () => {
    const declaration = buildDeclaration({
      removedFeatures: [{ featureIdentifier: "legacy-export", ruleIdentifier: "legacy-export" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({ declaration, existingRules });

    expect(outcome.isApplied).toBe(true);
    expect(outcome.removedCount).toBe(1);
    expect(outcome.rules.some((rule) => rule.ruleIdentifier === "legacy-export")).toBe(false);
  });

  it("⑧ 保留项**逐字不动**（不得把用户已改过的设置悄悄重置）", () => {
    const userEditedRules: ExistingAuthorizationRule[] = [
      {
        ruleIdentifier: "render-report",
        toolName: "report-formatter",
        action: "render-report",
        // 用户此前把协同模式改成了 deny
        decision: "deny",
        explanation: "用户自定义：本机一律不产出",
      },
      ...existingRules.slice(1),
    ];
    const declaration = buildDeclaration({
      removedFeatures: [{ featureIdentifier: "legacy-export", ruleIdentifier: "legacy-export" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({
      declaration,
      existingRules: userEditedRules,
    });

    const retained = outcome.rules.find((rule) => rule.ruleIdentifier === "render-report");
    // 决策与解释都必须保持用户版本
    expect(retained?.decision).toBe("deny");
    expect(retained?.explanation).toBe("用户自定义：本机一律不产出");
  });

  it("⑨ 新增功能**已在表中** ⇒ 不重复添加（幂等）", () => {
    const declaration = buildDeclaration({
      addedFeatures: [{ featureIdentifier: "render-report", ruleIdentifier: "render-report" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({ declaration, existingRules });

    expect(outcome.addedCount).toBe(0);
    expect(outcome.rules.filter((rule) => rule.ruleIdentifier === "render-report")).toHaveLength(1);
  });

  it("⑩ 声明**不合法** ⇒ 整表**不落地**（fail-closed，原样返回并给理由）", () => {
    const declaration = buildDeclaration({
      declaredModeRules: [
        { mode: "assist", rules: [{ action: "render-report", decision: "ask", reason: "x" }] },
      ],
      removedFeatures: [{ featureIdentifier: "legacy-export", ruleIdentifier: "legacy-export" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({ declaration, existingRules });

    expect(outcome.isApplied).toBe(false);
    // 关键：不得"部分生效"（只删了旧开关却因声明不全没加新开关）
    expect(outcome.rules).toEqual(existingRules);
    expect(outcome.removedCount).toBe(0);
  });

  it("⑪ 新增功能在**协同模式**里没有对应规则 ⇒ 拒绝整表变更（不生成无依据开关）", () => {
    const declaration = buildDeclaration({
      addedFeatures: [{ featureIdentifier: "render-svg", ruleIdentifier: "render-svg" }],
    });

    const outcome = reconcilePermissionRulesForUpgrade({ declaration, existingRules });

    expect(outcome.isApplied).toBe(false);
    expect(String(outcome.reason)).toContain("协同模式");
    expect(outcome.rules).toEqual(existingRules);
  });
});
