/**
 * T07D-R2-03：CLI 等待策略（不再用固定一分钟误收口长任务）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { waitForTaskTerminal } from "../../../packages/tui/src/cli/run-command.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeApplication(statusSequence: string[]) {
  let callIndex = 0;
  return {
    queryTask: vi.fn(async () => {
      const status = statusSequence[Math.min(callIndex, statusSequence.length - 1)]!;
      callIndex += 1;
      return { taskIdentifier: "task-1", status, missionIdentifier: "mission-1", summaryPreview: null };
    }),
  } as unknown as AstarrayApplicationFacade;
}

describe("T07D-R2-03：CLI 任务等待策略", () => {
  it("超过旧固定一分钟上限仍未终态时继续等待，直到任务完成", async () => {
    vi.useFakeTimers();
    // 7000 次 running × 10ms = 70s 虚拟时间（超过旧的 60s 固定上限）
    const application = makeApplication([
      ...Array.from({ length: 7_000 }, () => "running"),
      "done",
    ]);
    const pending = waitForTaskTerminal(application, "session-1", "task-1", {
      pollIntervalMilliseconds: 10,
    });
    await vi.advanceTimersByTimeAsync(7_000 * 10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBe("done");
  });

  it("显式给出等待上限时，超时返回 running（不误报成功）", async () => {
    vi.useFakeTimers();
    const application = makeApplication(["running"]);
    const pending = waitForTaskTerminal(application, "session-1", "task-1", {
      pollIntervalMilliseconds: 10,
      timeoutMilliseconds: 500,
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe("running");
  });

  it("blocked/failed 立即收敛为 blocked，不空等", async () => {
    const application = makeApplication(["running", "failed"]);
    const status = await waitForTaskTerminal(application, "session-1", "task-1", {
      pollIntervalMilliseconds: 1,
    });
    expect(status).toBe("blocked");
  });
});
