/**
 * TOOLKIT-01：**收益判断**（复用前的证据化评估，2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §2
 * 与检查点 06。
 *
 * 卡内硬要求逐条落实：
 *  - "收益判断**不设机械重复次数门槛**" ⇒ 本模块**没有**任何"次数 < N 即不做"的分支；
 *  - "记录预计复用次数、单次节省、构建/验证/维护成本及**不确定性**" ⇒ 逐项取值，
 *    缺任一项即判**证据不完整**（fail-closed，**不替用户默认补 0**）；
 *  - "自动发现**只提案**，不按高频日志自动批量造工具" ⇒ 自动来源的结论**最多**是 `propose`，
 *    且 `isAdoptionAuthorized` 恒为 false；
 *  - "自动节点保持 Agent 来源和优先层级 1 或以下" ⇒ 自动来源层级 >1 即判证据不完整。
 *
 * 计算口径（保守）：
 *  - 一律取**区间下限**估计（`isEstimatedFromRangeMinimum: true`），
 *    避免用乐观上限把"不值得"算成"值得"；
 *  - 净收益 = 复用次数下限 × 单次节省下限 − 构建成本 − 验证成本
 *    − 复用次数下限 × 每次维护成本。
 *
 * 本模块只做**本地确定性判定**：不执行工具、不做 I/O、不联网。
 */

export type ToolDiscoverySource = "user-request" | "automatic-discovery";

/** 区间估计（下限/上限，均带单位注释）。 */
export interface ToolBenefitRange {
  minimum: number;
  maximum: number;
}

export interface ToolBenefitEvidence {
  candidateIdentifier: string;
  discoverySource: ToolDiscoverySource;
  /** 预计复用次数（次）。 */
  expectedReuseCountRange: ToolBenefitRange;
  /** 单次节省（分钟）。 */
  savedMinutesPerUse: ToolBenefitRange;
  /** 构建成本（分钟，一次性）。 */
  buildCostMinutes: number;
  /** 验证成本（分钟，一次性）。 */
  verificationCostMinutes: number;
  /** 维护成本（分钟/次，摊销到每次复用）。 */
  maintenanceCostMinutesPerUse: number;
  /**
   * **不确定性说明**（卡内明确要求记录）。
   *
   * 空数组等同"未记录" ⇒ 证据不完整。
   */
  uncertaintyNotes: string[];
  /** 自动来源节点的优先层级（卡内要求 ≤ 1）。 */
  agentPriorityTier: number;
}

export type ToolBenefitRecommendation = "adopt" | "propose" | "do-not-adopt";

export interface ToolBenefitOutcome {
  isEvidenceComplete: boolean;
  recommendation: ToolBenefitRecommendation;
  reason: string | null;
  /** 区间下限口径下的净节省（分钟）；证据不完整时仍给出（便于诊断），但不可用于决策。 */
  netSavedMinutes: number;
  /** 是否采用区间下限（**恒为 true**，保守口径）。 */
  isEstimatedFromRangeMinimum: boolean;
  /** 结论是否可靠（区间过宽时不可靠）。 */
  isConclusionReliable: boolean;
  /** 是否**未**使用机械重复次数门槛（**恒为 false** 表示未应用任何次数阈值）。 */
  isRepetitionThresholdApplied: boolean;
  /** 是否已获"直接采用"授权（**自动来源恒为 false**）。 */
  isAdoptionAuthorized: boolean;
  /** 可读证据摘要（便于人工核对，不替代原始证据）。 */
  evidenceSummary: string;
}

/**
 * 区间宽度超过该倍数即认为"区间过宽 ⇒ 结论不可靠"。
 *
 * 校准说明（2026-10-10 由反例暴露）：初版用 10× 且对**任意**区间生效，
 * 结果把"构建 60–120 分钟"这类**正常估计**也判成不可靠，于是本该 `adopt` 的候选
 * 被降级为 `propose`。改为 5× 并叠加"绝对跨度下限"，
 * 使小量级区间的轻微倍数不触发降级。
 */
const UNRELIABLE_RANGE_SPREAD_MULTIPLIER = 5;

/** 绝对跨度低于该分钟数时，不因倍数而判不可靠（避免小量级误判）。 */
const UNRELIABLE_RANGE_ABSOLUTE_SPAN_MINUTES = 60;

