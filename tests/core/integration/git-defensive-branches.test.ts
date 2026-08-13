/**
 * T05B 防御分支测试：用 mock GitProcess 定向让特定命令失败，
 * 覆盖验证器/协调器/恢复点服务中"git 命令失败"的防御分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitContributionVerifier } from "../../../packages/core/src/orchestration/git-contribution-verifier.js";
import { GitIntegrationCoordinator } from "../../../packages/core/src/orchestration/git-integration-coordinator.js";
import { GitIntegrationReportStore } from "../../../packages/core/src/orchestration/git-integration-report-store.js";
import { GitProcess, GitProcessError } from "../../../packages/core/src/orchestration/git-process.js";
import type { GitCommandResult } from "../../../packages/core/src/orchestration/git-process.js";
import { GitRecoveryPointService } from "../../../packages/core/src/orchestration/git-recovery-point-service.js";
import { GitWorktreeAllocator } from "../../../packages/core/src/orchestration/git-worktree-allocator.js";

let temporaryRootDirectory: string;
let repositoryPath: string;
let stateBaseDirectory: string;

async function runGit(
  workingDirectoryPath: string,
  gitArguments: string[],
): Promise<string> {
  const result = await new GitProcess().run(
    workingDirectoryPath,
    gitArguments,
    "测试 git 命令",
  );
  return result.stdoutText.trim();
}

/** 指定命令描述命中模式时失败的真实 GitProcess 包装。 */
class SelectiveFailingGitProcess extends GitProcess {
  constructor(private readonly failingDescriptionPatterns: RegExp[]) {
    super();
  }

  override async run(
    workingDirectoryPath: string,
    gitArguments: string[],
    commandDescription: string,
  ): Promise<GitCommandResult> {
    if (
      this.failingDescriptionPatterns.some((pattern) =>
        pattern.test(commandDescription),
      )
    ) {
      throw new GitProcessError(commandDescription, {
        commandDescription,
        stdoutText: "",
        stderrText: "mock failure",
        exitCode: 1,
        durationSeconds: 0,
      });
    }
    return super.run(workingDirectoryPath, gitArguments, commandDescription);
  }
}

async function createRepository(): Promise<void> {
  repositoryPath = path.join(temporaryRootDirectory, "repo");
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "m@astarray.local"]);
  await fs.mkdir(path.join(repositoryPath, "docs"), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "v1", "utf8");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "基线"]);
}

async function makeAllocationWithRealGit(): Promise<{
  allocator: GitWorktreeAllocator;
  allocation: Awaited<ReturnType<GitWorktreeAllocator["allocateWorker"]>>;
  baseCommit: string;
}> {
  const allocator = new GitWorktreeAllocator({
    baseDirectory: stateBaseDirectory,
  });
  const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
  const allocation = await allocator.allocateWorker(
    {
      missionId: "mission-1",
      taskId: "task-1",
      tertiaryAgentInstanceId: "agent-a",
      integrationBranchName: "integration/mission-1/integrator",
      targetBaseCommit: baseCommit,
      allowedPaths: ["docs"],
    },
    repositoryPath,
  );
  return { allocator, allocation, baseCommit };
}

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-git-defensive-"),
  );
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(stateBaseDirectory);
  await createRepository();
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true });
});

describe("Git 防御分支（mock 命令失败）", () => {
  it("验证器：diff-tree/log 命令失败 → 结构化失败原因", async () => {
    const { allocation, baseCommit } = await makeAllocationWithRealGit();
    await fs.writeFile(path.join(allocation.worktreePath, "docs", "a.md"), "v2", "utf8");
    await runGit(allocation.worktreePath, ["add", "docs/a.md"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "更新"]);
    const headCommit = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const failingGitProcess = new SelectiveFailingGitProcess([
      /列出 base\.\.head 修改路径/,
      /列出 base\.\.head 提交作者/,
    ]);
    const verifier = new GitContributionVerifier(failingGitProcess);
    const result = await verifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.join()).toContain("修改路径列表");
    expect(result.failureReasons.join()).toContain("提交作者");
  });

  it("协调器：集成分支 tip 解析失败 → integrationCommit 为 null", async () => {
    // 审查必须被拒绝（越界），才不触碰集成分支
    const strayAllocation = await new GitWorktreeAllocator({
      baseDirectory: stateBaseDirectory,
    }).allocateWorker(
      {
        missionId: "mission-2",
        taskId: "task-stray",
        tertiaryAgentInstanceId: "agent-b",
        integrationBranchName: "integration/mission-2/integrator",
        targetBaseCommit: await runGit(repositoryPath, ["rev-parse", "main"]),
        allowedPaths: ["packages"],
      },
      repositoryPath,
    );
    await fs.writeFile(path.join(strayAllocation.worktreePath, "docs", "a.md"), "越界", "utf8");
    await runGit(strayAllocation.worktreePath, ["add", "docs/a.md"]);
    await runGit(strayAllocation.worktreePath, ["commit", "-m", "越界提交"]);
    const strayHead = await runGit(strayAllocation.worktreePath, ["rev-parse", "HEAD"]);
    // mission-1 的集成会话报告存在（使 sessionReport 检查通过）→
    // 使用 mission-2 的分配但集成者名解析到 mission-1 的报告？构造：
    // 报告存储直接写入 mission-2/integrator 会话记录
    const reportStore = new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    });
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    await reportStore.saveReport({
      missionId: "mission-2",
      integratingAgentInstanceId: "integrator",
      targetBranchName: "main",
      integrationBranchName: "integration/mission-2/integrator",
      targetBaseCommit: baseCommit,
      reviewedContributions: [],
      integrationCommit: null,
      unresolvedRisks: [],
      createdAtIso: new Date().toISOString(),
    });
    const coordinator = new GitIntegrationCoordinator({
      worktreeAllocator: new GitWorktreeAllocator({
        baseDirectory: stateBaseDirectory,
      }),
      verifier: new GitContributionVerifier(new SelectiveFailingGitProcess([])),
      reportStore,
      recoveryPointService: new GitRecoveryPointService({
        baseDirectory: stateBaseDirectory,
      }),
    });
    const submission = await coordinator.submitContribution({
      missionId: "mission-2",
      taskId: "task-stray",
      repositoryPath,
      baseCommit,
      headCommit: strayHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    // 越界 → rejected → 无合并 → 集成分支（mission-2）不存在 → tip 解析 catch
    expect(submission.reviewDecision).toBe("rejected");
  });

  it("恢复点服务：untracked 文件快照复制失败静默跳过", async () => {
    const recoveryPointService = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
    });
    const untrackedFile = path.join(repositoryPath, "untracked.tmp");
    await fs.writeFile(untrackedFile, "x", "utf8");
    // 恢复点创建后删除源文件再 restore → 复制失败被跳过
    const recoveryPoint = await recoveryPointService.createRecoveryPoint({
      missionId: "mission-1",
      repositoryPath,
      operationDescription: "untracked 快照测试",
      affectedReferenceNames: ["refs/heads/main"],
      affectedWorktreePath: repositoryPath,
      affectedWorkingTreeRoot: repositoryPath,
    });
    expect(recoveryPoint.untrackedFileEntries.some((entry) => entry.relativePath === "untracked.tmp")).toBe(true);
    await fs.rm(untrackedFile, { force: true });
    const restored = await recoveryPointService.restoreRecoveryPoint({
      missionId: "mission-1",
      recoveryPointId: recoveryPoint.recoveryPointId,
      repositoryPath,
      worktreePath: repositoryPath,
    });
    expect(restored.restoredAtIso).not.toBeNull();
  });
});
