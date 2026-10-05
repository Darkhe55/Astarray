/**
 * PERF-01-03 行为反例（最小概览接线 + 有界内存 + 只读性）。
 *
 * 卡内要求："SDK/CLI 及现有 TUI/GUI 最小概览接线和 tarball；长会话内存有界，
 * 休息时不产生模型/业务请求，无法测量不报零"。
 *
 * 本文件在实现之前必须失败（当时不存在 perf 概览查询与命令）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PerfEventStore,
  queryPerfOverview,
  type PerfSampleEvent,
} from "../../../packages/core/src/orchestration/perf-event-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-perf-overview-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

let sequence = 0;
function buildSample(overrides: Partial<PerfSampleEvent> = {}): PerfSampleEvent {
  sequence += 1;
  return {
    observeEventVersion: 1,
    eventType: "perf",
    recordedAtIso: "2026-10-02T00:00:00.000Z",
    sourceAgentInstanceId: "worker:mission-a:T-001:1",
    missionIdentifier: "mission-a",
    taskIdentifier: "T-001",
    requestIdentifier: "overview-" + String(sequence),
    requestRevision: 1,
    origin: { kind: "local-estimate" },
    operationKind: "tool-call:createProjectFile",
    durationMilliseconds: 10,
    outcome: "success",
    ...overrides,
  };
}

describe("PERF-01-03：最小概览查询", () => {
  it("① 概览必须回显覆盖范围（命中/总数），不得让调用方误以为看的是全量", async () => {
    const store = new PerfEventStore({ baseDirectory });
    await store.append(buildSample({ missionIdentifier: "mission-a" }));
    await store.append(buildSample({ missionIdentifier: "mission-b" }));
    await store.append(buildSample({ missionIdentifier: "mission-b" }));

    const overview = await queryPerfOverview({
      store,
      query: { missionIdentifier: "mission-b" },
    });
    expect(overview.coverage.totalSampleCount).toBe(3);
    expect(overview.coverage.matchedSampleCount).toBe(2);
    expect(overview.coverage.missionIdentifier).toBe("mission-b");
    expect(overview.metrics.sampleSize).toBe(2);
  });

  it("② 时间窗口必须真实生效，且回显实际窗口", async () => {
    const store = new PerfEventStore({ baseDirectory });
    await store.append(buildSample({ recordedAtIso: "2026-10-02T00:00:00.000Z" }));
    await store.append(buildSample({ recordedAtIso: "2026-10-02T01:00:00.000Z" }));
    await store.append(buildSample({ recordedAtIso: "2026-10-02T02:00:00.000Z" }));

    const overview = await queryPerfOverview({
      store,
      query: {
        windowStartIso: "2026-10-02T00:30:00.000Z",
        windowEndIso: "2026-10-02T01:30:00.000Z",
      },
    });
    expect(overview.coverage.matchedSampleCount).toBe(1);
    expect(overview.coverage.windowStartIso).toBe("2026-10-02T01:00:00.000Z");
    expect(overview.coverage.windowEndIso).toBe("2026-10-02T01:00:00.000Z");
  });

  it("③ 明细模式分页：不重不漏，游标可续，越界为空页", async () => {
    const store = new PerfEventStore({ baseDirectory });
    for (let index = 0; index < 5; index += 1) {
      await store.append(buildSample({ requestIdentifier: "detail-" + String(index) }));
    }
    const firstPage = await queryPerfOverview({
      store,
      query: { detailLevel: "detail", pageSize: 2 },
    });
    expect(firstPage.page?.samples.map((sample) => sample.requestIdentifier)).toEqual([
      "detail-0",
      "detail-1",
    ]);
    expect(firstPage.page?.nextCursor).toBe("2");

    const secondPage = await queryPerfOverview({
      store,
      query: { detailLevel: "detail", pageSize: 2, cursor: firstPage.page?.nextCursor ?? undefined },
    });
    expect(secondPage.page?.samples.map((sample) => sample.requestIdentifier)).toEqual([
      "detail-2",
      "detail-3",
    ]);

    const beyond = await queryPerfOverview({
      store,
      query: { detailLevel: "detail", pageSize: 2, cursor: "99" },
    });
    expect(beyond.page?.samples).toHaveLength(0);
    expect(beyond.page?.nextCursor).toBeNull();

    // 摘要模式不得返回分页明细
    const summary = await queryPerfOverview({ store, query: { detailLevel: "summary" } });
    expect(summary.page).toBeNull();
  });

  it("④ 无样本时不得报零耗时，必须明确不可报告", async () => {
    const store = new PerfEventStore({ baseDirectory });
    const overview = await queryPerfOverview({ store });
    expect(overview.metrics.sampleSize).toBe(0);
    expect(overview.metrics.durationMilliseconds.mean).toBeNull();
    expect(overview.metrics.isReportable).toBe(false);
    expect(overview.metrics.unreportableReason).toContain("样本");
  });

  it("⑤ 长会话内存有界：落盘总量增长，内存保留量恒不超过上限", async () => {
    const store = new PerfEventStore({ baseDirectory, maximumPendingSampleCount: 10 });
    for (let index = 0; index < 250; index += 1) {
      await store.append(buildSample({ requestIdentifier: "bounded-" + String(index) }));
    }
    // 内存保留有界（不随落盘总量无限增长）
    expect(store.getRetainedInMemorySampleCount()).toBe(10);
    // 落盘总量仍完整（可复算，不丢证据）
    const overview = await queryPerfOverview({ store });
    expect(overview.coverage.totalSampleCount).toBe(250);
    // 溢出必须显式暴露，而不是假装样本完整
    expect(store.getOverflowReport().isOverflowed).toBe(true);
    expect(store.getOverflowReport().droppedSampleCount).toBe(240);
    expect(overview.alerts.some((alert) => alert.alertKind === "monitor-overflow")).toBe(true);
  });

  it("⑥ 概览查询是只读的：不得发起任何网络/Provider 请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new PerfEventStore({ baseDirectory });
    await store.append(buildSample());
    await queryPerfOverview({ store, query: { detailLevel: "detail", pageSize: 10 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("⑦ CLI 概览命令：JSON 输出含覆盖范围与告警，且不产生网络请求", async () => {
    const { executePerfOverviewCommand } = await import(
      "../../../packages/tui/src/cli/commands.js"
    );
    const store = new PerfEventStore({ baseDirectory });
    await store.append(buildSample({ missionIdentifier: "mission-cli" }));
    await store.append(
      buildSample({ missionIdentifier: "mission-cli", outcome: "failure" }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const printedLines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        printedLines.push(String(chunk));
        return true;
      });
    try {
      const exitCode = await executePerfOverviewCommand({
        stateDirectory: baseDirectory,
        isJsonOutput: true,
        missionIdentifier: "mission-cli",
      });
      expect(exitCode).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }

    const parsed = JSON.parse(printedLines.join("")) as {
      coverage: { totalSampleCount: number; matchedSampleCount: number };
      metrics: { sampleSize: number };
      alerts: Array<{ alertKind: string }>;
    };
    expect(parsed.coverage.totalSampleCount).toBe(2);
    expect(parsed.coverage.matchedSampleCount).toBe(2);
    expect(parsed.metrics.sampleSize).toBe(2);
    expect(parsed.alerts.length).toBeGreaterThan(0);
    // 只读：概览不得触发任何网络请求（"休息时不产生模型/业务请求"的查询侧证据）
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("⑧ CLI 概览命令：非法参数必须用法错误，且不得静默按默认值执行", async () => {
    const { executePerfOverviewCommand } = await import(
      "../../../packages/tui/src/cli/commands.js"
    );
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(
        await executePerfOverviewCommand({
          stateDirectory: baseDirectory,
          isJsonOutput: true,
          detailLevel: "verbose",
        }),
      ).toBe(2);
      expect(
        await executePerfOverviewCommand({
          stateDirectory: baseDirectory,
          isJsonOutput: true,
          windowStartIso: "不是时间",
        }),
      ).toBe(2);
      expect(
        await executePerfOverviewCommand({
          stateDirectory: baseDirectory,
          isJsonOutput: true,
          pageSize: "0",
        }),
      ).toBe(2);
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
  });
});
