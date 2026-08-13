/**
 * T08 编排层 Git 集成测试（T05B → T08，Batch 5 复验）。
 * 真实 git 仓库 + MissionOrchestrator（Assist 调度）：
 * - 写入型任务自动分配隔离 worktree，Worker 提交 → 审查 → 合并 → 门禁合入目标分支；
 * - 越界修改被审查拒绝 → 任务 blocked 且未合并；
 * - 未装配 Git 集成时行为与旧版一致（任务正常完成）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentRuntime,
  TaskChainDocument,
  TaskDependencyNode,
  ToolPort,
} from "../../../packages/core/src/core/types.js";
import type { AgentWorkArchiveStore } from "../../../packages/core/src/orchestration/work-archive-store.js";
import { AssistScheduler } from "../../../packages/core/src/orchestration/assist-scheduler.js";
import { GitContributionVerifier } from "../../../packages/core/src/orchestration/git-contribution-verifier.js";
import { GitIntegrationCoordinator } from "../../../packages/core/src/orchestration/git-integration-coordinator.js";
import { GitIntegrationReportStore } from "../../../packages/core/src/orchestration/git-integration-report-store.js";
import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";
import { GitRecoveryPointService } from "../../../packages/core/src/orchestration/git-recovery-point-service.js";
import { GitWorktreeAllocator } from "../../../packages/core/src/orchestration/git-worktree-allocator.js";
import { encodeGitRefSegment } from "../../../packages/core/src/orchestration/git-worktree-allocator.js";
import { sanitizePathSegment } from "../../../packages/core/src/orchestration/work-archive-store.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";
import type { ScriptedRunStep } from "../../../packages/core/src/runtime/scripted-runtime.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

let temporaryRootDirectory: string;
let stateBaseDirectory: string;
let repositoryPath: string;
let taskStore: TaskStore;
let gitProcess: GitProcess;

async function runGit(
  workingDirectoryPath: string,
  gitArguments: string[],
): Promise<string> {
  const result = await gitProcess.run(workingDirectoryPath, gitArguments, "测试 git 命令");
  return result.stdoutText.trim();
}

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-orchestrator-git-"),
  );
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(stateBaseDirectory);
  taskStore = new TaskStore({ baseDirectory: stateBaseDirectory });
  gitProcess = new GitProcess();
  repositoryPath = path.join(temporaryRootDirectory, "repo");
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "m@astarray.local"]);
  await fs.mkdir(path.join(repositoryPath, "docs"), { recursive: true });
  await fs.mkdir(path.join(repositoryPath, "packages"), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "v1", "utf8");
  await fs.writeFile(path.join(repositoryPath, "packages", "app.ts"), "v1", "utf8");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "基线提交"]);
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true }).catch(() => {});
});

function makeCoordinator(): GitIntegrationCoordinator {
  return new GitIntegrationCoordinator({
    worktreeAllocator: new GitWorktreeAllocator({
      baseDirectory: stateBaseDirectory,
      gitProcess,
    }),
    verifier: new GitContributionVerifier(gitProcess),
    reportStore: new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    }),
    recoveryPointService: new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
      gitProcess,
    }),
    gitProcess,
  });
}

/** 模拟 Worker 写文件的工具端口：把内容写入指定根目录下的目标文件。 */
function makeWriteToolPort(workRootPath: string): ToolPort {
  return {
    execute: async (
      toolName: string,
      argumentsJson: string,
      callId: string,
      _signal: AbortSignal,
    ) => {
      if (toolName !== "writeFile") {
        return {
          kind: "error",
          callId,
          errorCode: "tool-not-found",
          errorMessage: `未模拟工具: ${toolName}`,
          isIdempotencyConfirmed: false,
        };
      }
      const args = JSON.parse(argumentsJson) as {
        filePath: string;
        content: string;
      };
      const targetPath = path.join(workRootPath, args.filePath);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, args.content, "utf8");
        return {
          kind: "success",
          callId,
          outputText: `已写入 ${args.filePath}`,
          isSideEffectFree: false,
        };
      } catch (error) {
        return {
          kind: "error",
          callId,
          errorCode: "tool-execution-failed",
          errorMessage: (error as Error).message,
          isIdempotencyConfirmed: false,
        };
      }
    },
  };
}

function makeWriteScript(filePath: string, content: string): ScriptedRunStep[] {
  return [
    {
      type: "tool-call",
      toolName: "writeFile",
      argumentsJson: JSON.stringify({ filePath, content }),
      callId: "call-1",
    },
    // 第一轮以 tool-calls 结束 → ToolLoop 执行工具并回填 → 第二轮 success
    { type: "finish", reason: "tool-calls", detail: "请求工具" },
    { type: "finish", reason: "success", detail: "写入完成" },
  ];
}

