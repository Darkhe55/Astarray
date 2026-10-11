/**
 * B6R-10 覆盖率（2026-10-10）：`waitForTaskTerminal` 的**分支行为**契约。
 *
 * 背景：`cli/run-command.ts` 实测分支仅 **59%（23/39，缺 16）**，是全局分支门槛
 * （`branches ≥85%`，实测 83.89%）的最大可测缺口之一。
 *
 * 本片不是"为覆盖率而覆盖率"，而是钉住该函数**真实的产品契约**（卡内 T07D-R2-03）：
 *  - **不再使用固定一分钟上限误收口长任务**：未给上限 ⇒ 一直等到终态；
 *  - 给了上限且耗尽而任务仍在跑 ⇒ 返回 `running`（**如实报未完成**，不假装 done）；
 *  - `done` / `cancelled` 原样返回；`blocked` / `failed` 归为 `blocked`；
 *  - **存在待裁决权限询问**时立即返回 `blocked`（进入等待前、等待中两个时机）；
 *    —— 否则任务被判 failed 时 `queryTask` 仍返回 blocked，CLI 会**无谓挂起**。
 *
 * 只跑纯函数与假端口；不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import { waitForTaskTerminal } from "../../../packages/tui/src/cli/run-command.js";

/** 极小的假应用端口：只实现本函数用到的 queryTask。 */
function buildFakeApplication(statusSequence: string[]) {
  let callIndex = 0;
  const queryTask = async () => {
    const status = statusSequence[Math.min(callIndex, statusSequence.length - 1)];
    callIndex += 1;
    return { status: status ?? "running" };
  };
  return {
    application: { queryTask } as unknown as Parameters<typeof waitForTaskTerminal>[0],
    getQueryCount: () => callIndex,
  };
}

describe("B6R-10：waitForTaskTerminal 的等待契约", () => {
  it("① done ⇒ 原样返回 done 并停止轮询", async () => {
    const fake = buildFakeApplication(["done"]);
    const status = await waitForTaskTerminal(fake.application, "s", "t", {
      pollIntervalMilliseconds: 1,
    });
    expect(status).toBe("done");
    expect(fake.getQueryCount()).toBe(1);
  });

  it("② cancelled ⇒ 原样返回 cancelled", async () => {
    const fake = buildFakeApplication(["cancelled"]);
    expect(
      await waitForTaskTerminal(fake.application, "s", "t", { pollIntervalMilliseconds: 1 }),
    ).toBe("cancelled");
  });

  it("③ blocked ⇒ 归为 blocked", async () => {
    const fake = buildFakeApplication(["blocked"]);
    expect(
      await waitForTaskTerminal(fake.application, "s", "t", { pollIntervalMilliseconds: 1 }),
    ).toBe("blocked");
  });

  it("④ failed ⇒ 也必须归为 blocked（不得当作已终态成功）", async () => {
    const fake = buildFakeApplication(["failed"]);
    expect(
      await waitForTaskTerminal(fake.application, "s", "t", { pollIntervalMilliseconds: 1 }),
    ).toBe("blocked");
  });

  it("⑤ 给了上限且耗尽仍在跑 ⇒ 返回 running（如实报未完成，不假装 done）", async () => {
    const fake = buildFakeApplication(["running"]);
    const status = await waitForTaskTerminal(fake.application, "s", "t", {
      timeoutMilliseconds: 20,
      pollIntervalMilliseconds: 2,
    });
    expect(status).toBe("running");
    expect(fake.getQueryCount()).toBeGreaterThan(1);
  });

  it("⑥ timeoutMilliseconds 显式 null ⇒ 不设上限（等到终态）", async () => {
    const fake = buildFakeApplication(["running", "running", "done"]);
    const status = await waitForTaskTerminal(fake.application, "s", "t", {
      timeoutMilliseconds: null,
      pollIntervalMilliseconds: 1,
    });
    expect(status).toBe("done");
  });

  it("⑦ **进入等待前**已有待裁决询问 ⇒ 立即 blocked（不发查询）", async () => {
    const fake = buildFakeApplication(["running"]);
    const status = await waitForTaskTerminal(fake.application, "s", "t", {
      pollIntervalMilliseconds: 1,
      hasPendingPermissionAsk: () => true,
    });
    expect(status).toBe("blocked");
    expect(fake.getQueryCount()).toBe(0);
  });

  it("⑧ **等待中**出现待裁决询问 ⇒ 立即 blocked（不必等任务变 blocked）", async () => {
    let askCount = 0;
    const fake = buildFakeApplication(["running", "running"]);
    const status = await waitForTaskTerminal(fake.application, "s", "t", {
      pollIntervalMilliseconds: 1,
      // 第一次（进入前）为 false，之后为 true ⇒ 覆盖"等待中"分支
      hasPendingPermissionAsk: () => {
        askCount += 1;
        return askCount > 1;
      },
    });
    expect(status).toBe("blocked");
  });

  it("⑨ 未提供 hasPendingPermissionAsk ⇒ 不得因此报错（可选能力）", async () => {
    const fake = buildFakeApplication(["done"]);
    expect(
      await waitForTaskTerminal(fake.application, "s", "t", { pollIntervalMilliseconds: 1 }),
    ).toBe("done");
  });

  it("⑩ 默认轮询间隔可省略（options 全缺省也要能工作）", async () => {
    const fake = buildFakeApplication(["done"]);
    expect(await waitForTaskTerminal(fake.application, "s", "t")).toBe("done");
  });
});
