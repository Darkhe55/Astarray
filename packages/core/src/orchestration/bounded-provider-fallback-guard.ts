/**
 * 有界 Provider fallback 守卫（T07C-04 / ADR-0026 §6）。
 *
 * 超时、限流、能力不匹配或 Provider 故障时只能按有效列表进行有界
 * fallback：同一任务有 fallback 次数预算与退避间隔；目标 Provider 切换
 * 前执行本地数据出境与内容策略（不允许发送的内容不能因故障切换转移到
 * 另一个 Provider）；检测 fallback 环（A→B→A）与无进展重试，防止在
 * 多个 Provider 间活锁。
 */
/** 数据出境策略端口（本地版本化规则；不依赖云端/AI 判断）。 */
export interface DataEgressPolicyPort {
  /**
   * 内容是否允许发送到指定区域（本地规则；不允许 → 该 Provider 不可用）。
   */
  isContentEgressAllowed(input: {
    regionLabel: string;
    contentCategory: string;
  }): boolean;
}

export interface BoundedProviderFallbackGuardOptions {
  /** 同任务 fallback 次数预算（默认 3）。 */
  maxFallbackAttemptsPerTask?: number;
  /** fallback 退避基础间隔（毫秒；成功/失败后按预算内增长）。 */
  baseBackoffMilliseconds?: number;
  dataEgressPolicyPort: DataEgressPolicyPort;
}

export interface GuardFallbackAttemptInput {
  taskIdentifier: string;
  /** 当前尝试中的目标 Provider/模型。 */
  targetModelProfileId: string;
  /** 此前已尝试过的模型列表（fallback 环检测）。 */
  previouslyAttemptedModelProfileIds: string[];
  /** 当前任务已 fallback 次数。 */
  currentFallbackCount: number;
  /** 距离上次 fallback 的间隔（毫秒；退避检查）。 */
  elapsedSinceLastFallbackMilliseconds: number;
  /** 待发送内容类别（数据出境策略判定）。 */
  contentCategory: string;
  /** 目标 Provider 区域（数据出境策略判定）。 */
  targetRegionLabel: string;
}

export interface FallbackGuardResult {
  isAllowed: boolean;
  blockedReason: string | null;
}

export class BoundedProviderFallbackGuard {
  private readonly maxFallbackAttemptsPerTask: number;
  private readonly baseBackoffMilliseconds: number;
  private readonly dataEgressPolicyPort: DataEgressPolicyPort;

  constructor(options: BoundedProviderFallbackGuardOptions) {
    this.maxFallbackAttemptsPerTask = options.maxFallbackAttemptsPerTask ?? 3;
    this.baseBackoffMilliseconds = options.baseBackoffMilliseconds ?? 2_000;
    this.dataEgressPolicyPort = options.dataEgressPolicyPort;
  }

  /**
   * 守卫一次 fallback 尝试：
   * 1) 预算未耗尽；2) 退避间隔满足（质数增长序列的近似：base × 2^n）；
   * 3) 目标 Provider 数据出境允许；4) 不在已尝试列表（防 A→B→A 环）。
   */
  guardFallbackAttempt(
    input: GuardFallbackAttemptInput,
  ): FallbackGuardResult {
    if (input.currentFallbackCount >= this.maxFallbackAttemptsPerTask) {
      return {
        isAllowed: false,
        blockedReason: `同任务 fallback 次数已达预算 ${this.maxFallbackAttemptsPerTask}`,
      };
    }
    const requiredBackoffMilliseconds =
      this.baseBackoffMilliseconds * 2 ** input.currentFallbackCount;
    if (input.elapsedSinceLastFallbackMilliseconds < requiredBackoffMilliseconds) {
      return {
        isAllowed: false,
        blockedReason: `退避中（需 ${requiredBackoffMilliseconds}ms，已过 ${input.elapsedSinceLastFallbackMilliseconds}ms）`,
      };
    }
    if (
      !this.dataEgressPolicyPort.isContentEgressAllowed({
        regionLabel: input.targetRegionLabel,
        contentCategory: input.contentCategory,
      })
    ) {
      return {
        isAllowed: false,
        blockedReason: `内容类别 ${input.contentCategory} 不允许出境到区域 ${input.targetRegionLabel}（数据出境策略）`,
      };
    }
    if (input.previouslyAttemptedModelProfileIds.includes(input.targetModelProfileId)) {
      return {
        isAllowed: false,
        blockedReason: `fallback 环检测：模型 ${input.targetModelProfileId} 已尝试过（A→B→A）`,
      };
    }
    return { isAllowed: true, blockedReason: null };
  }
}