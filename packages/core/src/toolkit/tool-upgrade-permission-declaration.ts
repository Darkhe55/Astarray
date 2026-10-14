/**
 * TOOLKIT-01-04（2026-10-24）：工具**升级包**的权限规则声明与**增删重算**。
 *
 * ## 依据（用户 2026-10-22 澄清）
 *
 * > "工具升级包中**必须显式声明三种模式的默认权限规则和理由**，便于直接添加或修改到
 * > 参数授权规则表中。"
 * > "在工具出现功能升级的时候，应该**在授权规则表里增加新的权限规则状态**，对应新升级的功能，
 * > **消失的功能也要对应移除旧的权限管理开关**。"
 *
 * ## 本模块做什么
 *
 * 1. `validateToolUpgradePermissionDeclaration()` —— **本地确定性**校验升级包声明：
 *    **三种模式**（`ponder`/`assist`/`devolve`）必须**各自显式**声明，
 *    **每条规则必须带理由**；缺失即拒（不得"没声明就等于默认"）。
 * 2. `reconcilePermissionRulesForUpgrade()` —— 依升级前后**功能清单**重算规则表：
 *    - **新增**功能 ⇒ **添加**对应规则；
 *    - **消失**功能 ⇒ **移除**其旧规则（对应"移除旧的权限管理开关"）；
 *    - 保留项**逐字不重写**（避免把用户已改过的有效设置悄悄重置）。
 *
 * 刻意**不做**模型判断：本模块是纯函数，不联网、不调用模型。
 */
import type { AgentMode } from "../core/types.js";
import type { PermissionDecision } from "../tools/permission-capability-catalog.js";

/** 三种模式（与 `AgentMode` 同源，避免两处口径漂移）。 */
export const TOOL_UPGRADE_DECLARED_MODES: readonly AgentMode[] = [
  "ponder",
  "assist",
  "devolve",
];

export interface DeclaredPermissionRule {
  /** 该工具下的 action（与规则表 `action` 同口径）。 */
  action: string;
  decision: PermissionDecision;
  /**
   * **理由**（用户明确要求"和理由"）。空/缺失即视为未声明 —— 防止"加了开关却不说为什么"。
   */
  reason: string;
}

export interface DeclaredModePermissionRules {
  mode: AgentMode;
  rules: DeclaredPermissionRule[];
}

/** 单个功能（工具能力单元）的声明：它**新增**了什么、**消失**了什么。 */
export interface ToolUpgradeFeatureDelta {
  /** 功能标识（用于关联既有规则；约定等于其 action 名或稳定功能键）。 */
  featureIdentifier: string;
  /** 该功能对应的规则标识前缀/键（用于在既有表中定位旧规则）。 */
  ruleIdentifier: string;
}

export interface ToolUpgradePermissionDeclaration {
  toolPackageId: string;
  fromVersion: number;
  toVersion: number;
  /** **必须三模式齐全**；缺任一模式即拒。 */
  declaredModeRules: DeclaredModePermissionRules[];
  /** 本升级**新增**的功能（⇒ 需添加规则）。 */
  addedFeatures: ToolUpgradeFeatureDelta[];
  /** 本升级**移除**的功能（⇒ 需移除旧规则/旧开关）。 */
  removedFeatures: ToolUpgradeFeatureDelta[];
}

export interface DeclarationValidationOutcome {
  isAccepted: boolean;
  reason: string | null;
  /** 缺失声明的模式（便于调用方逐项补齐，而不是笼统报错）。 */
  missingModes: AgentMode[];
}

/**
 * 校验升级包声明：**三模式齐全** + **每条规则都有理由** + 功能增删项自身合法。
 * fail-closed：任何缺失都拒绝，且**逐项列出**缺什么。
 */
