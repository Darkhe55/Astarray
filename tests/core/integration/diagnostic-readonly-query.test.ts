/**
 * DIAG-01-03 行为反例（公共只读诊断 + 脱敏证据包）。
 *
 * 卡内要求："公共工具/CLI/SDK 及最小界面、tarball；故障可从任务追溯到真实回执，
 * 无未授权副作用，不把模型推断写成确定根因"。
 * 卡内 §5 边界：默认读取现有状态/脱敏回执；**主动进程执行、联网探测、创建文件或复现步骤
 * 必须分别预览和授权**，不能藏在只读诊断按钮中；诊断包默认只含必要元数据/摘要及证据引用。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 用模块级替身检查"是否执行进程"：ESM 命名导出不可 spy，
 * 故用 vi.mock 把 node:child_process 整体替换为可观测替身。
 */
const childProcessCalls: string[] = [];
vi.mock("node:child_process", () => {
  const record = (name: string) => () => {
    childProcessCalls.push(name);
    throw new Error("只读诊断不得执行进程: " + name);
  };
  return {
    spawn: record("spawn"),
    spawnSync: record("spawnSync"),
    exec: record("exec"),
    execFile: record("execFile"),
    execSync: record("execSync"),
    fork: record("fork"),
  };
});

import {
  DiagnosticEventStore,
  buildRedactedDiagnosticBundle,
  queryDiagnosticSummary,
  type DiagnosticEvent,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-diag03-"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("DIAG-01-03：只读诊断不得产生副作用", () => {
  it("① 错误查询：不得执行进程、不得联网、不得创建文件", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(buildEvent());

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    childProcessCalls.length = 0;
    const filesBefore = (await fs.readdir(baseDirectory, { recursive: true })).length;

    await queryDiagnosticSummary({ store });

    expect(childProcessCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const filesAfter = (await fs.readdir(baseDirectory, { recursive: true })).length;
    expect(filesAfter).toBe(filesBefore);
  });

  it("② 诊断包预览：必须是纯构造（不写盘），且只含元数据/摘要与证据引用", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(
      buildEvent({
        messageText:
          "失败：Authorization: Bearer sk-abcdef1234567890abcdef 与 apiKey=2ss5J1OggCvrBUvZx3YkBsuDEcq3vYxhMb36RZaEXeBdoF8KV0gVG1Jw2N9h8wjFX",
      }),
    );
    const filesBefore = (await fs.readdir(baseDirectory, { recursive: true })).length;
    const bundle = await buildRedactedDiagnosticBundle({
      store,
      environment: { platform: "win32", astarrayVersion: "0.1.0" },
      windowStartIso: "2026-10-01T00:00:00.000Z",
      windowEndIso: "2026-10-03T00:00:00.000Z",
    });
    const filesAfter = (await fs.readdir(baseDirectory, { recursive: true })).length;
    // 纯构造：预览不落盘
    expect(filesAfter).toBe(filesBefore);

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("sk-abcdef1234567890abcdef");
    expect(serialized).not.toContain("2ss5J1OggCvrBUvZx3YkBsuDEcq3vYxhMb36RZaEXeBdoF8KV0gVG1Jw2N9h8wjFX");
    // 附版本/平台/时间窗口与脱敏说明
    expect(bundle.environment.platform).toBe("win32");
    expect(bundle.environment.astarrayVersion).toBe("0.1.0");
    expect(bundle.windowStartIso).toBe("2026-10-01T00:00:00.000Z");
    expect(bundle.windowEndIso).toBe("2026-10-03T00:00:00.000Z");
    expect(bundle.redactionNotice).toContain("脱敏");
    // 默认不含完整会话/源码/日志正文
    expect(bundle.containsFullSession).toBe(false);
    expect(bundle.containsSourceCode).toBe(false);
    expect(bundle.containsRawLogs).toBe(false);
  });
});

describe("DIAG-01-03：可追溯与分类纪律", () => {
  it("③ 故障可追溯到真实回执：每条分组必须给出来源个体与请求标识", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(buildEvent());
    const summary = await queryDiagnosticSummary({ store });
    const group = summary.deterministicFindings[0];
    expect(group?.evidence.sourceAgentInstanceIds).toContain("worker:mission-1:T-001:1");
    expect(group?.evidence.requestIdentifiers).toContain("diag-1");
    expect(group?.evidence.missionIdentifiers).toContain("mission-1");
  });

  it("④ 不把推断写成确定根因：推断只出现在 suspected 字段，deterministic 字段只放事实", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(buildEvent({ classification: "deterministic-fact" }));
    await store.append(
      buildEvent({
        requestIdentifier: "diag-2",
        classification: "suspected-cause",
        component: "provider-registry",
        errorCode: "provider-timeout",
      }),
    );
    const summary = await queryDiagnosticSummary({ store });

    expect(summary.deterministicFindings).toHaveLength(1);
    expect(summary.deterministicFindings[0]?.errorCode).toBe("tool-execution-failed");
    // 推断必须单列，且明确标注为推测
    expect(summary.suspectedFindings).toHaveLength(1);
    expect(summary.suspectedFindings[0]?.errorCode).toBe("provider-timeout");
    expect(summary.suspectedFindings[0]?.isInference).toBe(true);
    // 确定事实不得被标成推断
    expect(summary.deterministicFindings[0]?.isInference).toBe(false);
  });

  it("⑤ 可见范围：按 agentInstanceId 过滤后不得出现他人记录", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(buildEvent({ sourceAgentInstanceId: "worker:a:1" }));
    await store.append(
      buildEvent({ requestIdentifier: "diag-2", sourceAgentInstanceId: "worker:b:9" }),
    );
    const summary = await queryDiagnosticSummary({
      store,
      query: { sourceAgentInstanceId: "worker:a:1" },
    });
    expect(summary.coverage.matchedEventCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("worker:b:9");
  });

  it("⑥ 时间窗口与分页：窗口真实生效，分页不重不漏", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    await store.append(buildEvent({ recordedAtIso: "2026-10-02T00:00:00.000Z" }));
    await store.append(
      buildEvent({
        requestIdentifier: "diag-2",
        recordedAtIso: "2026-10-02T05:00:00.000Z",
        errorCode: "other-code",
      }),
    );
    const windowed = await queryDiagnosticSummary({
      store,
      query: { windowStartIso: "2026-10-02T04:00:00.000Z" },
    });
    expect(windowed.coverage.matchedEventCount).toBe(1);

    const all = await queryDiagnosticSummary({ store, query: { pageSize: 1 } });
    expect(all.page?.groups).toHaveLength(1);
    expect(all.page?.nextCursor).toBe("1");
    const secondPage = await queryDiagnosticSummary({
      store,
      query: { pageSize: 1, cursor: "1" },
    });
    expect(secondPage.page?.groups).toHaveLength(1);
    expect(secondPage.page?.nextCursor).toBeNull();
  });

  it("⑦ 诊断自身失败：必须报不可测量，不得报一切正常", async () => {
    // 指向不可读路径（用一个文件充当目录）以制造读取失败
    const blockedPath = path.join(baseDirectory, "blocked");
    await fs.writeFile(blockedPath, "not-a-directory", "utf8");
    const store = new DiagnosticEventStore({ baseDirectory: blockedPath });
    const summary = await queryDiagnosticSummary({ store });
    // 无事件 ≠ 一切正常：必须显式说明样本缺失/不可报告
    expect(summary.isReportable).toBe(false);
    expect(summary.unreportableReason).toContain("样本");
  });
});
