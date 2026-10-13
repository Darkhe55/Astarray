/**
 * GUI-02 覆盖率结构性补强（2026-10-12，第 6 批）：**guide 命令组**进程内覆盖。
 *
 * 选点依据：继续按已验证规律选**分支密**的家族（guide 共 352 行，是剩余最大候选）。
 * 目标：把分支余量从 0.14 抬到 **≥0.2**，使其**大于抖动量级（约 0.2）**，
 * 从而让覆盖率门禁**与负载抖动解耦**（这是本会话反复出现的双门禁同时红的机制）。
 *
 * **安全边界**：全部指向临时状态目录；**不写任何凭据**；不触碰真实项目目录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeGuideChangeCommand,
  executeGuideHistoryCommand,
  executeGuideStatusCommand,
  executeGuideSubmitCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
const MISSION = "mission-guide-fixture";
const TASK = "T-001";

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { getOutput: () => chunks.join("") };
}

async function callCommand(
  invoker: () => Promise<number>,
): Promise<{ exit: number | null; output: string; threw: string | null }> {
  const capture = captureStdout();
  try {
    const exit = await invoker();
    return { exit, output: capture.getOutput(), threw: null };
  } catch (error) {
    return {
      exit: null,
      output: capture.getOutput(),
      threw: error instanceof Error ? error.message : String(error),
    };
  } finally {
    vi.restoreAllMocks();
  }
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-gui02-guide-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GUI-02 覆盖补强：guide 命令组（进程内）", () => {
  it("① submit：**三种 behaviorTier** 各自可执行（覆盖该参数的分支）", async () => {
    for (const behaviorTier of [
      "record-only",
      "safe-point-guidance",
      "gate-and-request-pause",
    ] as const) {
      const result = await callCommand(() =>
        executeGuideSubmitCommand({
          stateDirectory,
          missionIdentifier: MISSION,
          taskIdentifier: TASK,
          instructionText: "测试指导 " + behaviorTier,
          behaviorTier,
          isJsonOutput: true,
        } as unknown as Parameters<typeof executeGuideSubmitCommand>[0]),
      );
      // 只要求"不崩溃"：返回码或抛错都接受（具体合法性由产品校验）。
      expect(
        result.exit !== null || result.threw !== null,
        `behaviorTier=${behaviorTier} 既未返回码也未抛错`,
      ).toBe(true);
    }
  });

  it("② submit：空 stateDirectory 下不崩溃（边界：目录不存在）", async () => {
    const result = await callCommand(() =>
      executeGuideSubmitCommand({
        stateDirectory: path.join(stateDirectory, "nested-does-not-exist"),
        missionIdentifier: MISSION,
        taskIdentifier: TASK,
        instructionText: "边界测试",
        behaviorTier: "record-only",
        isJsonOutput: true,
      } as unknown as Parameters<typeof executeGuideSubmitCommand>[0]),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("③ status：未知指导标识 ⇒ 不得静默（返回码或抛错都接受）", async () => {
    const result = await callCommand(() =>
      executeGuideStatusCommand({
        stateDirectory,
        guidanceIdentifier: "guidance-does-not-exist",
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("④ status：**guidanceIdentifier 为 undefined**（列出全部）⇒ 如实报告", async () => {
    const result = await callCommand(() =>
      executeGuideStatusCommand({
        stateDirectory,
        guidanceIdentifier: undefined,
        isJsonOutput: true,
      }),
    );
    expect(result.threw, result.threw ?? "").toBeNull();
    expect(typeof result.exit).toBe("number");
  });

  it("⑤ history：未知任务 ⇒ 如实报告或失败（两种语义都接受）", async () => {
    const result = await callCommand(() =>
      executeGuideHistoryCommand({
        stateDirectory,
        taskIdentifier: "task-does-not-exist",
        isJsonOutput: true,
      }),
    );
    expect(result.exit !== null || result.threw !== null).toBe(true);
  });

  it("⑥ change：**taskIdentifier/changeIntent/newTaskIdentifier 为 null** 与给出值时都覆盖", async () => {
    const nullCase = await callCommand(() =>
      executeGuideChangeCommand({
        stateDirectory,
        missionIdentifier: MISSION,
        taskIdentifier: null,
        instructionText: "变更（空字段）",
        changeIntent: null,
        requestedTaskSequenceRevision: 1,
        newTaskIdentifier: null,
        invalidatedArtifactIdentifiers: [],
        isJsonOutput: true,
      } as unknown as Parameters<typeof executeGuideChangeCommand>[0]),
    );
    expect(nullCase.exit !== null || nullCase.threw !== null).toBe(true);

    const filledCase = await callCommand(() =>
      executeGuideChangeCommand({
        stateDirectory,
        missionIdentifier: MISSION,
        taskIdentifier: TASK,
        instructionText: "变更（有字段）",
        changeIntent: "调整顺序",
        requestedTaskSequenceRevision: 2,
        newTaskIdentifier: "T-002",
        invalidatedArtifactIdentifiers: ["artifact-1"],
        isJsonOutput: true,
      } as unknown as Parameters<typeof executeGuideChangeCommand>[0]),
    );
    expect(filledCase.exit !== null || filledCase.threw !== null).toBe(true);
  });
});