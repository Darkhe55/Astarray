/**
 * E2E-01-02 切片 4b：次级集成的合并门禁（验收 4）与主报告按需读取（验收 5）。
 *
 * - 验收 4：真实 git 仓库上，越界贡献被审查拒绝且目标分支不变；
 *   合规贡献在"未授权"时仍不合入，授权后才合入目标分支。
 * - 验收 5：三级终态报告只写入主 Agent 报告索引（不注入对话、不唤醒模型），
 *   主 Agent 后续轮次按需只读。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitContributionVerifier } from "../../../packages/core/src/orchestration/git-contribution-verifier.js";
import { GitIntegrationCoordinator } from "../../../packages/core/src/orchestration/git-integration-coordinator.js";
import { GitIntegrationReportStore } from "../../../packages/core/src/orchestration/git-integration-report-store.js";
import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";
import { GitRecoveryPointService } from "../../../packages/core/src/orchestration/git-recovery-point-service.js";
import { GitWorktreeAllocator } from "../../../packages/core/src/orchestration/git-worktree-allocator.js";
import { bootstrapCli } from "../../../packages/tui/src/cli/bootstrap.js";

// 真实 git 仓库 + worktree 端到端：覆盖率插桩下放宽（仍有界）。
vi.setConfig({ testTimeout: 60_000 });

let temporaryRootDirectory: string;
let repositoryPath: string;
let stateBaseDirectory: string;
let gitProcess: GitProcess;

const INTEGRATOR = "agent-secondary-integrator";
const TERTIARY = "agent-tertiary-impl";

async function runGit(
  workingDirectoryPath: string,
  gitArguments: string[],
): Promise<string> {
  const result = await gitProcess.run(workingDirectoryPath, gitArguments, "测试 git 命令");
  return result.stdoutText.trim();
}

async function createInitialRepository(): Promise<string> {
  const repoPath = path.join(temporaryRootDirectory, "repo");
  await fs.mkdir(repoPath);
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.name", "test-maintainer"]);
  await runGit(repoPath, ["config", "user.email", "maintainer@astarray.local"]);
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "src", "app.mjs"), "v1", "utf8");
  await fs.writeFile(path.join(repoPath, "docs", "readme.md"), "v1", "utf8");
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "基线提交"]);
  return repoPath;
}

function makeCoordinator(): GitIntegrationCoordinator {
  const allocator = new GitWorktreeAllocator({
    baseDirectory: stateBaseDirectory,
    gitProcess,
  });
  return new GitIntegrationCoordinator({
    worktreeAllocator: allocator,
    verifier: new GitContributionVerifier(gitProcess),
    reportStore: new GitIntegrationReportStore({ baseDirectory: stateBaseDirectory }),
    recoveryPointService: new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
      gitProcess,
    }),
    gitProcess,
  });
}

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-e2e01-integration-"),
  );
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(stateBaseDirectory);
  gitProcess = new GitProcess();
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("E2E-01-02 切片 4b", () => {
  it("验收 4：越界贡献被拒绝且目标分支不变；合规贡献未授权不合入、授权后合入", async () => {
    // 真实 git 仓库（仅本用例需要；放在用例内以便其余用例可在受限环境运行）
    repositoryPath = await createInitialRepository();
    const coordinator = makeCoordinator();
    const session = await coordinator.startIntegrationSession({
      missionId: "mission-vertical",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      targetBranchName: "main",
    });
    const allocation = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-vertical",
        taskId: "task-impl",
        tertiaryAgentInstanceId: TERTIARY,
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: session.targetBaseCommit,
        allowedPaths: ["src"],
      },
      repositoryPath,
    );
    const targetBefore = await runGit(repositoryPath, ["rev-parse", "main"]);

    // 越界：允许路径仅 src，却修改 docs/readme.md
    await fs.writeFile(
      path.join(allocation.worktreePath, "docs", "readme.md"),
      "越界修改",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "docs/readme.md"]);
    await runGit(
      allocation.worktreePath,
      ["-c", `user.name=${TERTIARY}`, "-c", `user.email=${TERTIARY}@astarray.local`, "commit", "-m", "越界提交"],
    );
    const outOfBoundHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const rejected = await coordinator.submitContribution({
      missionId: "mission-vertical",
      taskId: "task-impl",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: outOfBoundHead,
      executedChecks: [{ command: "node --test", exitCode: 0 }],
    });
    expect(rejected.reviewDecision).toBe("rejected");
    expect(rejected.rejectionReasons.join()).toContain("越过允许路径");
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).toBe(targetBefore);

    // 合规：修改 src/app.mjs 并以绑定身份提交
    await runGit(allocation.worktreePath, ["reset", "--hard", session.targetBaseCommit]);
    await fs.writeFile(
      path.join(allocation.worktreePath, "src", "app.mjs"),
      "v2-implemented",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "src/app.mjs"]);
    await runGit(
      allocation.worktreePath,
      ["-c", `user.name=${TERTIARY}`, "-c", `user.email=${TERTIARY}@astarray.local`, "commit", "-m", "实现 src/app.mjs"],
    );
    const compliantHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const accepted = await coordinator.submitContribution({
      missionId: "mission-vertical",
      taskId: "task-impl",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: compliantHead,
      executedChecks: [{ command: "node --test", exitCode: 0 }],
    });
    expect(accepted.reviewDecision).toBe("accepted");

    // 未授权：不得合入目标分支
    await coordinator.finalizeIntegration({
      missionId: "mission-vertical",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      integrationTestCommands: ["git status --porcelain"],
      isTargetBranchMergeAllowed: false,
    });
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).toBe(targetBefore);

    // 授权后：合入目标分支且产物落地
    await coordinator.finalizeIntegration({
      missionId: "mission-vertical",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      integrationTestCommands: ["git status --porcelain"],
      isTargetBranchMergeAllowed: true,
    });
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).not.toBe(targetBefore);
    expect(
      await fs.readFile(path.join(repositoryPath, "src", "app.mjs"), "utf8"),
    ).toBe("v2-implemented");
  });

  it("验收 5：三级终态报告只入索引，不注入主对话，主 Agent 按需只读", async () => {
    const conversationOutput: string[] = [];
    const applicationStateDirectory = path.join(temporaryRootDirectory, "app-state");
    const bootstrap = await bootstrapCli({
      mode: "assist",
      stateDirectory: applicationStateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      useFeedbackProcess: false,
      streamOutput: (_missionIdentifier, text) => {
        conversationOutput.push(text);
      },
    });
    try {
      // B6R-07：报告来源必须先登记（绑定 mission / 所属次级 / 任务包）
      bootstrap.registeredAgentDirectory.registerAgent({
        agentInstanceId: TERTIARY,
        agentRole: "tertiary",
        missionId: "mission-vertical",
        owningSecondaryAgentInstanceId: "agent-secondary-1",
        boundTaskBundleId: "bundle-1",
        registeredAtIso: new Date().toISOString(),
      });
      await bootstrap.controller.ingestTertiaryTerminalReport({
        reportId: "report-vertical-1",
        missionId: "mission-vertical",
        taskBundleId: "bundle-1",
        reportingAgentInstanceId: TERTIARY,
        reportKind: "completed",
        summary: "实现完成并已通过测试",
        executedChecks: [{ command: "node test/run-tests.mjs", exitCode: 0 }],
        createdAtIso: new Date().toISOString(),
        contentHash: "sha256:" + "0".repeat(64),
      });

      // 不注入对话、不唤醒主 Agent（无任何流式输出）
      expect(conversationOutput).toEqual([]);

      // 主 Agent 后续轮次按需只读索引
      const index = await bootstrap.controller.listReportIndex("mission-vertical");
      expect(index).toHaveLength(1);
      expect(index[0]?.reportId).toBe("report-vertical-1");
      expect(index[0]?.summaryPreview).toContain("实现完成");
      expect(conversationOutput).toEqual([]);
    } finally {
      await bootstrap.shutdown();
    }
  });
});
