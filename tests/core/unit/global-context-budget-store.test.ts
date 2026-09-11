/**
 * T09A-R1-02：全局上下文预算策略存储（默认/0/小预算/非法值/CAS/并发）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GLOBAL_CONTEXT_BUDGET_TOKENS,
  GlobalContextBudgetStore,
} from "../../../packages/core/src/orchestration/global-context-budget-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-budget-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-02：预算策略存储", () => {
  it("默认 4096（revision 1），可设为 0 与小预算", async () => {
    const store = new GlobalContextBudgetStore({ baseDirectory: stateDirectory });
    const initial = await store.readPolicy();
    expect(initial.configuredMaximumGlobalContextTokenCount).toBe(
      DEFAULT_GLOBAL_CONTEXT_BUDGET_TOKENS,
    );
    expect(initial.globalContextBudgetPolicyRevision).toBe(1);

    const zero = await store.updatePolicy({
      expectedRevision: 1,
      configuredMaximumGlobalContextTokenCount: 0,
      updatedByUserId: "user-1",
    });
    expect(zero.configuredMaximumGlobalContextTokenCount).toBe(0);
    expect(zero.globalContextBudgetPolicyRevision).toBe(2);

    const small = await store.updatePolicy({
      expectedRevision: 2,
      configuredMaximumGlobalContextTokenCount: 8,
      updatedByUserId: "user-1",
    });
    expect(small.configuredMaximumGlobalContextTokenCount).toBe(8);
    expect(small.globalContextBudgetPolicyRevision).toBe(3);

    const reread = await store.readPolicy();
    expect(reread.configuredMaximumGlobalContextTokenCount).toBe(8);
  });

  it("非法值（负数/小数/NaN）被拒绝且不改变已存策略", async () => {
    const store = new GlobalContextBudgetStore({ baseDirectory: stateDirectory });
    for (const invalid of [-1, 1.5, Number.NaN]) {
      await expect(
        store.updatePolicy({
          expectedRevision: 1,
          configuredMaximumGlobalContextTokenCount: invalid,
          updatedByUserId: "user-1",
        }),
      ).rejects.toThrow();
    }
    expect((await store.readPolicy()).globalContextBudgetPolicyRevision).toBe(1);
  });

  it("expected-revision CAS：陈旧 revision 拒绝；并发同 revision 仅一次成功", async () => {
    const store = new GlobalContextBudgetStore({ baseDirectory: stateDirectory });
    await expect(
      store.updatePolicy({
        expectedRevision: 99,
        configuredMaximumGlobalContextTokenCount: 100,
        updatedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });

    const results = await Promise.allSettled([
      store.updatePolicy({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: 100, updatedByUserId: "u" }),
      store.updatePolicy({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: 200, updatedByUserId: "u" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((await store.readPolicy()).globalContextBudgetPolicyRevision).toBe(2);
  });
});