function makeTask(
  id: string,
  taskType: string,
  dependsOn: string[] = [],
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType,
    toolNames: ["writeFile"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

async function makeInitialChain(
  missionId: string,
  tasks: TaskDependencyNode[],
): Promise<TaskChainDocument> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId,
    revision: 1,
    updatedAtIso: new Date().toISOString(),
    tasks,
  };
  await taskStore.writeTaskChain(chain);
  return chain;
}

interface BuildSchedulerOptions {
  missionId: string;
  tasks: TaskDependencyNode[];
  script: unknown[];
  gitIntegration: ReturnType<typeof buildGitIntegrationOptions> | null;
  escalationMessages: string[];
  finishedStatuses: Array<"done" | "cancelled">;
  workArchiveStore: AgentWorkArchiveStore | null;
}

function buildGitIntegrationOptions(isTargetMergeAllowed: boolean): {
  coordinator: GitIntegrationCoordinator;
  repositoryPath: string;
  targetBranchName: string;
  allowedPathsByTaskType: Record<string, string[]>;
  integrationTestCommands: string[];
  isTargetBranchMergeAllowed: () => boolean;
  buildGitWorktreeToolPort: (
    task: TaskDependencyNode,
    worktreePath: string,
  ) => ToolPort;
} {
  return {
    coordinator: makeCoordinator(),
    repositoryPath,
    targetBranchName: "main",
    allowedPathsByTaskType: { code: ["docs", "packages"] },
    integrationTestCommands: ["git status --porcelain"],
    isTargetBranchMergeAllowed: () => isTargetMergeAllowed,
    buildGitWorktreeToolPort: (_task, worktreePath) =>
      makeWriteToolPort(worktreePath),
  };
}

function buildScheduler(options: BuildSchedulerOptions): AssistScheduler {
  const scheduler = new AssistScheduler({
    missionId: options.missionId,
    initialChain: {
      schemaVersion: 1,
      missionId: options.missionId,
      revision: 1,
      updatedAtIso: new Date().toISOString(),
      tasks: options.tasks,
    },
    taskStore,
    concurrency: 2,
    failureThreshold: 3,
    maxLoopIterations: 5,
    feedbackTransport: {
      enqueue: async () => {},
      queryHealth: async () => ({
        isHealthy: true,
        processPid: null,
        protocolVersion: 1,
        queuedMessageCount: 0,
      }),
      shutdown: async () => {},
      setAgentStatus: () => {},
      onMessage: () => {},
    },
    feedbackTransportFactory: async () => ({
      enqueue: async () => {},
      queryHealth: async () => ({
        isHealthy: true,
        processPid: null,
        protocolVersion: 1,
        queuedMessageCount: 0,
      }),
      shutdown: async () => {},
      setAgentStatus: () => {},
      onMessage: () => {},
    }),
    secondaryAgentInstanceId: `scheduler:${options.missionId}:instance`,
    gitIntegration: options.gitIntegration,
    workArchiveStore: options.workArchiveStore,
    workerFactories: {
      runtimeFactory: (_agentInstanceId, _task): AgentRuntime => {
        // 按任务选择脚本：调用方通过 toolPort 模拟写文件，runtime 只是驱动
        return new ScriptedRuntime(options.script as never);
      },
      toolPortFactory: (_task) => makeWriteToolPort(repositoryPath),
      buildPermissionExplanation: () => "测试",
    },
    onReportToMain: (message) => {
      if (message.payload.kind !== "instruction") {
        return;
      }
      const text = message.payload.instructionText;
      if (text.startsWith("任务完成状态:")) {
        options.finishedStatuses.push(text.includes("done") ? "done" : "cancelled");
        return;
      }
      options.escalationMessages.push(text);
    },
  });
  return scheduler;
}

