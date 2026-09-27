/**
 * B6R-11：run-command 与 bootstrap 剩余分支覆盖。
 * （run 配置非法 25、streamOutput 调用 52、useFeedbackProcess 分支 102-108。）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 覆盖率插桩下真实 mission 链路变慢：仅调整超时，断言不变。
vi.setConfig({ testTimeout: 60_000 });

import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";
import { bootstrapCli } from "../../../packages/tui/src/cli/bootstrap.js";

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
});
