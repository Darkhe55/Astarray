/**
 * T05B 集成测试：次级 Agent Git 分流、审查与合并（ADR-0012，Batch 4D）。
 * 真实 git 仓库端到端：集成分支 → 双 worker 并行 worktree → 身份/越界/敏感信息
 * 审查拒绝 → 保留来源合并 → 集成测试门禁 → 目标分支受控合入。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitContributionVerifier } from "../../../packages/core/src/orchestration/git-contribution-verifier.js";
import { GitIntegrationCoordinator } from "../../../packages/core/src/orchestration/git-integration-coordinator.js";
import { GitIntegrationReportStore } from "../../../packages/core/src/orchestration/git-integration-report-store.js";
import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";
import { GitRecoveryPointService } from "../../../packages/core/src/orchestration/git-recovery-point-service.js";
import { GitWorktreeAllocator } from "../../../packages/core/src/orchestration/git-worktree-allocator.js";

let temporaryRootDirectory: string;
let repositoryPath: string;
let stateBaseDirectory: string;
let gitProcess: GitProcess;

const INTEGRATOR = "agent-secondary-integrator";

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
  await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "packages"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "docs", "a.md"), "v1", "utf8");
  await fs.writeFile(path.join(repoPath, "packages", "app.ts"), "v1", "utf8");
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "基线提交"]);
  return repoPath;
}

function makeCoordinator(): GitIntegrationCoordinator {
  const allocator = new GitWorktreeAllocator({
    baseDirectory: stateBaseDirectory,
    gitProcess,
  });
  const verifier = new GitContributionVerifier(gitProcess);
  const reportStore = new GitIntegrationReportStore({
    baseDirectory: stateBaseDirectory,
  });
  const recoveryPointService = new GitRecoveryPointService({
    baseDirectory: stateBaseDirectory,
    gitProcess,
  });
  return new GitIntegrationCoordinator({
    worktreeAllocator: allocator,
    verifier,
    reportStore,
    recoveryPointService,
    gitProcess,
  });
}

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-git-integration-"),
  );
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(stateBaseDirectory);
  gitProcess = new GitProcess();
  repositoryPath = await createInitialRepository();
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true });
});

// vitest coverage 插桩会显著拖慢真实 git 端到端流程，放宽文件级超时。
describe(
  "GitIntegrationCoordinator 端到端",
  () => {
    it("双 worker 并行提交 → 审查通过 → 集成分支合并 → 门禁后合入目标分支", async () => {
      const coordinator = makeCoordinator();
      const session = await coordinator.startIntegrationSession({
        missionId: "mission-1",
        integratingAgentInstanceId: INTEGRATOR,
        repositoryPath,
        targetBranchName: "main",
      });
      expect(session.integrationBranchName).toContain("integration/mission-1/");

    // 两个三级 Agent 分配独立 worktree
    const allocationA = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-docs",
        tertiaryAgentInstanceId: "agent-tertiary-a",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: session.targetBaseCommit,
        allowedPaths: ["docs"],
      },
      repositoryPath,
    );
    const allocationB = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-app",
        tertiaryAgentInstanceId: "agent-tertiary-b",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: session.targetBaseCommit,
        allowedPaths: ["packages"],
      },
      repositoryPath,
    );
    expect(allocationA.worktreePath).not.toBe(allocationB.worktreePath);

    // Agent A 在自己的 worktree 提交 docs/a.md
    await fs.writeFile(
      path.join(allocationA.worktreePath, "docs", "a.md"),
      "v2-by-a",
      "utf8",
    );
    await runGit(allocationA.worktreePath, ["add", "docs/a.md"]);
    await runGit(allocationA.worktreePath, ["commit", "-m", "A: 更新 docs/a.md"]);
    const headCommitA = await runGit(allocationA.worktreePath, ["rev-parse", "HEAD"]);

    // Agent B 在自己的 worktree 提交 packages/app.ts（互不污染）
    await fs.writeFile(
      path.join(allocationB.worktreePath, "packages", "app.ts"),
      "v2-by-b",
      "utf8",
    );
    await runGit(allocationB.worktreePath, ["add", "packages/app.ts"]);
    await runGit(allocationB.worktreePath, ["commit", "-m", "B: 更新 packages/app.ts"]);
    const headCommitB = await runGit(allocationB.worktreePath, ["rev-parse", "HEAD"]);

    // A 的 worktree 不受 B 影响
    const aContentAfterB = await fs.readFile(
      path.join(allocationA.worktreePath, "packages", "app.ts"),
      "utf8",
    );
    expect(aContentAfterB).toBe("v1");

    // 提交 A：通过审查并保留来源合并
    const submissionA = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: headCommitA,
      executedChecks: [
        { command: "node --test tests/a.test.mjs", exitCode: 0 },
      ],
    });
    if (submissionA.reviewDecision !== "accepted") {
      throw new Error(
        `提交 A 被拒绝: ${submissionA.rejectionReasons.join(" | ")}`,
      );
    }
    // 提交 B
    const submissionB = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-app",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: headCommitB,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(submissionB.reviewDecision).toBe("accepted");

    // 集成分支包含两个贡献（合并提交链）
    const integrationLog = await runGit(repositoryPath, [
      "log",
      "--format=%s",
      `${session.targetBaseCommit}..${session.integrationBranchName}`,
    ]);
    expect(integrationLog).toContain("A: 更新 docs/a.md");
    expect(integrationLog).toContain("B: 更新 packages/app.ts");

    // 门禁未授权：目标分支不动
    const targetBefore = await runGit(repositoryPath, ["rev-parse", "main"]);
    await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      integrationTestCommands: ["git status --porcelain"],
      isTargetBranchMergeAllowed: false,
    });
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).toBe(targetBefore);

    // 授权后合入目标分支
    await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      integrationTestCommands: ["git status --porcelain"],
      isTargetBranchMergeAllowed: true,
    });
    const targetAfter = await runGit(repositoryPath, ["rev-parse", "main"]);
    expect(targetAfter).not.toBe(targetBefore);
    expect(
      await fs.readFile(path.join(repositoryPath, "docs", "a.md"), "utf8"),
    ).toBe("v2-by-a");

    // 报告可追溯
    const report = await new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    }).readReport("mission-1", INTEGRATOR);
    expect(report?.reviewedContributions).toHaveLength(2);
    expect(
      report?.reviewedContributions.map((contribution) => contribution.taskId),
    ).toEqual(["task-docs", "task-app"]);
  });

  it("越界路径、伪造身份、敏感信息、缺失测试证据均被拒绝且不合并", async () => {
    const coordinator = makeCoordinator();
    const session = await coordinator.startIntegrationSession({
      missionId: "mission-1",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      targetBranchName: "main",
    });
    const allocation = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-docs",
        tertiaryAgentInstanceId: "agent-tertiary-a",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: session.targetBaseCommit,
        allowedPaths: ["docs"],
      },
      repositoryPath,
    );

    // 越界：修改 packages/app.ts（允许路径仅 docs）
    await fs.writeFile(
      path.join(allocation.worktreePath, "packages", "app.ts"),
      "越界修改",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "packages/app.ts"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "越界提交"]);
    const outOfBoundHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const outOfBoundSubmission = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: outOfBoundHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(outOfBoundSubmission.reviewDecision).toBe("rejected");
    expect(outOfBoundSubmission.rejectionReasons.join()).toContain("越过允许路径");

    // 伪造身份：先重置分支，再用非绑定身份提交
    await runGit(allocation.worktreePath, ["reset", "--hard", session.targetBaseCommit]);
    await fs.writeFile(
      path.join(allocation.worktreePath, "docs", "a.md"),
      "伪造身份",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "docs/a.md"]);
    await runGit(
      allocation.worktreePath,
      ["-c", "user.name=agent-tertiary-evil", "-c", "user.email=evil@x.local", "commit", "-m", "伪造"],
    );
    const forgedHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const forgedSubmission = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: forgedHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(forgedSubmission.reviewDecision).toBe("rejected");
    expect(forgedSubmission.rejectionReasons.join()).toContain("作者");

    // 敏感信息：含密钥文本提交
    await runGit(allocation.worktreePath, ["reset", "--hard", session.targetBaseCommit]);
    await fs.writeFile(
      path.join(allocation.worktreePath, "docs", "secret.txt"),
      "api_key=sk-abcdef0123456789abcdef",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "docs/secret.txt"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "含密钥"]);
    const secretHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const secretSubmission = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: secretHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(secretSubmission.reviewDecision).toBe("rejected");
    expect(secretSubmission.rejectionReasons.join()).toContain("敏感信息");

    // 删除文件提交（git show 读取失败路径）：越界检查仍生效
    await runGit(allocation.worktreePath, ["reset", "--hard", session.targetBaseCommit]);
    await runGit(allocation.worktreePath, ["rm", "docs/a.md"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "删除 docs/a.md"]);
    const deletedHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const deletedSubmission = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: deletedHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(deletedSubmission.reviewDecision).toBe("accepted");

    // 缺失测试证据：needs-rework（不合并）
    await runGit(allocation.worktreePath, ["reset", "--hard", session.targetBaseCommit]);
    await fs.writeFile(
      path.join(allocation.worktreePath, "docs", "a.md"),
      "干净修改",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "docs/a.md"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "干净修改"]);
    const cleanHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const noEvidenceSubmission = await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit: cleanHead,
      executedChecks: [],
    });
    expect(noEvidenceSubmission.reviewDecision).toBe("needs-rework");
    expect(noEvidenceSubmission.rejectionReasons.join()).toContain("测试证据");

    // 上述所有失败提交都未进入集成分支
    const integrationLog = await runGit(repositoryPath, [
      "log",
      "--format=%s",
      `${session.targetBaseCommit}..${session.integrationBranchName}`,
    ]);
    expect(integrationLog).not.toContain("越界提交");
    expect(integrationLog).not.toContain("伪造");
    expect(integrationLog).not.toContain("含密钥");
    expect(integrationLog).not.toContain("干净修改");
  });

  it("目标分支合入前自动创建恢复点（引用可回退）", async () => {
    const coordinator = makeCoordinator();
    const session = await coordinator.startIntegrationSession({
      missionId: "mission-1",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      targetBranchName: "main",
    });
    const allocation = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-docs",
        tertiaryAgentInstanceId: "agent-tertiary-a",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: session.targetBaseCommit,
        allowedPaths: ["docs"],
      },
      repositoryPath,
    );
    await fs.writeFile(
      path.join(allocation.worktreePath, "docs", "a.md"),
      "v2",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "docs/a.md"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "docs 更新"]);
    const headCommit = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-docs",
      repositoryPath,
      baseCommit: session.targetBaseCommit,
      headCommit,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    const recoveryPointService = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
    });
    const recoveryPointIds = (
      await recoveryPointService.listRecoveryPoints("mission-1")
    ).map((point) => point.recoveryPointId);
    expect(recoveryPointIds.length).toBeGreaterThanOrEqual(1);
    const targetBefore = await runGit(repositoryPath, ["rev-parse", "main"]);
    await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: INTEGRATOR,
      repositoryPath,
      integrationTestCommands: [],
      isTargetBranchMergeAllowed: true,
    });
    const targetAfter = await runGit(repositoryPath, ["rev-parse", "main"]);
    expect(targetAfter).not.toBe(targetBefore);
    // 通过最新恢复点（目标分支合并恢复点）回退目标分支
    const recoveryPoints = await recoveryPointService.listRecoveryPoints(
      "mission-1",
    );
    const targetMergeRecoveryPoint = recoveryPoints
      .filter((point) => point.operationDescription.includes("目标分支"))
      .sort((left, right) =>
        left.createdAtIso.localeCompare(right.createdAtIso),
      )
      .at(-1)!;
    await recoveryPointService.restoreRecoveryPoint({
      missionId: "mission-1",
      recoveryPointId: targetMergeRecoveryPoint.recoveryPointId,
      repositoryPath,
      worktreePath: null,
    });
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).toBe(targetBefore);
  });
  },
  60_000,
);
