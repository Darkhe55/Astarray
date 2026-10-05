/**
 * SMART-01-04 入口补做：SDK 公开导出面（消费者不得依赖内部路径）。
 *
 * 卡内验收要求四入口（SDK/CLI/TUI/GUI）可用；本节补齐 **SDK** 入口。
 * 本文件在导出补齐之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CrossProjectAuthorizationStore,
  DiagnosticEventStore,
  InstructionWindowStore,
  MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
  PerfEventStore,
  UsageLedgerStore,
  aggregatePerfSamples,
  buildRedactedDiagnosticBundle,
  classifyModelStop,
  evaluateEffectiveCrossProjectPermission,
  evaluateInstructionDeadline,
  extractClarificationAnswer,
  queryDiagnosticSummary,
  queryPerfOverview,
  queryUsageOverview,
  summarizeCopyReceipts,
} from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sdk-entry-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

describe("SDK 公开入口", () => {
  it("① 四类查询函数均可从公开入口导入并实际可用", async () => {
    const performance = await queryPerfOverview({ store: new PerfEventStore({ baseDirectory }) });
    const usage = await queryUsageOverview({ store: new UsageLedgerStore({ baseDirectory }) });
    const diagnostics = await queryDiagnosticSummary({
      store: new DiagnosticEventStore({ baseDirectory }),
    });
    const copies = await summarizeCopyReceipts({
      store: new CrossProjectAuthorizationStore({ baseDirectory }),
    });

    // 无法测量时如实标注，不报 0
    expect(performance.metrics.isReportable).toBe(false);
    expect(performance.metrics.durationMilliseconds.mean).toBeNull();
    expect(usage.metrics.totals.inputTokenCount).toBe(0);
    expect(diagnostics.isReportable).toBe(false);
    expect(copies.count).toBe(0);
  });

  it("② 指令窗口与停止分类可从公开入口使用", () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    expect(store).toBeInstanceOf(InstructionWindowStore);
    const classification = classifyModelStop({
      stopReason: "stop",
      hasValidClosingReceipt: false,
      hasIndependentAuthoritativeEvidence: false,
      isWaitingForUserDetails: false,
      producedTextDeltaCount: 1,
      isExplicitUserStop: false,
      isResting: false,
    });
    expect(classification.kind).toBe("early-stop");
    const extraction = extractClarificationAnswer({ pendingQuestion: "q", replyText: "答案: a" });
    expect(extraction.isAnswered).toBe(true);
  });

  it("③ 期限常量与跨项目判定可从公开入口使用", () => {
    expect(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS).toBe(180_000);
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-1",
      acceptedAtIso: "2026-10-02T00:00:00.000Z",
      nowIso: "2026-10-02T00:01:00.000Z",
    });
    expect(evaluation.kind).toBe("dispatched-within-deadline");
    const permission = evaluateEffectiveCrossProjectPermission({
      sourceExportScope: { pathPrefixes: ["docs/"] },
      targetReceiveScope: { pathPrefixes: [] },
      receivingAgentPermissionScope: { pathPrefixes: ["docs/"] },
      requestedResourcePath: "docs/a.md",
      mode: "devolve",
    });
    expect(permission.decision).toBe("deny-target-does-not-receive");
  });

  it("④ 脱敏诊断包与聚合函数可从公开入口使用（纯构造，不落盘）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory });
    const filesBefore = (await fs.readdir(baseDirectory, { recursive: true })).length;
    const bundle = await buildRedactedDiagnosticBundle({
      store,
      environment: { platform: "win32", astarrayVersion: "0.1.0" },
    });
    expect(bundle.redactionNotice).toContain("脱敏");
    expect(bundle.containsFullSession).toBe(false);
    const filesAfter = (await fs.readdir(baseDirectory, { recursive: true })).length;
    expect(filesAfter).toBe(filesBefore);
    // 聚合函数同样可用
    expect(aggregatePerfSamples([]).sampleSize).toBe(0);
  });
});
