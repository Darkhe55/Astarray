/**
 * PERF 事件类型守卫与空样本汇总的**边界分支**补测
 * （E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * `isPerfSampleEvent` 一个函数就含 7 条未覆盖分支（L160 的 null/非对象、
 * L165-L168 四个短路条件），且语义值得钉死：
 * `PERF_SAMPLE_EVENT_TYPES` 含 `"perf"/"usage"/"diagnostic"`，但**只有 `"perf"` 算采样事件**——
 * 即"在集合内但不是 perf"必须返回 false（否则 usage/diagnostic 事件会被当成性能样本统计）。
 *
 * 另补 `aggregatePerfSamples([])`：无样本时耗时结论必须是 **null 而不是 0**
 * （反例⑧：绝不报 0 冒充正常）。
 *
 * 断言均为行为断言（断言返回值与具体字段），不是凑覆盖的空断言。
 */
import { describe, expect, it } from "vitest";

import {
  aggregatePerfSamples,
  isPerfSampleEvent,
} from "../../../packages/core/src/orchestration/perf-event-store.js";

describe("isPerfSampleEvent：类型守卫边界", () => {
  it("null 不是 PERF 样本（触发 value === null 分支）", () => {
    expect(isPerfSampleEvent(null)).toBe(false);
  });

  it("非对象（字符串/数字）不是 PERF 样本（触发 typeof !== 'object' 分支）", () => {
    expect(isPerfSampleEvent("perf")).toBe(false);
    expect(isPerfSampleEvent(42)).toBe(false);
  });

  it("缺少 eventType 的对象不是 PERF 样本（触发 typeof string 假分支）", () => {
    expect(isPerfSampleEvent({})).toBe(false);
  });

  it("eventType 不在集合内时不是 PERF 样本（触发集合判定假分支）", () => {
    expect(isPerfSampleEvent({ eventType: "other", durationMilliseconds: 5 })).toBe(false);
  });

  it("在集合内但不是 perf（usage/diagnostic）不是 PERF 样本——不得混入性能统计", () => {
    expect(isPerfSampleEvent({ eventType: "usage", durationMilliseconds: 5 })).toBe(false);
    expect(isPerfSampleEvent({ eventType: "diagnostic", durationMilliseconds: 5 })).toBe(false);
  });

  it("eventType=perf 但耗时不是数字时不是 PERF 样本（触发耗时判定假分支）", () => {
    expect(isPerfSampleEvent({ eventType: "perf" })).toBe(false);
    expect(isPerfSampleEvent({ eventType: "perf", durationMilliseconds: "5" })).toBe(false);
  });

  it("eventType=perf 且耗时为数字时才是 PERF 样本（全真分支）", () => {
    expect(isPerfSampleEvent({ eventType: "perf", durationMilliseconds: 12 })).toBe(true);
  });
});

describe("aggregatePerfSamples：空样本", () => {
  it("无样本时耗时结论为 null（不得报 0 冒充正常），样本量为 0", () => {
    const metrics = aggregatePerfSamples([]);
    expect(metrics.sampleSize).toBe(0);
    expect(metrics.durationMilliseconds.mean).toBeNull();
    expect(metrics.durationMilliseconds.minimum).toBeNull();
    expect(metrics.durationMilliseconds.maximum).toBeNull();
    expect(metrics.durationMilliseconds.p95).toBeNull();
    expect(metrics.denominators.successCount).toBe(0);
    expect(metrics.denominators.failureCount).toBe(0);
    expect(metrics.hasClockAnomaly).toBe(false);
  });
});
