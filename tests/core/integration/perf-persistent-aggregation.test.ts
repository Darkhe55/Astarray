/**
 * PERF-01-02 行为反例（持久聚合 / 分页 / 告警 / 故障注入）。
 *
 * 卡内点名五类反例：**高并发、进程退出、队列溢出、时钟变化、监测器失败**。
 * 本文件在实现之前必须失败。
 *
 * 冻结口径（OBS-01-01 契约 §4.1/§4.3）：事件信封 + 纯函数复算 + 样本与分母；
 * 估算与实测分离；**无法测量时不得报 0**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PerfEventStore,
  aggregatePerfSamples,
  derivePerfAlerts,
  paginatePerfSamples,
  type PerfSampleEvent,
} from "../../../packages/core/src/orchestration/perf-event-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-perf-"));
});

afterEach(async () => {
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
    sourceAgentInstanceId: "worker:mission-1:T-001:1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    requestIdentifier: "request-" + String(sequence),
    requestRevision: 1,
    origin: { kind: "local-estimate" },
    operationKind: "tool-call",
    durationMilliseconds: 10,
    outcome: "success",
    ...overrides,
  };
}

describe("PERF-01-02：五类故障反例", () => {
  it("① 高并发：并发追加不得丢样本、不得损坏行边界", async () => {
    const store = new PerfEventStore({ baseDirectory });
    const concurrentCount = 200;
    await Promise.all(
      Array.from({ length: concurrentCount }, (_unused, index) =>
        store.append(
          buildSample({
            requestIdentifier: "concurrent-" + String(index),
            durationMilliseconds: index,
          }),
        ),
      ),
    );
    const readBack = await store.readAll();
    expect(readBack).toHaveLength(concurrentCount);
    // 行边界不得被并发写坏：每个样本都必须可解析且标识唯一
    const identifiers = new Set(readBack.map((sample) => sample.requestIdentifier));
    expect(identifiers.size).toBe(concurrentCount);
  });

  it("② 进程退出：截断/半行写入不得使整份存储不可读", async () => {
    const store = new PerfEventStore({ baseDirectory });
    await store.append(buildSample({ requestIdentifier: "intact-1" }));
    await store.append(buildSample({ requestIdentifier: "intact-2" }));

    // 模拟进程在写第 3 条时退出：文件尾部留下半行 JSON。
    const eventsFilePath = path.join(baseDirectory, "perf", "samples.jsonl");
    await fs.appendFile(eventsFilePath, '{"observeEventVersion":1,"eventType":"perf","requ', "utf8");

    const readBack = await store.readAll();
    // 已完整写入的两条仍必须可读；半行被跳过而不是让整份不可读
    expect(readBack.map((sample) => sample.requestIdentifier)).toEqual(["intact-1", "intact-2"]);
    // 并且必须能报告"存在被丢弃的行"，而不是静默当作零
    const integrity = await store.readWithIntegrity();
    expect(integrity.samples).toHaveLength(2);
    expect(integrity.discardedLineCount).toBe(1);
  });

  it("③ 队列溢出：超过容量必须显式上报溢出，且仍保留已接收样本", async () => {
    const store = new PerfEventStore({ baseDirectory, maximumPendingSampleCount: 3 });
    for (let index = 0; index < 6; index += 1) {
      await store.append(buildSample({ requestIdentifier: "overflow-" + String(index) }));
    }
    const overflowReport = store.getOverflowReport();
    expect(overflowReport.droppedSampleCount).toBe(3);
    expect(overflowReport.isOverflowed).toBe(true);
    // 告警必须把它当作"监测降级"报出，绝不能显示为"一切正常"
    const alerts = derivePerfAlerts({
      metrics: aggregatePerfSamples(await store.readAll()),
      overflowReport,
    });
    expect(alerts.some((alert) => alert.alertKind === "monitor-overflow")).toBe(true);
  });

  it("④ 时钟变化：时间倒退不得产生负时长/负区间，且必须标注时钟异常", () => {
    const samples: PerfSampleEvent[] = [
      buildSample({ recordedAtIso: "2026-10-02T00:00:10.000Z", durationMilliseconds: 10 }),
      buildSample({ recordedAtIso: "2026-10-02T00:00:05.000Z", durationMilliseconds: 20 }),
      buildSample({ recordedAtIso: "2026-10-02T00:00:20.000Z", durationMilliseconds: 30 }),
    ];
    const metrics = aggregatePerfSamples(samples);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.windowStartIso).toBe("2026-10-02T00:00:05.000Z");
    expect(metrics.windowEndIso).toBe("2026-10-02T00:00:20.000Z");
    // 时钟倒退必须被标注，而不是算出一个负的时间窗
    expect(metrics.hasClockAnomaly).toBe(true);
  });

  it("⑤ 监测器失败：无法测量时必须报「不可测量」，不得报 0", () => {
    const alerts = derivePerfAlerts({
      metrics: null,
      overflowReport: { isOverflowed: false, droppedSampleCount: 0 },
      measurementFailureReason: "事件文件不可读",
    });
    expect(alerts.some((alert) => alert.alertKind === "monitor-unmeasurable")).toBe(true);
    // 不得出现"一切正常"的告警
    expect(alerts.some((alert) => alert.alertKind === "all-normal")).toBe(false);
    const unmeasurable = alerts.find((alert) => alert.alertKind === "monitor-unmeasurable");
    expect(unmeasurable?.detail).toContain("事件文件不可读");
  });
});

describe("PERF-01-02：真实执行路径测量", () => {
  it("⑨ 工具循环必须对真实工具执行上报耗时样本（含结果与工具名）", async () => {
    const { runToolLoop } = await import("../../../packages/core/src/runtime/tool-loop.js");
    const samples: Array<{ operationKind: string; outcome: string; toolName: string }> = [];

    // 夹具：**仅首轮**请求工具，次轮直接结束（否则每轮都调用工具，样本数随轮次增长）。
    let runtimeCallCount = 0;
    const scriptedRuntime = {
      async *run() {
        runtimeCallCount += 1;
        if (runtimeCallCount === 1) {
          yield {
            kind: "toolCallRequested" as const,
            callId: "call-1",
            toolName: "createProjectFile",
            argumentsJson: '{"filePath":".tmp/A.md","content":"# A\\n"}',
          };
          yield {
            kind: "runFinished" as const,
            agentId: "agent-1",
            reason: "tool-calls" as const,
            detail: "请求工具调用 1 个",
          };
          return;
        }
        yield { kind: "textDelta" as const, deltaText: "完成" };
        yield {
          kind: "runFinished" as const,
          agentId: "agent-1",
          reason: "success" as const,
          detail: "结束",
        };
      },
    };
    const toolPort = {
      async execute(_toolName: string, _argumentsJson: string, callId: string) {
        return {
          kind: "success" as const,
          callId,
          outputText: "已新建项目文件: .tmp/A.md",
          isSideEffectFree: false,
        };
      },
    };

    const cancellationController = new AbortController();
    const events: Array<{ kind: string }> = [];
    // runToolLoop 返回 Promise<AsyncIterable>：先 await 再迭代。
    const eventStream = await runToolLoop(
      {
        missionId: "mission-perf",
        agentId: "agent-1",
        systemPrompt: "sys",
        userPrompt: "创建 .tmp/A.md",
        availableToolDescriptors: [],
        maxLoopIterations: 2,
      },
      {
        runtime: scriptedRuntime as never,
        toolPort: toolPort as never,
        maxLoopIterations: 2,
        cancellationSignal: cancellationController.signal,
      perfSampleSink: (sample: {
        operationKind: string;
        outcome: "success" | "failure" | "cancelled" | "unknown";
        toolName: string;
      }) => {
        samples.push({
          operationKind: sample.operationKind,
          outcome: sample.outcome,
          toolName: sample.toolName,
        });
        },
      },
    );
    for await (const event of eventStream) {
      events.push(event as { kind: string });
    }

    // 上报必须真的发生，且带工具名与结果（不是空对象或占位）。
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      operationKind: "tool-call:createProjectFile",
      outcome: "success",
      toolName: "createProjectFile",
    });
    // 工具执行事件仍须照常产出（测量不得改变控制流）。
    expect(events.some((event) => event.kind === "toolCallFinished")).toBe(true);
  });
});

describe("PERF-01-02：聚合与分页", () => {
  it("⑥ 聚合输出样本量与分母，且平均/极值按实际样本计算", () => {
    const samples = [
      buildSample({ durationMilliseconds: 10, outcome: "success" }),
      buildSample({ durationMilliseconds: 20, outcome: "success" }),
      buildSample({ durationMilliseconds: 30, outcome: "failure" }),
    ];
    const metrics = aggregatePerfSamples(samples);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.denominators.successCount).toBe(2);
    expect(metrics.denominators.failureCount).toBe(1);
    expect(metrics.durationMilliseconds.minimum).toBe(10);
    expect(metrics.durationMilliseconds.maximum).toBe(30);
    expect(metrics.durationMilliseconds.mean).toBe(20);
  });

  it("⑦ 分页：稳定游标、不重不漏、越界返回空页", () => {
    const samples = Array.from({ length: 5 }, (_unused, index) =>
      buildSample({ requestIdentifier: "page-" + String(index) }),
    );
    const firstPage = paginatePerfSamples({ samples, pageSize: 2 });
    expect(firstPage.samples.map((sample) => sample.requestIdentifier)).toEqual(["page-0", "page-1"]);
    expect(firstPage.nextCursor).toBe("2");

    const secondPage = paginatePerfSamples({
      samples,
      pageSize: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.samples.map((sample) => sample.requestIdentifier)).toEqual(["page-2", "page-3"]);

    const thirdPage = paginatePerfSamples({
      samples,
      pageSize: 2,
      cursor: secondPage.nextCursor ?? undefined,
    });
    expect(thirdPage.samples.map((sample) => sample.requestIdentifier)).toEqual(["page-4"]);
    expect(thirdPage.nextCursor).toBeNull();

    const beyondEnd = paginatePerfSamples({ samples, pageSize: 2, cursor: "99" });
    expect(beyondEnd.samples).toHaveLength(0);
    expect(beyondEnd.nextCursor).toBeNull();
  });

  it("⑧ 无样本时不得报「零耗时正常」，而是明确样本不足", () => {
    const metrics = aggregatePerfSamples([]);
    expect(metrics.sampleSize).toBe(0);
    expect(metrics.isReportable).toBe(false);
    expect(metrics.unreportableReason).toContain("样本");
    // 关键：不得给出 0 作为"正常"的平均耗时
    expect(metrics.durationMilliseconds.mean).toBeNull();
  });
});
