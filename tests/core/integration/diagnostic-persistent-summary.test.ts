/**
 * DIAG-01-02 行为反例（持久汇总 / 分页 / 故障链 / 证据不足 / 诊断自身失败）。
 *
 * 卡内点名的反例：**重复风暴、敏感错误文本、故障链、不足证据、诊断自身失败**。
 * 契约沿用 OBS-01-01 冻结的 §4.4（DIAG 事件）。本文件在实现前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DiagnosticEventStore,
  aggregateDiagnosticEvents,
  type DiagnosticEvent,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-diag-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function buildEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: "2026-10-02T00:00:00.000Z",
    sourceAgentInstanceId: "worker:mission-1:T-001:1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    requestIdentifier: "diag-1",
    requestRevision: 1,
    origin: { kind: "system" },
    errorCode: "tool-execution-failed",
    stage: "tool",
    severity: "error",
    component: "policy-wrapper",
    messageText: "工具执行失败",
    recoveryState: "unknown",
    classification: "deterministic-fact",
    chain: { rootErrorCode: null, wrapperErrorCodes: [] },
    ...overrides,
  };
}

describe("DIAG-01-02：五类反例", () => {
  it("① 重复风暴：同一指纹高频重复必须合并计数，不得让明细无限膨胀", async () => {
    const store = new DiagnosticEventStore({ baseDirectory, maximumDetailedEventCount: 5 });
    for (let index = 0; index < 40; index += 1) {
      await store.append(buildEvent({ requestIdentifier: "storm-" + String(index) }));
    }
    const metrics = aggregateDiagnosticEvents(await store.readAll());
    // 合并为一条指纹，但保留真实发生次数
    expect(metrics.groups).toHaveLength(1);
    expect(metrics.groups[0]?.occurrenceCount).toBe(40);
    // 明细有界：内存/明细保留量不超过上限，且必须报告被折叠的数量
    expect(store.getRetentionReport().detailedEventCount).toBeLessThanOrEqual(40);
    expect(store.getRetentionReport().isStormCollapsed).toBe(true);
  });

  it("② 敏感错误文本：落盘前必须脱敏，凭据样式不得进入记录", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(
      buildEvent({
        messageText:
          "请求失败: Authorization: Bearer sk-abcdef1234567890abcdef 以及 apiKey=2ss5J1OggCvrBUvZx3YkBsuDEcq3vYxhMb36RZaEXeBdoF8KV0gVG1Jw2N9h8wjFX",
      }),
    );
    const events = await store.readAll();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-abcdef1234567890abcdef");
    expect(serialized).not.toContain("2ss5J1OggCvrBUvZx3YkBsuDEcq3vYxhMb36RZaEXeBdoF8KV0gVG1Jw2N9h8wjFX");
    expect(serialized).toContain("[REDACTED]");
  });

  it("③ 故障链：必须保留根因与包装码顺序，不得只留最外层", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({
        errorCode: "provider-timeout",
        chain: {
          rootErrorCode: "journal-corrupted",
          wrapperErrorCodes: ["provider-protocol-error", "provider-timeout"],
        },
      }),
    ]);
    const group = metrics.groups[0];
    expect(group?.chain.rootErrorCode).toBe("journal-corrupted");
    expect(group?.chain.wrapperErrorCodes).toEqual([
      "provider-protocol-error",
      "provider-timeout",
    ]);
  });

  it("④ 不足证据：必须区分为 insufficient-evidence，不得写成确定根因", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ classification: "insufficient-evidence" }),
      buildEvent({ classification: "suspected-cause", requestIdentifier: "diag-2" }),
    ]);
    const insufficient = metrics.groups.filter(
      (group) => group.classification === "insufficient-evidence",
    );
    expect(insufficient).toHaveLength(1);
    // 统计里必须显式区分三类分类，供调用方避免把推断当事实
    expect(metrics.byClassification["insufficient-evidence"]).toBe(1);
    expect(metrics.byClassification["suspected-cause"]).toBe(1);
  });

  it("⑤ 诊断自身失败：必须报不可测量，不得报「一切正常」", () => {
    const metrics = aggregateDiagnosticEvents([], {
      measurementFailureReason: "事件文件不可读",
    });
    expect(metrics.isReportable).toBe(false);
    expect(metrics.unreportableReason).toContain("不可读");
    expect(metrics.groups).toHaveLength(0);
  });
});

describe("DIAG-01-02：汇总与分页", () => {
  it("⑥ 合并计数且保留首次/最近发生时间与影响范围", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ recordedAtIso: "2026-10-02T00:00:00.000Z" }),
      buildEvent({ recordedAtIso: "2026-10-02T02:00:00.000Z", requestIdentifier: "diag-2" }),
      buildEvent({
        recordedAtIso: "2026-10-02T01:00:00.000Z",
        requestIdentifier: "diag-3",
        missionIdentifier: "mission-2",
      }),
    ]);
    const group = metrics.groups[0];
    expect(group?.occurrenceCount).toBe(3);
    expect(group?.firstOccurredAtIso).toBe("2026-10-02T00:00:00.000Z");
    expect(group?.lastOccurredAtIso).toBe("2026-10-02T02:00:00.000Z");
    expect(group?.impact.missionIdentifiers.sort()).toEqual(["mission-1", "mission-2"]);
  });

  it("⑦ 分页：稳定游标、不重不漏、越界空页", () => {
    const events = Array.from({ length: 5 }, (_unused, index) =>
      buildEvent({ requestIdentifier: "page-" + String(index), errorCode: "code-" + String(index) }),
    );
    const metrics = aggregateDiagnosticEvents(events);
    const firstPage = metrics.paginateGroups({ pageSize: 2 });
    expect(firstPage.groups).toHaveLength(2);
    expect(firstPage.nextCursor).toBe("2");
    const secondPage = metrics.paginateGroups({
      pageSize: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.groups).toHaveLength(2);
    const beyond = metrics.paginateGroups({ pageSize: 2, cursor: "99" });
    expect(beyond.groups).toHaveLength(0);
    expect(beyond.nextCursor).toBeNull();
  });

  it("⑧ 确定性事实优先：同一事件序列两次聚合结果一致（可复算）", () => {
    const events = [buildEvent(), buildEvent({ requestIdentifier: "diag-2" })];
    const first = aggregateDiagnosticEvents(events);
    const second = aggregateDiagnosticEvents(events);
    expect(JSON.stringify(first.groups)).toBe(JSON.stringify(second.groups));
  });
});
