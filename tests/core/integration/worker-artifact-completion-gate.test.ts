/**
 * 反例（完成门禁 × 产物对账，2026-10-02）：
 *
 * 必须同时满足两条看似矛盾的语义：
 *  - **验收缺失不得结案**：本 AGENT 成功写入过的产物若在结案前消失（或完成事件声明的产物
 *    不存在），必须判失败；
 *  - **不得误拦正常完成**：产物真实存在时，声明完成必须被接受（不得凭空要求产物）。
 *
 * 用真实文件系统 + 脚本运行时驱动 Worker，确保对账依据是**本地事实**而非模型自述。
 */
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentRuntime, TaskDependencyNode, ToolPort } from "../../../packages/core/src/core/types.js";
import { ToolFailureCounter } from "../../../packages/core/src/orchestration/failure-counter.js";
import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

let workspaceRootPath: string;

beforeEach(async () => {
  workspaceRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-worker-artifact-"));
});

afterEach(async () => {
  await fs.rm(workspaceRootPath, { recursive: true, force: true, maxRetries: 5 });
});

function makeTask(): TaskDependencyNode {
  return {
    id: "T-001",
    description: "创建产物文件",
    dependsOn: [],
    taskType: "data",
    toolNames: ["createProjectFile"],
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

/** 真实落盘的写端口（模拟 createProjectFile 的排他创建）。 */
function buildWritingToolPort(input: {
  relativePath: string;
  content: string;
  onSuccess?: () => void;
}): ToolPort {
  return {
    execute: async (_toolName, _argumentsJson, callId) => {
      const absolutePath = path.join(workspaceRootPath, input.relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, input.content, "utf8");
      input.onSuccess?.();
      return {
        kind: "success",
        callId,
        outputText: "已新建项目文件: " + input.relativePath,
        isSideEffectFree: false,
      };
    },
  } as ToolPort;
}

function completionMarkerLine(input: {
  attemptId: string;
  declaredArtifacts?: string[];
}): string {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:T-001",
      completionAttemptId: input.attemptId,
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
      ...(input.declaredArtifacts === undefined
        ? {}
        : { declaredArtifacts: input.declaredArtifacts }),
    })
  );
}

function buildWorker(input: {
  toolPort: ToolPort;
  finalText: string;
  relativePath: string;
}): WorkerAgent {
  const runtime = new ScriptedRuntime([
    {
      type: "tool-call",
      toolName: "createProjectFile",
      argumentsJson: JSON.stringify({ filePath: input.relativePath, content: "# A\n" }),
      callId: "call-1",
    },
    { type: "finish", reason: "tool-calls", detail: "请求工具" },
    { type: "text", text: input.finalText },
    { type: "finish", reason: "success", detail: "完成" },
  ]) as unknown as AgentRuntime;
  return new WorkerAgent({
    agentInstanceId: "worker-artifact-1",
    missionId: "mission-artifact",
    task: makeTask(),
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

describe("完成门禁 × 产物对账（Worker 运行时）", () => {
  it("① 产物存在时声明完成 → 接受（不得误拦正常完成）", async () => {
    const relativePath = "docs/ARTIFACT-OK.md";
    const worker = buildWorker({
      toolPort: buildWritingToolPort({ relativePath, content: "# A\n" }),
      finalText: "已完成。\n" + completionMarkerLine({ attemptId: "attempt-ok" }),
      relativePath,
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("success");
  });

  it("② 写成功但结案前产物消失 → 必须判失败（验收缺失不得结案）", async () => {
    const relativePath = "docs/ARTIFACT-VANISHED.md";
    const worker = buildWorker({
      toolPort: buildWritingToolPort({
        relativePath,
        content: "# A\n",
        // 模拟"写成功后产物被外部删除/从未持久化"：完成前把它删掉。
        onSuccess: () => {
          rmSync(path.join(workspaceRootPath, relativePath), { force: true });
        },
      }),
      finalText: "已完成。\n" + completionMarkerLine({ attemptId: "attempt-vanished" }),
      relativePath,
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("failure");
    if (outcome.outcome === "failure") {
      expect(outcome.failureReason).toContain("验收缺失");
      expect(outcome.failureReason).toContain(relativePath);
    }
  });

  it("③ 完成事件声明的产物不存在（即使本 AGENT 没写过它）→ 必须判失败", async () => {
    const relativePath = "docs/ARTIFACT-REAL.md";
    const worker = buildWorker({
      toolPort: buildWritingToolPort({ relativePath, content: "# A\n" }),
      finalText:
        "已完成。\n" +
        completionMarkerLine({
          attemptId: "attempt-declared",
          declaredArtifacts: ["docs/NEVER-CREATED.md"],
        }),
      relativePath,
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("failure");
    if (outcome.outcome === "failure") {
      expect(outcome.failureReason).toContain("NEVER-CREATED.md");
    }
  });

  it("④ 完成事件声明的越界路径 → 必须判失败（不得按工作区外路径放行）", async () => {
    const relativePath = "docs/ARTIFACT-BOUNDARY.md";
    const worker = buildWorker({
      toolPort: buildWritingToolPort({ relativePath, content: "# A\n" }),
      finalText:
        "已完成。\n" +
        completionMarkerLine({
          attemptId: "attempt-boundary",
          declaredArtifacts: ["../outside.md"],
        }),
      relativePath,
    });
    const outcome = await worker.run();
    expect(outcome.outcome).toBe("failure");
    if (outcome.outcome === "failure") {
      expect(outcome.failureReason).toContain("拒绝工作区外路径");
    }
  });
});
