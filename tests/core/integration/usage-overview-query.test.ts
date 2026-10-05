/**
 * USAGE-01-03 行为反例（公开查询/导出边界）。
 *
 * 卡内要求："公开查询/界面/导出和包验证；账目可复算，不虚报余额，价格缺失和估算来源清楚，
 * 不泄漏其他个体明细"。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UsageLedgerStore,
  queryUsageOverview,
  type UsageLedgerEntry,
} from "../../../packages/core/src/orchestration/usage-ledger-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-usage-overview-"));
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
function buildEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  sequence += 1;
  return {
    requestIdentifier: "overview-" + String(sequence),
    requestRevision: 1,
    missionIdentifier: "mission-a",
    taskIdentifier: "T-001",
    sourceAgentInstanceId: "worker:mission-a:T-001:1",
    providerProfileId: "live-provider-1",
    modelIdentifier: "step-3.7-flash",
    recordedAtIso: "2026-10-02T00:00:00.000Z",
    inputTokenCount: 100,
    outputTokenCount: 50,
    cachedTokenCount: null,
    isEstimated: false,
    inputHash: "hash-a",
    attribution: { kind: "total", parentRequestIdentifier: null },
    ...overrides,
  };
}

describe("USAGE-01-03：公开查询边界", () => {
  it("① 账目可复算：同一账目两次查询得到一致总量（纯函数口径）", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ inputTokenCount: 10 }));
    await store.append(buildEntry({ inputTokenCount: 20 }));

    const first = await queryUsageOverview({ store });
    const second = await queryUsageOverview({ store });
    expect(first.metrics.totals.inputTokenCount).toBe(30);
    expect(second.metrics.totals.inputTokenCount).toBe(30);
    // 可复算口径：**数据字段**逐字一致（evaluateBudget 是便捷函数，不参与数据比较）。
    // 显式剔除便捷函数字段（不参与数据口径）
    const firstData = { ...first.metrics, evaluateBudget: undefined };
    const secondData = { ...second.metrics, evaluateBudget: undefined };
    expect(firstData).toEqual(secondData);
    expect(JSON.stringify(firstData)).toBe(JSON.stringify(secondData));
  });

  it("② 不虚报余额：不得给出剩余额度/官方余额字段，且价格缺失必须给原因", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry());
    const overview = await queryUsageOverview({ store });

    // 只报告"本地账目估算"，且明确不含官方余额
    expect(overview.costEstimate.amountMinorUnits).toBeNull();
    expect(overview.costEstimate.unavailableReason).toContain("价格");
    expect(overview.costEstimate.disclaimer).toContain("官方");
    // 不得出现任何"剩余额度"式字段（防止把本地估算当官方余额）
    expect(Object.keys(overview.costEstimate)).not.toContain("remainingQuota");
    expect(Object.keys(overview)).not.toContain("officialBalance");
  });

  it("③ 估算来源清楚：按来源区分实测与估算条目数", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ isEstimated: false, inputTokenCount: 100 }));
    await store.append(buildEntry({ isEstimated: true, inputTokenCount: 200 }));
    const overview = await queryUsageOverview({ store });
    expect(overview.usageSource.measuredEntryCount).toBe(1);
    expect(overview.usageSource.estimatedEntryCount).toBe(1);
    expect(overview.usageSource.hasMissingUsage).toBe(false);
  });

  it("④ 不泄漏其他个体明细：按 agent 过滤后摘要不得含他人来源标识", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(
      buildEntry({ sourceAgentInstanceId: "worker:mission-a:T-001:1" }),
    );
    await store.append(
      buildEntry({ sourceAgentInstanceId: "worker:mission-a:T-002:9" }),
    );

    const overview = await queryUsageOverview({
      store,
      query: { sourceAgentInstanceId: "worker:mission-a:T-001:1" },
    });
    // 摘要只应含自己的来源标识
    expect(overview.coverage.matchedEntryCount).toBe(1);
    expect(overview.coverage.sourceAgentInstanceId).toBe("worker:mission-a:T-001:1");
    // 明细页（若请求）也不得含他人标识
    const detail = await queryUsageOverview({
      store,
      query: {
        sourceAgentInstanceId: "worker:mission-a:T-001:1",
        detailLevel: "detail",
        pageSize: 10,
      },
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("worker:mission-a:T-002:9");
  });

  it("⑤ 分页与覆盖范围：命中/总数必须回显，越界为空页", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    for (let index = 0; index < 4; index += 1) {
      await store.append(buildEntry({ missionIdentifier: "mission-a" }));
    }
    await store.append(buildEntry({ missionIdentifier: "mission-b" }));

    const overview = await queryUsageOverview({
      store,
      query: { missionIdentifier: "mission-a", detailLevel: "detail", pageSize: 2 },
    });
    expect(overview.coverage.totalEntryCount).toBe(5);
    expect(overview.coverage.matchedEntryCount).toBe(4);
    expect(overview.page?.entries).toHaveLength(2);
    expect(overview.page?.nextCursor).toBe("2");

    const beyond = await queryUsageOverview({
      store,
      query: { missionIdentifier: "mission-a", detailLevel: "detail", pageSize: 2, cursor: "99" },
    });
    expect(beyond.page?.entries).toHaveLength(0);
  });

  it("⑥ 预算判定：给出预算时超限显式上报；用量未知时不得宣称未超预算", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ inputTokenCount: 5_000 }));
    const overBudget = await queryUsageOverview({
      store,
      query: { inputTokenBudget: 1_000 },
    });
    expect(overBudget.budget?.isExceeded).toBe(true);
    expect(overBudget.budget?.exceededByTokenCount).toBe(4_000);

    const unknownStore = new UsageLedgerStore({ baseDirectory: path.join(baseDirectory, "unknown") });
    await unknownStore.append(
      buildEntry({ inputTokenCount: null, outputTokenCount: null, missingUsageReason: "cancelled" }),
    );
    const unknownOverview = await queryUsageOverview({
      store: unknownStore,
      query: { inputTokenBudget: 1_000 },
    });
    expect(unknownOverview.budget?.consumedTokenCount).toBeNull();
    expect(unknownOverview.budget?.isExceeded).toBe(false);
    expect(unknownOverview.metrics.totals.hasIncompleteUsage).toBe(true);
  });

  it("⑦ CLI 命令：JSON 输出含覆盖范围/来源/预算与免责说明，且零网络请求", async () => {
    const { executeUsageOverviewCommand } = await import(
      "../../../packages/tui/src/cli/commands.js"
    );
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ inputTokenCount: 100 }));

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const printedLines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        printedLines.push(String(chunk));
        return true;
      });
    try {
      const exitCode = await executeUsageOverviewCommand({
        stateDirectory: baseDirectory,
        isJsonOutput: true,
        inputTokenBudget: "1000",
      });
      expect(exitCode).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }

    const parsed = JSON.parse(printedLines.join("")) as {
      coverage: { totalEntryCount: number };
      costEstimate: { disclaimer: string };
      budget: { isExceeded: boolean } | null;
      usageSource: { measuredEntryCount: number };
    };
    expect(parsed.coverage.totalEntryCount).toBe(1);
    expect(parsed.usageSource.measuredEntryCount).toBe(1);
    expect(parsed.costEstimate.disclaimer).toContain("官方");
    expect(parsed.budget?.isExceeded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("⑧ CLI 命令：非法预算/明细参数必须用法错误", async () => {
    const { executeUsageOverviewCommand } = await import(
      "../../../packages/tui/src/cli/commands.js"
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(
        await executeUsageOverviewCommand({
          stateDirectory: baseDirectory,
          isJsonOutput: true,
          inputTokenBudget: "不是数字",
        }),
      ).toBe(2);
      expect(
        await executeUsageOverviewCommand({
          stateDirectory: baseDirectory,
          isJsonOutput: true,
          detailLevel: "verbose",
        }),
      ).toBe(2);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