function isValidRange(range: unknown): range is ToolBenefitRange {
  if (range === null || typeof range !== "object") {
    return false;
  }
  const candidate = range as { minimum?: unknown; maximum?: unknown };
  return (
    typeof candidate.minimum === "number" &&
    Number.isFinite(candidate.minimum) &&
    typeof candidate.maximum === "number" &&
    Number.isFinite(candidate.maximum) &&
    candidate.minimum >= 0 &&
    candidate.maximum >= candidate.minimum
  );
}

function isValidMinuteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 判定"区间是否过宽到结论不可靠"。
 *
 * 说明：**不**把"宽区间"当作失败——卡内要求的是**如实记录不确定性**，
 * 因此这里降级为 `propose`（提案）而不是直接拒绝。
 */
function isRangeTooWideToConclude(range: ToolBenefitRange): boolean {
  if (range.minimum === 0) {
    // 下限为 0（完全可能不产生收益）⇒ 无法据下限得出可靠结论。
    return true;
  }
  const spread = range.maximum - range.minimum;
  if (spread < UNRELIABLE_RANGE_ABSOLUTE_SPAN_MINUTES) {
    // 绝对跨度很小（例如"节省 10–20 分钟"）⇒ 不因倍数降级。
    return false;
  }
  return range.maximum / range.minimum >= UNRELIABLE_RANGE_SPREAD_MULTIPLIER;
}

/**
 * 构造可读摘要。
 *
 * **必须容忍缺失字段**（2026-10-10 由反例 ② 暴露）：初版直接读取
 * `evidence.expectedReuseCountRange.minimum`，当调用方漏传该字段时**抛异常**，
 * 而卡内要求的是"缺项 ⇒ **判为证据不完整**"这一**结果**，不是崩掉。
 * 判定的健壮性属于契约的一部分：fail-closed 要返回结论，而不是异常。
 */
function buildSummary(evidence: ToolBenefitEvidence, netSavedMinutes: number): string {
  const describeRange = (
    range: ToolBenefitRange | undefined,
    unit: string,
  ): string =>
    isValidRange(range)
      ? String(range.minimum) + "–" + String(range.maximum) + " " + unit
      : "（未记录）";
  return (
    "复用次数 " +
    describeRange(evidence.expectedReuseCountRange, "次") +
    "；单次节省 " +
    describeRange(evidence.savedMinutesPerUse, "分钟") +
    "；构建 " +
    (isValidMinuteCount(evidence.buildCostMinutes)
      ? String(evidence.buildCostMinutes) + " 分钟"
      : "（未记录）") +
    "；验证 " +
    (isValidMinuteCount(evidence.verificationCostMinutes)
      ? String(evidence.verificationCostMinutes) + " 分钟"
      : "（未记录）") +
    "；维护 " +
    (isValidMinuteCount(evidence.maintenanceCostMinutesPerUse)
      ? String(evidence.maintenanceCostMinutesPerUse) + " 分钟/次"
      : "（未记录）") +
    "；区间下限口径净节省 " +
    String(netSavedMinutes) +
    " 分钟；不确定性：" +
    (Array.isArray(evidence.uncertaintyNotes) && evidence.uncertaintyNotes.length > 0
      ? evidence.uncertaintyNotes.filter((note) => typeof note === "string").join("；")
      : "（未记录）")
  );
}

/**
 * 评估是否值得把候选沉淀为工具。
 *
 * **不设机械重复次数门槛**：本函数内**没有**任何"次数必须 ≥ N"的判断；
 * 只以"区间下限口径的净收益"与"结论可靠性"决定建议。
 */
