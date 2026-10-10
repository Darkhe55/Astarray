/**
 * MERGE-01-01/02：**参数级授权**的声明式规则与判定（2026-10-10）。
 *
 * 契约来源：MERGE-01 卡 §1.3。
 *
 * 为什么先是纯函数：卡内要求"**禁止可执行脚本、任意正则或让模型解析授权条件**"，
 * 且优先规则（deny > ask > allow）必须是**本地确定性**判定。把它做成不依赖 I/O 的
 * 纯函数，才能用反例逐条钉住优先级与 fail-closed 行为；设置入口（第 4 项）与
 * 权限引擎接线在其之上，不改变此处语义。
 *
 * 硬规则：
 *  - `isParameterAuthorizationEnabled`（总开关）**或** `isParameterRulesEnabled`（该工具细分）
 *    任一为 false ⇒ 一律回退**工具基线**（统一授权）；
 *  - 均开启时：**已匹配**的参数规则覆盖基线（`source = "parameter-rule"`），未匹配回退基线；
 *  - 多条规则同时匹配 ⇒ **deny > ask > allow**（与声明顺序无关）；
 *  - 工具基线为 `deny` ⇒ **总拒绝**，不被参数 `allow` 覆盖；
 *  - 参数不可解析、规则 action 不匹配、匹配种类/字段不认识 ⇒ **不套用规则**（回退基线，不猜测）。
 */
import type { PermissionDecision } from "./permission-capability-catalog.js";

export type ParameterRuleMatch =
  | { kind: "path-prefix"; field: string; prefix: string }
  | { kind: "allowed-values"; field: string; values: string[] }
  | { kind: "fixed-value"; field: string; value: string }
  | { kind: "numeric-range"; field: string; minimum: number; maximum: number };

export interface ParameterAuthorizationRule {
  toolName: string;
  /** 仅在该 action 下生效；不匹配即不套用（不同 action 不得互相覆盖）。 */
  action: string;
  decision: PermissionDecision;
  /** 人可读解释（卡内要求"每条规则有可读解释"）。 */
  explanation: string;
  /** 缺省表示"该 action 一律匹配"。 */
  match?: ParameterRuleMatch;
}

export interface ParameterAuthorizationSettings {
  /** 参数级授权**总开关**（初始关闭以兼容旧配置）。 */
  isParameterAuthorizationEnabled: boolean;
  /** 该工具的"启用参数细分"开关。 */
  isParameterRulesEnabled: boolean;
}

export interface ParameterAuthorizationOutcome {
  decision: PermissionDecision;
  /** 裁决来源：工具基线还是某条参数规则。 */
  source: "tool-baseline" | "parameter-rule";
  /** 生效规则的可读解释；未套用规则时为 null。 */
  appliedRuleExplanation: string | null;
  /** 是否因总开关/细分开关关闭而未评估规则。 */
  isRuleEvaluationSkipped: boolean;
}

/** 规则→裁决的优先级（卡内：deny 优先于 ask，ask 优先于 allow）。 */
const DECISION_PRIORITY: Record<PermissionDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function readField(parsedArguments: Record<string, unknown>, field: string): unknown {
  return parsedArguments[field];
}

/**
 * 单条规则是否匹配。**任何不认识的形态都判不匹配**（fail-closed：不套用规则）。
 */
function doesRuleMatch(input: {
  rule: ParameterAuthorizationRule;
  action: string;
  parsedArguments: Record<string, unknown> | null;
}): boolean {
  const { rule, action, parsedArguments } = input;
  if (rule.toolName === "" || rule.action === "" || rule.action !== action) {
    return false;
  }
  if (rule.match === undefined) {
    // 无 match：该 action 一律匹配（仍是显式的 action 绑定，不是通配）。
    return true;
  }
  if (parsedArguments === null) {
    return false;
  }
  const fieldValue = readField(parsedArguments, rule.match.field);
  switch (rule.match.kind) {
    case "path-prefix": {
      if (typeof fieldValue !== "string") {
        return false;
      }
      const normalizedPrefix = rule.match.prefix.replace(/\/$/, "");
      return fieldValue === normalizedPrefix || fieldValue.startsWith(normalizedPrefix + "/");
    }
    case "allowed-values": {
      return typeof fieldValue === "string" && rule.match.values.includes(fieldValue);
    }
    case "fixed-value": {
      return typeof fieldValue === "string" && fieldValue === rule.match.value;
    }
    case "numeric-range": {
      if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
        return false;
      }
      return fieldValue >= rule.match.minimum && fieldValue <= rule.match.maximum;
    }
    default:
      // 未知匹配种类（含未来扩展或非法导入）：不匹配。
      return false;
  }
}

/** 解析完整规范化参数；不可解析时返回 null（调用方据此不套用任何规则）。 */
function parseArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 判定一次调用的**有效参数级授权**。
 *
 * 只做规则层判定；结果仍须与更外层权限上限、项目边界、模式与专用授权门禁**求交**
 * （卡内 §1.3 结尾），本函数不替代那些门禁。
 */
export function evaluateParameterAuthorization(input: {
  toolName: string;
  action: string;
  argumentsJson: string;
  /** 该工具在当前 profile 下的统一授权（三态基线）。 */
  baselineDecision: PermissionDecision;
  settings: ParameterAuthorizationSettings;
  rules: ParameterAuthorizationRule[];
}): ParameterAuthorizationOutcome {
  const baselineOutcome = (isRuleEvaluationSkipped: boolean): ParameterAuthorizationOutcome => ({
    decision: input.baselineDecision,
    source: "tool-baseline",
    appliedRuleExplanation: null,
    isRuleEvaluationSkipped,
  });

  // 工具基线明确 deny 是总拒绝：参数规则（尤其 allow）不得覆盖。
  if (input.baselineDecision === "deny") {
    return baselineOutcome(false);
  }
  // 总开关或该工具细分关闭 ⇒ 统一授权（规则完全不评估）。
  if (
    !input.settings.isParameterAuthorizationEnabled ||
    !input.settings.isParameterRulesEnabled
  ) {
    return baselineOutcome(true);
  }

  const parsedArguments = parseArguments(input.argumentsJson);
  const matchingRules = input.rules.filter((rule) =>
    doesRuleMatch({ rule, action: input.action, parsedArguments }),
  );
  if (matchingRules.length === 0) {
    // 未匹配 ⇒ 回退基线。
    return baselineOutcome(false);
  }

  // 冲突时 deny > ask > allow（与声明顺序无关）。
  const [firstMatchingRule, ...otherMatchingRules] = matchingRules as [
    ParameterAuthorizationRule,
    ...ParameterAuthorizationRule[],
  ];
  let governingRule = firstMatchingRule;
  for (const candidate of otherMatchingRules) {
    if (
      DECISION_PRIORITY[candidate.decision] > DECISION_PRIORITY[governingRule.decision]
    ) {
      governingRule = candidate;
    }
  }
  return {
    decision: governingRule.decision,
    source: "parameter-rule",
    appliedRuleExplanation: governingRule.explanation,
    isRuleEvaluationSkipped: false,
  };
}
