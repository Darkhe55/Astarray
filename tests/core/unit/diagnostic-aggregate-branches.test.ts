/**
 * 诊断事件纯函数汇总的**边界分支**补测（E2E-01-04 覆盖率冲刺，2026-10-09）。
 *
 * `aggregateDiagnosticEvents` 是导出纯函数，未覆盖分支很具体：
 *  - 事件的 mission/task 标识为 **null** 时，影响范围应为空数组（L236/L237 的真分支）；
 *  - 同指纹事件**乱序到达**时，`firstOccurredAtIso` 必须被更早的时间替换（L248）；
 *  - 同指纹事件带来**新的** mission/task 标识时，必须追加进影响范围且不重复（L260-264）；
 *  - `paginateGroups` 的 **非法游标**（非数字 / 负数）应回退到 0（L288）；
 *  - 还有后续分组时 `nextCursor` 必须是下一页游标，否则为 null（L290/L297）。
 *
 * 断言均为行为断言（断言具体字段值与分页内容），不写"只为凑覆盖"的空断言。
 */
import { describe, expect, it } from "vitest";

import {
  aggregateDiagnosticEvents,
  type DiagnosticEvent,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

function buildEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: "2026-10-09T10:00:00.000Z",
    sourceAgentInstanceId: "worker:mission-test:T-001:1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    requestIdentifier: "request-1",
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: "provider-timeout",
    stage: "provider",
    severity: "error",
    component: "openai-compatible-runtime",
    messageText: "Provider 请求超时",
    recoveryState: "unknown",
    classification: "suspected-cause",
    chain: { rootErrorCode: "provider-timeout", wrapperErrorCodes: [] },
    ...overrides,
  };
}

describe("aggregateDiagnosticEvents：标识为 null 的事件", () => {
  it("mission/task 标识为 null 时影响范围为空数组（不得出现 null 元素）", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ missionIdentifier: null, taskIdentifier: null }),
    ]);
    const group = metrics.groups[0];
    expect(group?.impact.missionIdentifiers).toEqual([]);
    expect(group?.impact.taskIdentifiers).toEqual([]);
  });

  it("标识非 null 时影响范围包含该标识", () => {
    const metrics = aggregateDiagnosticEvents([buildEvent()]);
    const group = metrics.groups[0];
    expect(group?.impact.missionIdentifiers).toEqual(["mission-1"]);
    expect(group?.impact.taskIdentifiers).toEqual(["T-001"]);
  });
});

describe("aggregateDiagnosticEvents：同指纹合并", () => {
  it("乱序到达时 firstOccurredAtIso 取更早者、lastOccurredAtIso 取更晚者", () => {
    const later = buildEvent({ recordedAtIso: "2026-10-09T10:00:00.000Z" });
    const earlier = buildEvent({ recordedAtIso: "2026-10-09T09:00:00.000Z" });
    const metrics = aggregateDiagnosticEvents([later, earlier]);
    const group = metrics.groups[0];
    expect(group?.occurrenceCount).toBe(2);
    expect(group?.firstOccurredAtIso).toBe("2026-10-09T09:00:00.000Z");
    expect(group?.lastOccurredAtIso).toBe("2026-10-09T10:00:00.000Z");
  });

  it("新的 task/mission 标识必须追加进影响范围且不重复", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ taskIdentifier: "T-001", missionIdentifier: "mission-1" }),
      buildEvent({ taskIdentifier: "T-002", missionIdentifier: "mission-1" }),
      buildEvent({ taskIdentifier: "T-002", missionIdentifier: "mission-2" }),
    ]);
    const group = metrics.groups[0];
    expect(group?.occurrenceCount).toBe(3);
    expect(group?.impact.taskIdentifiers).toEqual(["T-001", "T-002"]);
    expect(group?.impact.missionIdentifiers).toEqual(["mission-1", "mission-2"]);
  });

  it("不同指纹（错误码不同）必须分成两组", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ errorCode: "provider-timeout" }),
      buildEvent({ errorCode: "tool-execution-failed" }),
    ]);
    expect(metrics.groups).toHaveLength(2);
    expect(metrics.byClassification["suspected-cause"]).toBe(2);
  });
});

describe("aggregateDiagnosticEvents：分页与可报告性", () => {
  it("非法游标（非数字 / 负数）回退到第一页", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ errorCode: "aaa" }),
      buildEvent({ errorCode: "bbb" }),
    ]);
    const fromNonNumeric = metrics.paginateGroups({ pageSize: 1, cursor: "不是数字" });
    expect(fromNonNumeric.groups).toHaveLength(1);
    expect(fromNonNumeric.groups[0]?.errorCode).toBe("aaa");
    const fromNegative = metrics.paginateGroups({ pageSize: 1, cursor: "-5" });
    expect(fromNegative.groups[0]?.errorCode).toBe("aaa");
  });

  it("还有后续分组时给出下一页游标；到末页时为 null", () => {
    const metrics = aggregateDiagnosticEvents([
      buildEvent({ errorCode: "aaa" }),
      buildEvent({ errorCode: "bbb" }),
    ]);
    const firstPage = metrics.paginateGroups({ pageSize: 1 });
    expect(firstPage.groups).toHaveLength(1);
    expect(firstPage.nextCursor).toBe("1");
    const secondPage = metrics.paginateGroups({ pageSize: 1, cursor: firstPage.nextCursor ?? "" });
    expect(secondPage.groups[0]?.errorCode).toBe("bbb");
    expect(secondPage.nextCursor).toBeNull();
  });

  it("游标超出范围时返回空页且无下一页", () => {
    const metrics = aggregateDiagnosticEvents([buildEvent({ errorCode: "aaa" })]);
    const beyond = metrics.paginateGroups({ pageSize: 10, cursor: "99" });
    expect(beyond.groups).toEqual([]);
    expect(beyond.nextCursor).toBeNull();
  });

  it("给出测量失败原因时判定为不可报告，并带出原因", () => {
    const metrics = aggregateDiagnosticEvents([buildEvent()], {
      measurementFailureReason: "诊断文件不可读",
    });
    expect(metrics.isReportable).toBe(false);
    expect(metrics.unreportableReason).toContain("诊断文件不可读");
  });
});
