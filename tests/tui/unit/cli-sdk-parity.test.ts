/**
 * T07D-R1-04：消费者与入口一致性（行为反例 → 实现）。
 * 验收：CLI 与 SDK 观察同一 mission 的同一状态；真实文件变化（task-chain.json）而非字符串 accepted。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { executeRunCommand } from "../../../packages/tui/src/cli/run-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d-r1-04-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T07D-R1-04：CLI 与 SDK 入口一致性", () => {
  it("CLI run 与 SDK 查询同一 mission 状态一致，且有真实产物", async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });

    let exitCode: number;
    try {
      exitCode = await executeRunCommand({
        prompt: "T07D-R1-04 parity",
        mode: "assist",
        runtime: "mock",
        isJsonOutput: true,
        stateDirectory,
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(exitCode).toBe(0);
    const cliOutput = JSON.parse(stdoutChunks.join("")) as {
      missionId: string;
      status: string;
    };
    expect(cliOutput.status).toBe("done");

    // 真实产物：任务链已落盘（不是仅字符串 accepted）
    const taskChainRaw = await fs.readFile(
      path.join(stateDirectory, "missions", cliOutput.missionId, "task-chain.json"),
      "utf8",
    );
    expect(taskChainRaw).toContain("T-001");
    expect(taskChainRaw).toContain("done");

    // SDK 通过公开入口查询同一 mission，状态与 CLI 一致
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
    });
    const mission = await application.queryMission(cliOutput.missionId);
    expect(mission.missionIdentifier).toBe(cliOutput.missionId);
    expect(mission.status).toBe(cliOutput.status);
    await application.shutdown();
  });
});
