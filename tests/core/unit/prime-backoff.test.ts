import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
} from "../../../packages/core/src/core/types.js";
import { calculatePrimeBackoffSeconds } from "../../../packages/core/src/feedback-process/prime-backoff.js";

describe("calculatePrimeBackoffSeconds", () => {
  it("前五轮为质数序列 2, 3, 5, 7, 11", () => {
    const sequence = [1, 2, 3, 4, 5].map((attemptNumber) =>
      calculatePrimeBackoffSeconds(attemptNumber),
    );
    expect(sequence).toEqual([2, 3, 5, 7, 11]);
  });

  it("持续忙碌时等待值不递减", () => {
    let previousValue = 0;
    for (let attemptNumber = 1; attemptNumber <= 50; attemptNumber++) {
      const currentValue = calculatePrimeBackoffSeconds(attemptNumber);
      expect(currentValue).toBeGreaterThanOrEqual(previousValue);
      previousValue = currentValue;
    }
  });

  it("达到 10,800 秒上限后保持上限不再增长", () => {
    // 10799 是 ≤10800 的最大质数；超过其序位后应稳定在 10800
    let previousValue = 0;
    for (let attemptNumber = 1; attemptNumber <= 5000; attemptNumber++) {
      const currentValue = calculatePrimeBackoffSeconds(attemptNumber);
      expect(currentValue).toBeLessThanOrEqual(
        DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
      );
      expect(currentValue).toBeGreaterThanOrEqual(previousValue);
      previousValue = currentValue;
    }
    expect(previousValue).toBe(DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS);
  });

  it("第 0 轮（非法输入）回落到首轮 2 秒", () => {
    expect(calculatePrimeBackoffSeconds(0)).toBe(2);
  });

  it("默认封顶与冻结决策一致", () => {
    expect(DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS).toBe(10_800);
  });

  it("自定义上限生效", () => {
    const sequence = [1, 2, 3, 4, 5, 6].map((attemptNumber) =>
      calculatePrimeBackoffSeconds(attemptNumber, 7),
    );
    expect(sequence).toEqual([2, 3, 5, 7, 7, 7]);
  });
});
