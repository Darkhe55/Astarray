/**
 * T12A-R1-03 测试：context transaction 公共入口（只读对账 + 幂等重放）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextClosureCapsuleStore } from "../../../packages/core/src/orchestration/context-closure-capsule-store.js";
import { ContextNodeLifecycleController } from "../../../packages/core/src/orchestration/context-node-lifecycle.js";
import {
  HumanVerificationController,
  HumanVerificationPolicyStore,
} from "../../../packages/core/src/orchestration/human-verification-controller.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";
import { executeContextTransactionCommand } from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12ar1-03-cli-"));
  stdoutBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seedPartialCommit(): Promise<void> {
  const graphStore = new LocalContextGraphStore({ baseDirectory: stateDirectory });
  const capsuleStore = new ContextClosureCapsuleStore({ baseDirectory: stateDirectory });
  const lifecycle = new ContextNodeLifecycleController({
    graphStore,
    capsuleStore,
    humanVerificationController: new HumanVerificationController({
      baseDirectory: stateDirectory,
      graphStore,
    }),
    humanVerificationPolicyStore: new HumanVerificationPolicyStore({
      baseDirectory: stateDirectory,
    }),
  });
  const begun = await lifecycle.beginTaskNode({
    ownerAgentInstanceId: "agent-1",
    missionId: "mission-1",
    taskIdentifier: "T-1",
    taskDescription: "部分提交探针",
  });
  await lifecycle.markTaskNodeVerified({
    ownerAgentInstanceId: "agent-1",
    missionId: "mission-1",
    contextNodeIdentifier: begun.contextNodeIdentifier,
  });
  const graph = await graphStore.readGraph("agent-1", "mission-1");
  await graphStore.closeNode({
    ownerAgentInstanceId: "agent-1",
    graphIdentifier: "mission-1",
    expectedGraphRevision: graph!.revision,
    contextNodeIdentifier: begun.contextNodeIdentifier,
    targetState: "deferred-review-closed",
  });
}

function parseOutput(): Record<string, unknown> {
  return JSON.parse(stdoutBuffer.join("")) as Record<string, unknown>;
}

describe("context transaction 命令", () => {
  it("部分提交 → 只读对账报告缺口并以失败退出码结束", async () => {
    await seedPartialCommit();
    const exitCode = await executeContextTransactionCommand({
      stateDirectory,
      agentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
      modeKey: "devolve",
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
    const view = parseOutput();
    expect(view.isComplete).toBe(false);
    expect(view.missingPieces).toContain("closure-capsule");
    expect(view.nodeState).toBe("deferred-review-closed");
  });

  it("--replay 补齐缺口，重复调用不再产生动作", async () => {
    await seedPartialCommit();
    const firstExitCode = await executeContextTransactionCommand({
      stateDirectory,
      agentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
      modeKey: "devolve",
      taskDescription: "部分提交探针",
      summaryText: "完成摘要",
      isReplayRequested: true,
      isJsonOutput: true,
    });
    expect(firstExitCode).toBe(0);
    const firstView = parseOutput();
    expect(firstView.isComplete).toBe(true);
    expect(firstView.replayedActions).toContain("closure-capsule");
    expect(firstView.replayedActions).toContain("deferred-verification-task");
    const firstRevision = firstView.graphRevision;

    stdoutBuffer.length = 0;
    const secondExitCode = await executeContextTransactionCommand({
      stateDirectory,
      agentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
      modeKey: "devolve",
      taskDescription: "部分提交探针",
      summaryText: "完成摘要",
      isReplayRequested: true,
      isJsonOutput: true,
    });
    expect(secondExitCode).toBe(0);
    const secondView = parseOutput();
    expect(secondView.replayedActions).toEqual([]);
    expect(secondView.graphRevision).toBe(firstRevision);
  });

  it("缺少重放输入时拒绝执行重放（不伪造摘要）", async () => {
    await seedPartialCommit();
    const exitCode = await executeContextTransactionCommand({
      stateDirectory,
      agentInstanceId: "agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
      modeKey: "devolve",
      isReplayRequested: true,
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
    expect(stdoutBuffer.join("")).toContain("--description");
  });
});