// vitest coverage 插桩会拖慢真实 git 端到端流程，放宽文件级超时。
async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadlineMs) {
      throw new Error(`等待超时: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe(
  "T08 编排层 Git 集成",
  () => {  it("写入型任务：worktree 提交 → 审查通过 → 集成分支合并 → 门禁合入目标分支", async () => {
    const missionId = "mission-git-ok";
    const tasks = [makeTask("task-1", "code")];
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const scheduler = buildScheduler({
      missionId,
      tasks,
      script: makeWriteScript("docs/a.md", "v2-from-worker"),
      gitIntegration: buildGitIntegrationOptions(true),
      escalationMessages,
      finishedStatuses,
      workArchiveStore: null,
    });
    void scheduler.start();
    await waitForCondition(
      () => finishedStatuses.length > 0,
      30_000,
      "mission 完成",
    );
    expect(finishedStatuses).toEqual(["done"]);
    // 目标分支合入后内容来自 Worker
    expect(
      await fs.readFile(path.join(repositoryPath, "docs", "a.md"), "utf8"),
    ).toBe("v2-from-worker");
    // 集成报告可追溯
    const reportStore = new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    });
    const report = await reportStore.readReport(
      missionId,
      `scheduler:${missionId}:instance`,
    );
    expect(report?.reviewedContributions).toHaveLength(1);
    expect(report?.reviewedContributions[0]).toMatchObject({
      taskId: "task-1",
      reviewDecision: "accepted",
    });
    expect(report?.integrationCommit).not.toBeNull();
  });

  it("越界修改被审查拒绝：任务 blocked、未合并、escalation 提示", async () => {
    const missionId = "mission-git-blocked";
    const tasks = [makeTask("task-1", "code")];
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const gitIntegration = buildGitIntegrationOptions(true);
    gitIntegration.allowedPathsByTaskType = { code: ["docs"] };
    const scheduler = buildScheduler({
      missionId,
      tasks,
      script: makeWriteScript("packages/app.ts", "越界修改"),
      gitIntegration,
      escalationMessages,
      finishedStatuses,
      workArchiveStore: null,
    });
    void scheduler.start();
    await waitForCondition(
      () =>
        escalationMessages.some((message) => message.includes("审查拒绝")),
      30_000,
      "审查拒绝 escalation",
    );
    expect(finishedStatuses).toEqual([]);
    // 任务保持 blocked（任务链状态）
    const chain = await taskStore.readTaskChain(missionId);
    expect(chain?.tasks[0]?.status).toBe("blocked");
    // 集成分支未收到越界提交
    const integrationBranch = `integration/${missionId}/${encodeGitRefSegment("scheduler:mission-git-blocked:instance")}`;
    const branchExists = await runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${integrationBranch}`,
    ])
      .then(() => true)
      .catch(() => false);
    if (branchExists) {
      const base = await runGit(repositoryPath, ["rev-parse", "main"]);
      const integrationLog = await runGit(repositoryPath, [
        "log",
        "--format=%s",
        `${base}..${integrationBranch}`,
      ]);
      expect(integrationLog).not.toContain("越界");
    }
    // 目标分支未被合并（内容不变）
    expect(
      await fs.readFile(path.join(repositoryPath, "packages", "app.ts"), "utf8"),
    ).toBe("v1");
  });

  it("未装配 Git 集成：行为与旧版一致（任务直接完成）", async () => {
    const missionId = "mission-git-unused";
    const tasks = [makeTask("task-1", "data")];
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const finishedStatuses: Array<"done" | "cancelled"> = [];
    const scheduler = buildScheduler({
      missionId,
      tasks,
      script: makeWriteScript("docs/a.md", "无集成版本"),
      gitIntegration: null,
      escalationMessages,
      finishedStatuses,
      workArchiveStore: null,
    });
    await scheduler.start();
    expect(finishedStatuses).toEqual(["done"]);
    expect(escalationMessages).toEqual([]);
  });

  it("写入型任务分配失败：escalation 且不启动 Worker", async () => {
    const missionId = "mission-git-alloc-fail";
    const tasks = [makeTask("task-1", "code")];
    await makeInitialChain(missionId, tasks);
    const escalationMessages: string[] = [];
    const finishedStatuses: Array<"done" | "cancelled"> = [];
    // 预占用 worktree 路径（分配器真实路径：<state>/git-worktrees/<mission>/<task>/<sanitize(agent)>，
    // agent 实例 ID 首个为 worker:<mission>:<task>:1）使分配失败
    const firstWorkerAgentInstanceId = `worker:${missionId}:task-1:1`;
    const occupiedWorktreePath = path.join(
      stateBaseDirectory,
      "git-worktrees",
      missionId,
      "task-1",
      sanitizePathSegment(firstWorkerAgentInstanceId),
    );
    await fs.mkdir(occupiedWorktreePath, { recursive: true });
    // git worktree add 接受已存在的空目录；非空目录才会失败
    await fs.writeFile(
      path.join(occupiedWorktreePath, "occupied.txt"),
      "占用",
      "utf8",
    );
    const gitIntegration = buildGitIntegrationOptions(true);
    const scheduler = buildScheduler({
      missionId,
      tasks,
      script: makeWriteScript("docs/a.md", "不应写入"),
      gitIntegration,
      escalationMessages,
      finishedStatuses,
      workArchiveStore: null,
    });
    void scheduler.start();
    await waitForCondition(
      () =>
        escalationMessages.some((message) =>
          message.includes("worktree 分配失败"),
        ),
      30_000,
      "worktree 分配失败 escalation",
    );
    expect(finishedStatuses).toEqual([]);
  });
  },
  60_000,
);