export function validateToolUpgradePermissionDeclaration(
  declaration: ToolUpgradePermissionDeclaration,
): DeclarationValidationOutcome {
  const declaredModes = new Set(declaration.declaredModeRules.map((entry) => entry.mode));
  const missingModes = TOOL_UPGRADE_DECLARED_MODES.filter((mode) => !declaredModes.has(mode));
  if (missingModes.length > 0) {
    return {
      isAccepted: false,
      reason:
        "升级包必须**显式声明三种模式**的默认权限规则；缺少：" + missingModes.join(", "),
      missingModes,
    };
  }

  for (const entry of declaration.declaredModeRules) {
    for (const rule of entry.rules) {
      if (rule.reason.trim() === "") {
        return {
          isAccepted: false,
          reason:
            "模式 " + entry.mode + " 的规则 `" + rule.action + "` **缺少理由**：" +
            "用户要求'显式声明三种模式的默认权限规则**和理由**'",
          missingModes: [],
        };
      }
    }
  }

  const seenFeatureIdentifiers = new Set<string>();
  for (const feature of [...declaration.addedFeatures, ...declaration.removedFeatures]) {
    if (feature.featureIdentifier.trim() === "" || feature.ruleIdentifier.trim() === "") {
      return {
        isAccepted: false,
        reason: "功能增删项必须给出 `featureIdentifier` 与 `ruleIdentifier`（不得留空）",
        missingModes: [],
      };
    }
    if (feature.featureIdentifier !== feature.ruleIdentifier) {
      return {
        isAccepted: false,
        reason:
          "功能 `" + feature.featureIdentifier + "` 与其规则键 `" +
          feature.ruleIdentifier + "` 不一致：无法在既有表中可靠定位旧规则",
        missingModes: [],
      };
    }
    if (seenFeatureIdentifiers.has(feature.featureIdentifier)) {
      return {
        isAccepted: false,
        reason: "功能 `" + feature.featureIdentifier + "` 重复声明（增或删各只能一次）",
        missingModes: [],
      };
    }
    seenFeatureIdentifiers.add(feature.featureIdentifier);
  }

  return { isAccepted: true, reason: null, missingModes: [] };
}

/** 既有规则表行（与 `ParameterAuthorizationRule` 同口径的最小子集）。 */
export interface ExistingAuthorizationRule {
  ruleIdentifier?: string;
  toolName: string;
  action: string;
  decision: PermissionDecision;
  explanation: string;
}

export interface PermissionRulesReconciliationOutcome {
  isApplied: boolean;
  reason: string | null;
  /** 重算后的规则表（新增已加入、消失已移除、保留项原样）。 */
  rules: ExistingAuthorizationRule[];
  addedCount: number;
  removedCount: number;
}

/**
 * 依升级包重算规则表：**新增功能添加规则 / 消失功能移除旧规则 / 保留项逐字不动**。
 *
 * - `addedFeatures` 里的功能若既有表中**已有**同名规则 ⇒ 视为**已存在**（不重复添加）；
 * - `removedFeatures` 里的功能 ⇒ 移除既有表中 `ruleIdentifier`（或 `action`）匹配的规则；
 * - 其余规则**原样保留**（不重写，避免重置用户已改过的设置）。
 */
export function reconcilePermissionRulesForUpgrade(input: {
  declaration: ToolUpgradePermissionDeclaration;
  existingRules: readonly ExistingAuthorizationRule[];
}): PermissionRulesReconciliationOutcome {
  const validation = validateToolUpgradePermissionDeclaration(input.declaration);
  if (!validation.isAccepted) {
    return {
      isApplied: false,
      reason: validation.reason,
      rules: [...input.existingRules],
      addedCount: 0,
      removedCount: 0,
    };
  }

  const removedFeatureIdentifiers = new Set(
    input.declaration.removedFeatures.map((feature) => feature.featureIdentifier),
  );
  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return !removedFeatureIdentifiers.has(key);
  });
  const removedCount = input.existingRules.length - retainedRules.length;

  const existingKeys = new Set(
    retainedRules.map((rule) => rule.ruleIdentifier ?? rule.action),
  );
  const addedRules: ExistingAuthorizationRule[] = [];
  for (const feature of input.declaration.addedFeatures) {
    if (existingKeys.has(feature.ruleIdentifier)) {
      continue;
    }
    // 用该功能在**协同模式**（assist）下的声明作为落地规则；assist 缺失已被上面的校验挡住。
    const assistEntry = input.declaration.declaredModeRules.find(
      (entry) => entry.mode === "assist",
    );
    const matchingRule = assistEntry?.rules.find(
      (rule) => rule.action === feature.featureIdentifier,
    );
    if (matchingRule === undefined) {
      return {
        isApplied: false,
        reason:
          "新增功能 `" + feature.featureIdentifier +
          "` 在**协同模式**声明中找不到对应规则：无法生成权限开关",
        rules: [...input.existingRules],
        addedCount: 0,
        removedCount: 0,
      };
    }
    addedRules.push({
      ruleIdentifier: feature.ruleIdentifier,
      toolName: input.declaration.toolPackageId,
      action: matchingRule.action,
      decision: matchingRule.decision,
      explanation: matchingRule.reason,
    });
  }

  return {
    isApplied: true,
    reason: null,
    rules: [...retainedRules, ...addedRules],
    addedCount: addedRules.length,
    removedCount,
  };
}
