/**
 * USAGE-01-02 行为反例（持久化去重 / 乱序终值 / 重启 / 跨模型 / 取消缺 usage / 并发预算）。
 *
 * 契约来源：OBS-01-01 冻结的共享最小事件契约 §4.2（USAGE 事件）。
 * 纪律：
 *  - 同键（requestIdentifier）异参（inputHash）→ **拒绝写入并记冲突**，不得覆盖；
 *  - `isEstimated=true` 的记录**不得**用于账单结论；价格表缺失 → costEstimate=null 并给原因；
 *  - 未拿到 usage（取消/超时）记 null 并注原因，**不得补 0**；
 *  - 子量不得重复计入总量（attribution 显式）。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  UsageLedgerStore,
  aggregateUsageEntries,
  type UsageLedgerEntry,
} from "../../../packages/core/src/orchestration/usage-ledger-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-usage-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function buildEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    requestIdentifier: "request-1",
    requestRevision: 1,
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    sourceAgentInstanceId: "worker:mission-1:T-001:1",
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

describe("USAGE-01-02：六类反例", () => {
  it("① 重复事件：同键同内容幂等，不重复计账", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry());
    await store.append(buildEntry());
    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    const metrics = aggregateUsageEntries(entries);
    expect(metrics.totals.inputTokenCount).toBe(100);
  });

  it("② 同键异参：必须拒绝写入并记冲突，不得覆盖", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ inputHash: "hash-a", inputTokenCount: 100 }));
    const conflict = await store.append(
      buildEntry({ inputHash: "hash-b", inputTokenCount: 999 }),
    );
    expect(conflict.outcome).toBe("conflict-rejected");
    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputTokenCount).toBe(100);
    expect(store.getConflictReport().conflictCount).toBe(1);
  });

  it("③ 乱序终值：低 revision 不得覆盖高 revision（终值口径）", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ requestRevision: 3, inputTokenCount: 300 }));
    const lateArrival = await store.append(
      buildEntry({ requestRevision: 1, inputTokenCount: 10 }),
    );
    expect(lateArrival.outcome).toBe("stale-revision-rejected");
    const entries = await store.readAll();
    expect(entries[0]?.requestRevision).toBe(3);
    expect(entries[0]?.inputTokenCount).toBe(300);
  });

  it("④ 重启：新实例读同一目录必须看到既有账目，不重置、不重复计账", async () => {
    const firstStore = new UsageLedgerStore({ baseDirectory });
    await firstStore.append(buildEntry({ requestIdentifier: "before-restart" }));
    // 模拟进程重启：新实例
    const secondStore = new UsageLedgerStore({ baseDirectory });
    await secondStore.append(buildEntry({ requestIdentifier: "after-restart" }));
    // 重启后重复提交同一请求 → 幂等
    const duplicate = await secondStore.append(buildEntry({ requestIdentifier: "before-restart" }));
    expect(duplicate.outcome).toBe("duplicate-idempotent");

    const entries = await secondStore.readAll();
    expect(entries.map((entry) => entry.requestIdentifier).sort()).toEqual([
      "after-restart",
      "before-restart",
    ]);
    const metrics = aggregateUsageEntries(entries);
    expect(metrics.totals.inputTokenCount).toBe(200);
  });

  it("⑤ 跨模型切换：按模型分组统计，不得合并成单一模型账单", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(buildEntry({ requestIdentifier: "r1", modelIdentifier: "step-3.7-flash" }));
    await store.append(buildEntry({ requestIdentifier: "r2", modelIdentifier: "u2-flash" }));
    const metrics = aggregateUsageEntries(await store.readAll());
    const byModel = new Map(metrics.byModel.map((group) => [group.modelIdentifier, group]));
    expect(byModel.size).toBe(2);
    expect(byModel.get("step-3.7-flash")?.inputTokenCount).toBe(100);
    expect(byModel.get("u2-flash")?.inputTokenCount).toBe(100);
  });

  it("⑥ 取消缺 usage：必须记 null 并注原因，不得补 0", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    await store.append(
      buildEntry({
        requestIdentifier: "cancelled-1",
        inputTokenCount: null,
        outputTokenCount: null,
        missingUsageReason: "provider-cancelled",
      }),
    );
    const entries = await store.readAll();
    expect(entries[0]?.inputTokenCount).toBeNull();
    const metrics = aggregateUsageEntries(entries);
    // 未知不得当 0：总量必须标记为不完整，而不是给出 0
    expect(metrics.totals.inputTokenCount).toBeNull();
    expect(metrics.totals.hasIncompleteUsage).toBe(true);
  });
});

describe("USAGE-01-02：预算、估价与并发", () => {
  it("⑦ 估算记录不得用于账单结论；价格缺失必须给 null 与原因", () => {
    const metrics = aggregateUsageEntries([
      buildEntry({ requestIdentifier: "e1", isEstimated: true, inputTokenCount: 100 }),
    ]);
    expect(metrics.billable.inputTokenCount).toBeNull();
    expect(metrics.billable.excludedEstimatedCount).toBe(1);
    expect(metrics.costEstimate.amountMinorUnits).toBeNull();
    expect(metrics.costEstimate.unavailableReason).toContain("价格");
  });

  it("⑧ 并发预算：超预算必须显式拒绝/降级，且计数不得因并发而漏记", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    const concurrentCount = 50;
    await Promise.all(
      Array.from({ length: concurrentCount }, (_unused, index) =>
        store.append(
          buildEntry({
            requestIdentifier: "concurrent-" + String(index),
            inputTokenCount: 100,
            outputTokenCount: 0,
          }),
        ),
      ),
    );
    const entries = await store.readAll();
    expect(entries).toHaveLength(concurrentCount);

    const metrics = aggregateUsageEntries(entries);
    // 并发下计数不得漏记
    expect(metrics.totals.inputTokenCount).toBe(concurrentCount * 100);
    // 预算判定：超出上限必须显式报告，而不是静默通过
    const budget = metrics.evaluateBudget({ inputTokenBudget: 1_000 });
    expect(budget.isExceeded).toBe(true);
    expect(budget.exceededByTokenCount).toBe(concurrentCount * 100 - 1_000);
  });

  it("⑨ 分页聚合：游标稳定、不重不漏，且聚合口径与全量一致", async () => {
    const store = new UsageLedgerStore({ baseDirectory });
    for (let index = 0; index < 5; index += 1) {
      await store.append(buildEntry({ requestIdentifier: "page-" + String(index) }));
    }
    const entries = await store.readAll();
    const firstPage = store.paginate({ entries, pageSize: 2 });
    expect(firstPage.entries.map((entry) => entry.requestIdentifier)).toEqual(["page-0", "page-1"]);
    const secondPage = store.paginate({
      entries,
      pageSize: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.entries.map((entry) => entry.requestIdentifier)).toEqual(["page-2", "page-3"]);
  });
});
