/**
 * 工具连续失败计数器（T05，冻结决策：默认阈值 3，任意一次成功后对应工具计数清零）。
 */
import { DEFAULT_TOOL_FAILURE_THRESHOLD } from "../core/types.js";

export class ToolFailureCounter {
  private readonly consecutiveFailureCounts = new Map<string, number>();

  constructor(
    private readonly threshold: number = DEFAULT_TOOL_FAILURE_THRESHOLD,
  ) {
    if (threshold < 1) {
      throw new Error(`失败阈值必须 ≥ 1，收到 ${threshold}`);
    }
  }

  /**
   * 记录一次失败。返回 true 表示达到阈值（调用方应暂停并反馈），
   * 达到阈值后该工具计数清零，重新开始计数。
   */
  recordFailure(toolName: string): boolean {
    const nextCount = (this.consecutiveFailureCounts.get(toolName) ?? 0) + 1;
    if (nextCount >= this.threshold) {
      this.consecutiveFailureCounts.delete(toolName);
      return true;
    }
    this.consecutiveFailureCounts.set(toolName, nextCount);
    return false;
  }

  /** 任意一次成功后对应工具计数清零。 */
  recordSuccess(toolName: string): void {
    this.consecutiveFailureCounts.delete(toolName);
  }

  getConsecutiveFailureCount(toolName: string): number {
    return this.consecutiveFailureCounts.get(toolName) ?? 0;
  }
}
