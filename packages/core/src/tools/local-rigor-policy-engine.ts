/**
 * 本地严谨性策略引擎（T06D / ADR-0016）。
 * 用本地版本化规则把任务标记为 standard / high：
 * 法律、医疗、财务、安全边界、破坏性操作、发布决策、身份/权限、
 * 时效性事实以及用户明确要求严格验证的任务默认 high。
 * 模型可以请求提高等级，不能自行降低本地或用户指定等级。
 */
import type { RigorLevel } from "../core/types.js";

export const RIGOR_RULES_VERSION = 1;

export interface RigorClassification {
  rigorLevel: RigorLevel;
  matchedRuleIds: string[];
  rulesVersion: number;
}

/** 高严谨性触发规则（本地静态，版本化）。 */
const HIGH_RIGOR_RULES: Array<{ ruleId: string; pattern: RegExp }> = [
  { ruleId: "legal", pattern: /(法律|法规|合规|诉讼|合同|条款|GDPR|许可证|合规性)/i },
  { ruleId: "medical", pattern: /(医疗|药物|剂量|诊断|患者|临床试验|健康建议)/i },
  { ruleId: "financial", pattern: /(财务|股价|投资|利率|汇率|税务|财报|预算决策)/i },
  { ruleId: "security-boundary", pattern: /(安全边界|权限|授权|越权|凭据|漏洞|攻击面)/i },
  { ruleId: "destructive-operation", pattern: /(删除|覆盖|清空|重置|回滚|不可逆|破坏性)/i },
  { ruleId: "publishing-decision", pattern: /(发布|上线|部署|对外公布|公告|推送)/i },
  { ruleId: "identity-permission", pattern: /(身份|账号|口令|API[ _-]?key|令牌|密码)/i },
  { ruleId: "time-sensitive-fact", pattern: /(最新|当前|截至|时效|过期|今天|本月|实时)/i },
  { ruleId: "user-requested-strict", pattern: /(严格验证|严格核查|必须核实|确凿|可靠来源)/i },
];

export class LocalRigorPolicyEngine {
  /** 本地版本化规则标记严谨性（规则命中任意一条即 high）。 */
  classifyRigor(taskDescription: string): RigorClassification {
    const matchedRuleIds: string[] = [];
    for (const rule of HIGH_RIGOR_RULES) {
      if (rule.pattern.test(taskDescription)) {
        matchedRuleIds.push(rule.ruleId);
      }
    }
    return {
      rigorLevel: matchedRuleIds.length > 0 ? "high" : "standard",
      matchedRuleIds,
      rulesVersion: RIGOR_RULES_VERSION,
    };
  }

  /**
   * 解析最终严谨性等级：模型/Agent 只能上调（standard → high），
   * 不能下调本地或用户指定的 high；请求下调被拒绝并返回本地等级。
   */
  resolveRigorLevel(input: {
    baseLevel: RigorLevel;
    requestedLevel: RigorLevel;
  }): { rigorLevel: RigorLevel; isDowngradeRejected: boolean } {
    const baseRank = input.baseLevel === "high" ? 1 : 0;
    const requestedRank = input.requestedLevel === "high" ? 1 : 0;
    if (requestedRank < baseRank) {
      return { rigorLevel: input.baseLevel, isDowngradeRejected: true };
    }
    return { rigorLevel: input.requestedLevel, isDowngradeRejected: false };
  }
}
