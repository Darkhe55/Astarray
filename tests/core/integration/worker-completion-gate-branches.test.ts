/**
 * 反例（完成门禁的"必需操作 + 产物存在性"分支，2026-10-02 阻断项）：
 *
 * 覆盖 4 条分支，确保"产物缺失/未执行却声称完成"的各种形态都不得结案：
 *  ① 尝试过写工具但一次都没成功（被门禁拦下）→ 拒绝；
 *  ② 写工具成功过、但完成前产物消失 → 拒绝；
 *  ③ 写工具成功、产物存在 → 接受（不误拦）；
 *  ④ 只读任务（从未尝试写工具）→ 不因该规则被拦。
 *
 * 产物对账根显式指向临时目录，避免读写宿主仓库。
 */
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";


import type {
  AgentRuntime,
  TaskDependencyNode,
  ToolCallResult,
  ToolPort,
} from "../../../packages/core/src/core/types.js";
import { ToolFailureCounter } from "../../../packages/core/src/orchestration/failure-counter.js";
import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

let workspaceRootPath: string;

beforeEach(async () => {
  workspaceRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-worker-branches-"));
});

afterEach(async () => {
  try {
    await fs.rm(workspaceRootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function makeTask(toolNames: string[]): TaskDependencyNode {
  return {
    id: "T-001",
    description: "任务",
    dependsOn: [],
    taskType: "data",
    toolNames,
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

function makeTransport(): never {
  return {
    enqueue: async () => {},
    queryHealth: async () => ({
      isHealthy: true,
      processPid: 0,
      protocolVersion: 1,
      queuedMessageCount: 0,
    }),
    shutdown: async () => {},
    setAgentStatus: () => {},
    onMessage: () => {},
  } as never;
}

function completionMarker(declaredArtifacts?: string[]): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:T-001",
      completionAttemptId: "attempt-" + Math.random().toString(36).slice(2, 8),
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
      ...(declaredArtifacts === undefined ? {} : { declaredArtifacts }),
    })
  );
}

/** 固定返回指定错误结果的端口（模拟"被门禁拦下/执行失败"）。 */
function buildFailingPort(errorCode: string): ToolPort {
  return {
    execute: async (_toolName, _argumentsJson, callId): Promise<ToolCallResult> => ({
      kind: "error",
      callId,
      errorCode,
      errorMessage: "被拦下",
      isIdempotencyConfirmed: true,
      sideEffectStatus: "none",
    }),
  } as ToolPort;
}

/** 真实落盘的写端口。 */
function buildWritingPort(input: {
  relativePath: string;
  content: string;
  afterSuccess?: () => void;
}): ToolPort {
  return {
    execute: async (_toolName, _argumentsJson, callId): Promise<ToolCallResult> => {
      const absolutePath = path.join(workspaceRootPath, input.relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, input.content, "utf8");
      input.afterSuccess?.();
      return { kind: "success", callId, outputText: "已写入", isSideEffectFree: false };
    },
  } as ToolPort;
}

function buildWorker(input: {
  task: TaskDependencyNode;
  toolPort: ToolPort;
  toolName: string;
  argumentsJson: string;
  finalText: string;
}): WorkerAgent {
  const runtime = new ScriptedRuntime([
    {
      type: "tool-call",
      toolName: input.toolName,
      argumentsJson: input.argumentsJson,
      callId: "call-1",
    },
    { type: "finish", reason: "tool-calls", detail: "请求工具" },
    { type: "text", text: input.finalText },
    { type: "finish", reason: "success", detail: "完成" },
  ]) as unknown as AgentRuntime;
  return new WorkerAgent({
    agentInstanceId: "worker-branches",
    missionId: "mission-branches",
    task: input.task,
    runtime,
    requireCompletionEvent: true,
    artifactWorkspaceRootPath: workspaceRootPath,
    toolPort: input.toolPort,
    failureCounter: new ToolFailureCounter(),
    feedbackTransport: makeTransport(),
    maxLoopIterations: 6,
    buildPermissionExplanation: () => "说明",
  });
}

describe("完成门禁分支：必需操作与产物存在性", () => {
  it("① 尝试过写工具但从未成功（执行失败）→ 拒绝结案", async () => {
    const worker = buildWorker({
      task: makeTask(["createProjectFile"]),
      // 非权限类失败：工具被调用过、但一次都没成功。
      toolPort: buildFailingPort("tool-execution-failed"),
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: "docs/A.md", content: "# A\n" }),
      finalText: "已完成。\n" + completionMarker(),
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("failure");
    if (outcome.outcome === "failure") {
      expect(outcome.failureReason).toContain("必需操作未成功执行");
    }
  });

  it("② 写成功但产物消失 → 拒绝结案（产物对账）", async () => {
    const relativePath = "docs/VANISH.md";
    const worker = buildWorker({
      task: makeTask(["createProjectFile"]),
      toolPort: buildWritingPort({
        relativePath,
        content: "# V\n",
        afterSuccess: () => rmSync(path.join(workspaceRootPath, relativePath), { force: true }),
      }),
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: relativePath, content: "# V\n" }),
      finalText: "已完成。\n" + completionMarker(),
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("failure");
    if (outcome.outcome === "failure") {
      expect(outcome.failureReason).toContain("产物不存在");
    }
  });

  it("③ 写成功且产物存在 → 接受", async () => {
    const relativePath = "docs/PRESENT.md";
    const worker = buildWorker({
      task: makeTask(["createProjectFile"]),
      toolPort: buildWritingPort({ relativePath, content: "# P\n" }),
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: relativePath, content: "# P\n" }),
      finalText: "已完成。\n" + completionMarker(),
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("success");
  });

  it("④ 只读任务（从未尝试写工具）→ 不被必需操作规则拦下", async () => {
    const worker = buildWorker({
      task: makeTask(["readFile"]),
      toolPort: {
        execute: async (_toolName, _argumentsJson, callId) => ({
          kind: "success",
          callId,
          outputText: "文件内容",
          isSideEffectFree: true,
        }),
      } as ToolPort,
      toolName: "readFile",
      argumentsJson: JSON.stringify({ filePath: "docs/READ.md" }),
      finalText: "读取完成。\n" + completionMarker(),
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("success");
  });
});