export function evaluateToolBenefit(evidence: ToolBenefitEvidence): ToolBenefitOutcome {
  const uncertaintyNotes = Array.isArray(evidence.uncertaintyNotes)
    ? evidence.uncertaintyNotes.filter((note) => typeof note === "string" && note !== "")
    : [];

  const incompleteReason = (() => {
    if (!isValidRange(evidence.expectedReuseCountRange)) {
      return "缺少有效的预计复用次数区间";
    }
    if (!isValidRange(evidence.savedMinutesPerUse)) {
      return "缺少有效的单次节省区间";
    }
    if (!isValidMinuteCount(evidence.buildCostMinutes)) {
      return "缺少有效的构建成本";
    }
    if (!isValidMinuteCount(evidence.verificationCostMinutes)) {
      return "缺少有效的验证成本";
    }
    if (!isValidMinuteCount(evidence.maintenanceCostMinutesPerUse)) {
      return "缺少有效的维护成本";
    }
    if (uncertaintyNotes.length === 0) {
      return "缺少不确定性说明（卡内要求必须记录）";
    }
    if (
      evidence.discoverySource === "automatic-discovery" &&
      !(typeof evidence.agentPriorityTier === "number" && evidence.agentPriorityTier <= 1)
    ) {
      return "自动来源节点的优先层级必须 ≤ 1（当前 " + String(evidence.agentPriorityTier) + "）";
    }
    return null;
  })();

  /**
   * 计算区间下限口径的净节省。
   *
   * 证据不完整时仍计算（便于诊断），但结论不会是 `adopt`。
   */
  const reuseCountMinimum = isValidRange(evidence.expectedReuseCountRange)
    ? evidence.expectedReuseCountRange.minimum
    : 0;
  const savedMinutesMinimum = isValidRange(evidence.savedMinutesPerUse)
    ? evidence.savedMinutesPerUse.minimum
    : 0;
  const buildCostMinutes = isValidMinuteCount(evidence.buildCostMinutes)
    ? evidence.buildCostMinutes
    : 0;
  const verificationCostMinutes = isValidMinuteCount(evidence.verificationCostMinutes)
    ? evidence.verificationCostMinutes
    : 0;
  const maintenanceCostMinutesPerUse = isValidMinuteCount(
    evidence.maintenanceCostMinutesPerUse,
  )
    ? evidence.maintenanceCostMinutesPerUse
    : 0;
  const netSavedMinutes =
    reuseCountMinimum * savedMinutesMinimum -
    buildCostMinutes -
    verificationCostMinutes -
    reuseCountMinimum * maintenanceCostMinutesPerUse;

  const evidenceSummary = buildSummary(evidence, netSavedMinutes);

  if (incompleteReason !== null) {
    return {
      isEvidenceComplete: false,
      recommendation: "do-not-adopt",
      reason: incompleteReason,
      netSavedMinutes,
      isEstimatedFromRangeMinimum: true,
      isConclusionReliable: false,
      isRepetitionThresholdApplied: false,
      isAdoptionAuthorized: false,
      evidenceSummary,
    };
  }

  const isConclusionReliable =
    !isRangeTooWideToConclude(evidence.expectedReuseCountRange) &&
    !isRangeTooWideToConclude(evidence.savedMinutesPerUse);

  /** 自动来源**只提案**：绝不直接采用。 */
  if (evidence.discoverySource === "automatic-discovery") {
    return {
      isEvidenceComplete: true,
      recommendation: "propose",
      reason:
        "自动发现只产生**提案**，需用户明确批准后才可创建/启用（不按高频日志自动批量造工具）",
      netSavedMinutes,
      isEstimatedFromRangeMinimum: true,
      isConclusionReliable,
      isRepetitionThresholdApplied: false,
      isAdoptionAuthorized: false,
      evidenceSummary,
    };
  }

  /**
   * 先按**保守口径**判负：下限口径已经为负 ⇒ 直接 `do-not-adopt`。
   *
   * 顺序说明（2026-10-10 由反例 ⑨ 暴露）：不确定性只会把"可能值得"降级为提案，
   * **不应**掩盖"下限口径已经不值得"这一确定结论。故此处先判负、后判可靠性。
   */
  if (netSavedMinutes <= 0) {
    return {
      isEvidenceComplete: true,
      recommendation: "do-not-adopt",
      reason:
        "区间下限口径净收益不为正（净节省 " +
        String(netSavedMinutes) +
        " 分钟）：构建/验证/维护成本未被节省覆盖，不值得沉淀为工具",
      netSavedMinutes,
      isEstimatedFromRangeMinimum: true,
      isConclusionReliable: !isConclusionReliable,
      isRepetitionThresholdApplied: false,
      isAdoptionAuthorized: false,
      evidenceSummary,
    };
  }

  if (!isConclusionReliable) {
    return {
      isEvidenceComplete: true,
      recommendation: "propose",
      reason:
        "不确定性过高（区间过宽或下限为 0），**不能据下限得出可靠结论**，故只提案不做采用决定",
      netSavedMinutes,
      isEstimatedFromRangeMinimum: true,
      isConclusionReliable: false,
      isRepetitionThresholdApplied: false,
      isAdoptionAuthorized: false,
      evidenceSummary,
    };
  }

  return {
    isEvidenceComplete: true,
    recommendation: "adopt",
    reason: null,
    netSavedMinutes,
    isEstimatedFromRangeMinimum: true,
    isConclusionReliable: true,
    isRepetitionThresholdApplied: false,
    // 注意：`adopt` 仅表示"建议采用"；真正的创建/启用仍受登记、独立验证与权限门禁约束。
    isAdoptionAuthorized: false,
    evidenceSummary,
  };
}
