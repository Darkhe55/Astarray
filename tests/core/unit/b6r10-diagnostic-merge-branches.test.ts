/**
 * B6R-10 / DIAG-01 覆盖率（2026-10-10）：**诊断汇总的同指纹归并契约**。
 *
 * 背景：`orchestration/diagnostic-event-store.ts` 实测分支缺 **8**（88.2%），
 * 全部集中在 `queryDiagnosticSummary()` 里"**同一指纹再次出现**"的归并分支
 * （既有用例只覆盖了"首次出现"的建条目分支）。
 *
 * 本片钉住**真实产品语义**（DIAG-01-02"指纹合并计数（文本不进指纹）"）：
 *  - 同指纹多次发生 ⇒ **一条** finding 且 `occurrenceCount` 累计；
 *  - `first/lastOccurredAtIso` 取**真实最小/最大值**（乱序输入也要正确）；
 *  - 证据引用（agent / request / mission / task）必须**去重累积**；
 *  - mission/task 为 `null` 时**不得**写入空串或 undefined。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DiagnosticEventStore,
  computeDiagnosticFingerprint,
  queryDiagnosticSummary,
  type DiagnosticEvent,
  type DiagnosticSummary,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let temporaryDirectory: string;
let store: DiagnosticEventStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r10-diag-"));
  store = new DiagnosticEventStore({ baseDirectory: temporaryDirectory });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: "2026-10-10T00:00:00.000Z",
    sourceAgentInstanceId: "agent-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    requestIdentifier: "request-1",
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: "provider-request-failed",
    stage: "provider",
    severity: "error",
    component: "provider-runtime",
    messageText: "上游返回 500",
    recoveryState: "unknown",
    classification: "suspected-cause",
    chain: { rootErrorCode: "provider-request-failed", wrapperErrorCodes: [] },
    ...overrides,
  };
}

/** 取汇总中第一组 suspected-cause finding（本片用例只构造一个指纹）。 */
function firstFinding(summary: DiagnosticSummary) {
  const finding = summary.suspectedFindings[0];
  if (finding === undefined) {
    throw new Error("期望至少一条 suspected finding");
  }
  return finding;
}

async function summarize(events: DiagnosticEvent[]): Promise<DiagnosticSummary> {
  for (const event of events) {
    await store.append(event);
  }
  return await queryDiagnosticSummary({ store });
}

describe("DIAG-01：同指纹归并（queryDiagnosticSummary）", () => {
  it("① 同指纹两次发生 ⇒ 一条 finding 且 occurrenceCount = 2", async () => {
    const first = buildEvent();
    const second = buildEvent();
    expect(computeDiagnosticFingerprint(first)).toBe(computeDiagnosticFingerprint(second));
    const finding = firstFinding(await summarize([first, second]));
    expect(finding.occurrenceCount).toBe(2);
  });

  it("② 乱序时间 ⇒ first/last 取真实最小/最大值", async () => {
    const finding = firstFinding(
      await summarize([
        buildEvent({ recordedAtIso: "2026-10-10T03:00:00.000Z" }),
        buildEvent({ recordedAtIso: "2026-10-10T01:00:00.000Z" }),
        buildEvent({ recordedAtIso: "2026-10-10T02:00:00.000Z" }),
      ]),
    );
    expect(finding.occurrenceCount).toBe(3);
    expect(finding.firstOccurredAtIso).toBe("2026-10-10T01:00:00.000Z");
    expect(finding.lastOccurredAtIso).toBe("2026-10-10T03:00:00.000Z");
  });

  it("③ 不同 agent / request ⇒ 证据引用去重累积", async () => {
    const finding = firstFinding(
      await summarize([
        buildEvent({ sourceAgentInstanceId: "agent-1", requestIdentifier: "request-1" }),
        buildEvent({ sourceAgentInstanceId: "agent-2", requestIdentifier: "request-1" }),
        buildEvent({ sourceAgentInstanceId: "agent-2", requestIdentifier: "request-2" }),
      ]),
    );
    expect([...finding.evidence.sourceAgentInstanceIds].sort()).toEqual(["agent-1", "agent-2"]);
    expect([...finding.evidence.requestIdentifiers].sort()).toEqual(["request-1", "request-2"]);
  });

  it("④ 不同 mission / task ⇒ 影响面去重累积", async () => {
    const finding = firstFinding(
      await summarize([
        buildEvent({ missionIdentifier: "mission-1", taskIdentifier: "task-1" }),
        buildEvent({ missionIdentifier: "mission-2", taskIdentifier: "task-1" }),
        buildEvent({ missionIdentifier: "mission-2", taskIdentifier: "task-2" }),
      ]),
    );
    expect([...finding.evidence.missionIdentifiers].sort()).toEqual(["mission-1", "mission-2"]);
    expect([...finding.evidence.taskIdentifiers].sort()).toEqual(["task-1", "task-2"]);
  });

  it("⑤ 首次为 null、后续非 null ⇒ 追加且不留空串", async () => {
    const finding = firstFinding(
      await summarize([
        buildEvent({ missionIdentifier: null, taskIdentifier: null }),
        buildEvent({ missionIdentifier: "mission-9", taskIdentifier: "task-9" }),
      ]),
    );
    expect(finding.evidence.missionIdentifiers).toEqual(["mission-9"]);
    expect(finding.evidence.taskIdentifiers).toEqual(["task-9"]);
    expect(finding.evidence.missionIdentifiers).not.toContain("");
  });

  it("⑥ 全程 null ⇒ 保持空数组（不得塞入 null/undefined）", async () => {
    const finding = firstFinding(
      await summarize([
        buildEvent({ missionIdentifier: null, taskIdentifier: null }),
        buildEvent({ missionIdentifier: null, taskIdentifier: null }),
      ]),
    );
    expect(finding.evidence.missionIdentifiers).toEqual([]);
    expect(finding.evidence.taskIdentifiers).toEqual([]);
  });

  it("⑦ 文本不同但其余相同 ⇒ 指纹相同（卡内「文本不进指纹」）", async () => {
    const first = buildEvent({ messageText: "上游返回 500" });
    const second = buildEvent({ messageText: "另一段完全不同的文本" });
    expect(computeDiagnosticFingerprint(first)).toBe(computeDiagnosticFingerprint(second));
    expect(firstFinding(await summarize([first, second])).occurrenceCount).toBe(2);
  });
});
