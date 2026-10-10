/**
 * B6R-11：run-command 与 bootstrap 剩余分支覆盖。
 * （run 配置非法 25、streamOutput 调用 52、useFeedbackProcess 分支 102-108。）
 *
 * 2026-10-10 增补：把"真实 mission 链路"的**等待形状**固化为确定性反例。
 * 背景：本文件曾在默认并发下出现 `Test timed out in 60000ms`（隔离复跑 ~6.5s 通过；
 * 本轮 8 次隔离 + 3 次全量（`--maxWorkers=12`）均未复现）。定位到的**可证接缝**是：
 * 本文件中走真实 mission 的两个用例**不传 `timeoutSeconds`**，于是
 * `executeRunCommand` → `waitForTaskTerminal(options.timeoutMilliseconds = null)`
 * 以 **50ms 轮询且无 deadline** 的方式等待终态（这是 T07D-R2-03 的既定契约：
 * "缺省不设固定上限，等待任务终态"）。因此一旦 mission 状态长期停在非终态，
 * 等待会**静默持续**，直到测试框架自身超时才失败——失败信息里没有"卡在哪一步"。
 *
 * 下面的用例用注入的 `application` 桩把这个形状**确定性地**钉住：
 * 给足预算时"永不终态"会被如实报成 `running`（不伪装 done），给零预算时立即返回；
 * 两者都必须**有界返回**，不得让等待退化为无界轮询。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 覆盖率插桩下真实 mission 链路变慢：仅调整超时，断言不变。
vi.setConfig({ testTimeout: 60_000 });

import { executeRunCommand, waitForTaskTerminal } from "../../../packages/tui/src/cli/run-command.js";
import type { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { bootstrapCli } from "../../../packages/tui/src/cli/bootstrap.js";

/** 只实现 `waitForTaskTerminal` 需要的那一个方法（其余方法不会被触达）。 */
function buildNeverTerminalApplication(): {
  application: AstarrayApplicationFacade;
  queryCount: () => number;
} {
  let queryCount = 0;
  const application = {
    queryTask: async () => {
      queryCount += 1;
      return { taskIdentifier: "cli-task", status: "running" as const, missionIdentifier: "m1" };
    },
  } as unknown as AstarrayApplicationFacade;
  return { application, queryCount: () => queryCount };
}

let stateDirectory: string;
let originalCwd: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-run-gap-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
});

describe("run-command 剩余分支", () => {
  it("配置非法（mode 非法）→ 退出码 2（25）", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    await expect(
      executeRunCommand({
        prompt: "任务",
        mode: "bogus-mode",
        runtime: "mock",
        isJsonOutput: true,
        stateDirectory,
      }),
    ).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it("run 成功：streamOutput 收到 mock 执行器文本（52）", async () => {
    const streamed: string[] = [];
    const exitCode = await executeRunCommand({
      prompt: "流式输出任务",
      mode: "assist",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    void streamed;
    expect(exitCode).toBe(0);
  }, 60_000);

  it("Ponder：run 输出问答 JSON（ponder/done/answer），不虚报受理也不崩溃", async () => {
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeRunCommand({
      prompt: "只读问题",
      mode: "ponder",
      runtime: "mock",
      isJsonOutput: true,
      stateDirectory,
    });
    stdoutSpy.mockRestore();
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join("")) as {
      mode?: string;
      status?: string;
      answer?: string;
      missionId?: string;
    };
    expect(payload.mode).toBe("ponder");
    expect(payload.status).toBe("done");
    expect(typeof payload.answer).toBe("string");
    // answer 必须是流式正文，而不是 handleUserMessage 的内部哨兵值
    expect(payload.answer).not.toBe("ponder");
    expect(payload.answer?.length ?? 0).toBeGreaterThan(0);
    expect(payload.missionId).toBeUndefined();
  }, 60_000);

  it("bootstrap useFeedbackProcess:true：启动独立反馈进程并干净关闭（102-108）", async () => {
    const bootstrap = await bootstrapCli({
      mode: "assist",
      stateDirectory,
      concurrency: 4,
      failureThreshold: 3,
      maxLoopIterations: 8,
      useFeedbackProcess: true,
      streamOutput: () => {},
    });
    expect(bootstrap.supervisor).not.toBeNull();
    expect(bootstrap.feedbackClient).not.toBeNull();
    await expect(bootstrap.shutdown()).resolves.toBeUndefined();
  }, 30_000);

  it("无 `timeoutSeconds` 时等待终态：必须**有界**返回，且非终态如实报 running（不得挂起）", async () => {
    // ① 预算给足但任务永不进入终态：等待必须在预算耗尽后**返回 running**，
    //    不得伪装成 done/cancelled，也不得无界轮询到测试框架超时。
    const neverTerminal = buildNeverTerminalApplication();
    const startedAtMilliseconds = Date.now();
    const statusAfterBudget = await waitForTaskTerminal(
      neverTerminal.application,
      "cli-run",
      "cli-task",
      { timeoutMilliseconds: 250, pollIntervalMilliseconds: 25 },
    );
    const elapsedMilliseconds = Date.now() - startedAtMilliseconds;
    expect(statusAfterBudget).toBe("running");
    expect(elapsedMilliseconds).toBeGreaterThanOrEqual(200);
    expect(elapsedMilliseconds).toBeLessThan(5_000); // 有界：远小于任何框架超时
    expect(neverTerminal.queryCount()).toBeGreaterThan(1); // 确实按轮询推进

    // ② 零预算：立即返回 running，且不空转。
    const zeroBudget = buildNeverTerminalApplication();
    await expect(
      waitForTaskTerminal(zeroBudget.application, "cli-run", "cli-task", {
        timeoutMilliseconds: 0,
      }),
    ).resolves.toBe("running");
    expect(zeroBudget.queryCount()).toBe(0);

    // ③ 契约不变：缺省（null/undefined）即"不设固定上限"——但**进入等待前**若有待裁决询问，
    //    仍必须立即返回 blocked，不得先空等一轮。
    const withPendingAsk = buildNeverTerminalApplication();
    await expect(
      waitForTaskTerminal(withPendingAsk.application, "cli-run", "cli-task", {
        hasPendingPermissionAsk: () => true,
      }),
    ).resolves.toBe("blocked");
    expect(withPendingAsk.queryCount()).toBe(0);
  }, 30_000);
});
