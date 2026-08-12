/**
 * 指标注册表（T09）。
 * 覆盖：调用数、token（含 estimated 标记）、缓存状态（hit/miss/bypass/stale-reject）、
 * 峰值并发、消息延迟。
 */
import type { CacheStatus } from "./cache.js";

export interface TokenUsageRecord {
  provider: string;
  model: string;
  tokenCount: number;
  isEstimated: boolean;
}

export interface MetricsReport {
  totalCalls: number;
  totalTokenCount: number;
  estimatedTokenCount: number;
  exactTokenCount: number;
  cacheStatusCounts: Record<CacheStatus, number>;
  peakConcurrency: number;
  currentConcurrency: number;
  messageDeliveries: number;
  averageMessageLatencyMilliseconds: number | null;
  missionCount: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly tokenUsages: TokenUsageRecord[] = [];
  private readonly cacheStatusCounts: Record<CacheStatus, number> = {
    hit: 0,
    miss: 0,
    bypass: 0,
    "stale-reject": 0,
  };
  private currentConcurrency = 0;
  private peakConcurrency = 0;
  private totalMessageLatencyMilliseconds = 0;
  private messageDeliveryCount = 0;
  private missionCount = 0;

  incrementCounter(counterName: string, delta = 1): void {
    const currentValue = this.counters.get(counterName) ?? 0;
    this.counters.set(counterName, currentValue + delta);
  }

  getCounter(counterName: string): number {
    return this.counters.get(counterName) ?? 0;
  }

  recordToolCall(): void {
    this.incrementCounter("tool-calls");
  }

  recordProviderCall(): void {
    this.incrementCounter("provider-calls");
  }

  recordTokenUsage(usage: TokenUsageRecord): void {
    this.tokenUsages.push(usage);
  }

  recordCacheStatus(status: CacheStatus): void {
    this.cacheStatusCounts[status] += 1;
  }

  enterConcurrentSection(): void {
    this.currentConcurrency += 1;
    if (this.currentConcurrency > this.peakConcurrency) {
      this.peakConcurrency = this.currentConcurrency;
    }
  }

  leaveConcurrentSection(): void {
    this.currentConcurrency = Math.max(0, this.currentConcurrency - 1);
  }

  recordMessageDelivery(latencyMilliseconds: number): void {
    this.totalMessageLatencyMilliseconds += latencyMilliseconds;
    this.messageDeliveryCount += 1;
  }

  recordMissionCreated(): void {
    this.missionCount += 1;
  }

  getReport(): MetricsReport {
    const totalTokenCount = this.tokenUsages.reduce(
      (total, usage) => total + usage.tokenCount,
      0,
    );
    const estimatedTokenCount = this.tokenUsages
      .filter((usage) => usage.isEstimated)
      .reduce((total, usage) => total + usage.tokenCount, 0);
    return {
      totalCalls: this.getCounter("tool-calls") + this.getCounter("provider-calls"),
      totalTokenCount,
      estimatedTokenCount,
      exactTokenCount: totalTokenCount - estimatedTokenCount,
      cacheStatusCounts: { ...this.cacheStatusCounts },
      peakConcurrency: this.peakConcurrency,
      currentConcurrency: this.currentConcurrency,
      messageDeliveries: this.messageDeliveryCount,
      averageMessageLatencyMilliseconds:
        this.messageDeliveryCount === 0
          ? null
          : Math.round(
              this.totalMessageLatencyMilliseconds / this.messageDeliveryCount,
            ),
      missionCount: this.missionCount,
    };
  }
}
