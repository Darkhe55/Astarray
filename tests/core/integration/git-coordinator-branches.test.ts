/**
 * T05B 分支覆盖：协调器/分配器/验证器/报告存储/恢复点的拒绝分支。
 * 真实 git 仓库。
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

async function runGit(
  workingDirectoryPath: string,
  gitArguments: string[],
): Promise<string> {
  const result = await gitProcess.run(workingDirectoryPath, gitArguments, "测试 git 命令");
  return result.stdoutText.trim();
}

function makeAllocator(): GitWorktreeAllocator {
  return new GitWorktreeAllocator({
    baseDirectory: stateBaseDirectory,
    gitProcess,
  });
}

function makeCoordinator(): GitIntegrationCoordinator {
  return new GitIntegrationCoordinator({
    worktreeAllocator: makeAllocator(),
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

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-git-branches-"),
  );
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(stateBaseDirectory);
  gitProcess = new GitProcess();
  repositoryPath = path.join(temporaryRootDirectory, "repo");
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "m@astarray.local"]);
  await fs.writeFile(path.join(repositoryPath, "a.txt"), "v1", "utf8");
  await runGit(repositoryPath, ["add", "a.txt"]);
  await runGit(repositoryPath, ["commit", "-m", "基线"]);
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true });
});

// vitest coverage 插桩会拖慢真实 git 流程，放宽文件级超时。
describe(
  "拒绝分支覆盖",
  () => {
  it("分配器：无效基线与重复 worker 分支拒绝", async () => {
    const allocator = makeAllocator();
    await expect(
      allocator.allocateWorker(
        {
          missionId: "mission-1",
          taskId: "task-1",
          tertiaryAgentInstanceId: "agent-a",
          integrationBranchName: "integration/mission-1/integrator",
          targetBaseCommit: "0000000000000000000000000000000000000000",
          allowedPaths: ["docs"],
        },
        repositoryPath,
      ),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    await allocator.allocateWorker(
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
    await expect(
      allocator.allocateWorker(
        {
          missionId: "mission-1",
          taskId: "task-1",
          tertiaryAgentInstanceId: "agent-a",
          integrationBranchName: "integration/mission-1/integrator",
          targetBaseCommit: baseCommit,
          allowedPaths: ["docs"],
        },
        repositoryPath,
      ),
    ).rejects.toThrowError(/已存在/);
  });

  it("协调器：目标分支无效/无分配记录/无会话拒绝", async () => {
    const coordinator = makeCoordinator();
    await expect(
      coordinator.startIntegrationSession({
        missionId: "mission-1",
        integratingAgentInstanceId: "integrator",
        repositoryPath,
        targetBranchName: "no-such-branch",
      }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
    await expect(
      coordinator.submitContribution({
        missionId: "mission-1",
        taskId: "never-allocated",
        repositoryPath,
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        executedChecks: [{ command: "npm test", exitCode: 0 }],
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
    await expect(
      coordinator.finalizeIntegration({
        missionId: "mission-1",
        integratingAgentInstanceId: "integrator",
        repositoryPath,
        integrationTestCommands: [],
        isTargetBranchMergeAllowed: false,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
  });

  it("验证器：headCommit 不存在 / 祖先关系不成立拒绝", async () => {
    const allocator = makeAllocator();
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
    const verifier = new GitContributionVerifier(gitProcess);
    // headCommit 不存在
    const missingHead = await verifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit: "f".repeat(40),
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(missingHead.reviewDecision).toBe("rejected");
    expect(missingHead.failureReasons.join()).toContain("headCommit");
    // 祖先关系不成立：head 是无关提交（孤儿分支上的提交）
    await runGit(repositoryPath, ["checkout", "--orphan", "orphan-branch"]);
    await fs.writeFile(path.join(repositoryPath, "orphan.txt"), "x", "utf8");
    await runGit(repositoryPath, ["add", "orphan.txt"]);
    await runGit(repositoryPath, ["commit", "-m", "孤儿提交"]);
    const orphanHead = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
    const notAncestor = await verifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit: orphanHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(notAncestor.failureReasons.join()).toContain("祖先");
  });

  it("报告存储：缺失报告返回 null；恢复点不存在报错", async () => {
    const reportStore = new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    });
    expect(
      await reportStore.readReport("mission-x", "agent-y"),
    ).toBeNull();
    const recoveryPointService = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
      gitProcess,
    });
    await expect(
      recoveryPointService.readRecoveryPoint("mission-x", "recovery-ghost"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
    expect(await recoveryPointService.listRecoveryPoints("mission-x")).toEqual([]);
  });

  it("集成测试失败时报告记录 unresolvedRisks 且不合并目标分支", async () => {
    const coordinator = makeCoordinator();
    await coordinator.startIntegrationSession({
      missionId: "mission-1",
      integratingAgentInstanceId: "integrator",
      repositoryPath,
      targetBranchName: "main",
    });
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    const session = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-1",
        tertiaryAgentInstanceId: "agent-a",
        integrationBranchName: "integration/mission-1/integrator",
        targetBaseCommit: baseCommit,
        allowedPaths: ["a.txt"],
      },
      repositoryPath,
    );
    await fs.writeFile(path.join(session.worktreePath, "a.txt"), "v2", "utf8");
    await runGit(session.worktreePath, ["add", "a.txt"]);
    await runGit(session.worktreePath, ["commit", "-m", "更新 a.txt"]);
    const headCommit = await runGit(session.worktreePath, ["rev-parse", "HEAD"]);
    await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-1",
      repositoryPath,
      baseCommit,
      headCommit,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    const targetBefore = await runGit(repositoryPath, ["rev-parse", "main"]);
    const report = await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: "integrator",
      repositoryPath,
      integrationTestCommands: ["exit 1"],
      isTargetBranchMergeAllowed: true,
    });
    expect(report.unresolvedRisks.length).toBeGreaterThan(0);
    expect(await runGit(repositoryPath, ["rev-parse", "main"])).toBe(targetBefore);
  });

  it("恢复点：不存在引用跳过、损坏文档报 journal-corrupted", async () => {
    const recoveryPointService = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
      gitProcess,
    });
    // 不存在的引用不阻断恢复点创建（跳过）
    const recoveryPoint = await recoveryPointService.createRecoveryPoint({
      missionId: "mission-1",
      repositoryPath,
      operationDescription: "含不存在引用的恢复点",
      affectedReferenceNames: ["refs/heads/no-such-ref", "refs/heads/main"],
      affectedWorktreePath: null,
      affectedWorkingTreeRoot: null,
    });
    expect(recoveryPoint.affectedReferenceNames).toEqual(["refs/heads/main"]);
    // 损坏文档：直接写入非法 JSON 后读取
    const recoveryDirectoryPath = path.join(
      stateBaseDirectory,
      "git-recovery",
      "mission-1",
      recoveryPoint.recoveryPointId,
    );
    await fs.writeFile(
      path.join(recoveryDirectoryPath, "recovery-point.json"),
      "{ 损坏",
      "utf8",
    );
    await expect(
      recoveryPointService.readRecoveryPoint(
        "mission-1",
        recoveryPoint.recoveryPointId,
      ),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    // schema 不合法（合法 JSON 但缺字段）→ 同样 journal-corrupted
    await fs.writeFile(
      path.join(recoveryDirectoryPath, "recovery-point.json"),
      JSON.stringify({ schemaVersion: 1 }),
      "utf8",
    );
    await expect(
      recoveryPointService.readRecoveryPoint(
        "mission-1",
        recoveryPoint.recoveryPointId,
      ),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("报告存储：损坏报告报 journal-corrupted；非法报告拒绝保存", async () => {
    const reportStore = new GitIntegrationReportStore({
      baseDirectory: stateBaseDirectory,
    });
    const reportDirectory = path.join(
      stateBaseDirectory,
      "git-integration",
      "mission-1",
      "reports",
    );
    await fs.mkdir(reportDirectory, { recursive: true });
    await fs.writeFile(
      path.join(reportDirectory, "integrator.json"),
      "not json",
      "utf8",
    );
    await expect(
      reportStore.readReport("mission-1", "integrator"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    // schema 校验失败：integrationCommit 非 40 位 hex
    await expect(
      reportStore.saveReport({
        missionId: "mission-1",
        integratingAgentInstanceId: "integrator",
        targetBranchName: "main",
        integrationBranchName: "integration/mission-1/integrator",
        targetBaseCommit: "a".repeat(40),
        reviewedContributions: [],
        integrationCommit: "not-a-commit",
        unresolvedRisks: [],
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("验证器：测试证据含失败项 → needs-rework；additional 敏感模式生效", async () => {
    const allocator = makeAllocator();
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    const allocation = await allocator.allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-1",
        tertiaryAgentInstanceId: "agent-a",
        integrationBranchName: "integration/mission-1/integrator",
        targetBaseCommit: baseCommit,
        allowedPaths: ["a.txt"],
      },
      repositoryPath,
    );
    await fs.writeFile(path.join(allocation.worktreePath, "a.txt"), "v2", "utf8");
    await runGit(allocation.worktreePath, ["add", "a.txt"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "更新"]);
    const headCommit = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    // 默认构造（默认 GitProcess）
    const defaultConstructedVerifier = new GitContributionVerifier();
    const defaultResult = await defaultConstructedVerifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(defaultResult.reviewDecision).toBe("accepted");
    // 空修改（head === base）→ changedPaths 为空分支
    const emptyDiffResult = await defaultConstructedVerifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit: baseCommit,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    expect(emptyDiffResult.changedPaths).toEqual([]);
    const verifier = new GitContributionVerifier(gitProcess);
    // 测试证据含失败项
    const failedCheck = await verifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit,
      executedChecks: [
        { command: "npm test", exitCode: 0 },
        { command: "npm run lint", exitCode: 2 },
      ],
    });
    expect(failedCheck.reviewDecision).toBe("needs-rework");
    expect(failedCheck.failureReasons.join()).toContain("失败项");
    // additional 敏感模式生效（模式本身通过内置集合）
    await fs.writeFile(
      path.join(allocation.worktreePath, "a.txt"),
      "CUSTOM_MARKER_abc12345",
      "utf8",
    );
    await runGit(allocation.worktreePath, ["add", "a.txt"]);
    await runGit(allocation.worktreePath, ["commit", "-m", "自定义标记"]);
    const markerHead = await runGit(allocation.worktreePath, ["rev-parse", "HEAD"]);
    const markerResult = await verifier.verifyContribution({
      allocation,
      repositoryPath,
      baseCommit,
      headCommit: markerHead,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
      additionalSensitivePatterns: [/CUSTOM_MARKER_[A-Za-z0-9]+/],
    });
    expect(markerResult.reviewDecision).toBe("rejected");
    expect(markerResult.failureReasons.join()).toContain("敏感信息");
  });

  it("协调器：冲突合并不得静默选边（tool-execution-failed）；无会话报告拒绝", async () => {
    const coordinator = makeCoordinator();
    const session = await coordinator.startIntegrationSession({
      missionId: "mission-1",
      integratingAgentInstanceId: "integrator",
      repositoryPath,
      targetBranchName: "main",
    });
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    // 两个 worker 都改 a.txt → 第二个合并必然冲突
    const allocationA = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-a",
        tertiaryAgentInstanceId: "agent-a",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: baseCommit,
        allowedPaths: ["a.txt"],
      },
      repositoryPath,
    );
    const allocationB = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-1",
        taskId: "task-b",
        tertiaryAgentInstanceId: "agent-b",
        integrationBranchName: session.integrationBranchName,
        targetBaseCommit: baseCommit,
        allowedPaths: ["a.txt"],
      },
      repositoryPath,
    );
    await fs.writeFile(path.join(allocationA.worktreePath, "a.txt"), "aaa", "utf8");
    await runGit(allocationA.worktreePath, ["add", "a.txt"]);
    await runGit(allocationA.worktreePath, ["commit", "-m", "A 改 a.txt"]);
    const headA = await runGit(allocationA.worktreePath, ["rev-parse", "HEAD"]);
    await coordinator.submitContribution({
      missionId: "mission-1",
      taskId: "task-a",
      repositoryPath,
      baseCommit,
      headCommit: headA,
      executedChecks: [{ command: "npm test", exitCode: 0 }],
    });
    await fs.writeFile(path.join(allocationB.worktreePath, "a.txt"), "bbb", "utf8");
    await runGit(allocationB.worktreePath, ["add", "a.txt"]);
    await runGit(allocationB.worktreePath, ["commit", "-m", "B 改 a.txt"]);
    const headB = await runGit(allocationB.worktreePath, ["rev-parse", "HEAD"]);
    await expect(
      coordinator.submitContribution({
        missionId: "mission-1",
        taskId: "task-b",
        repositoryPath,
        baseCommit,
        headCommit: headB,
        executedChecks: [{ command: "npm test", exitCode: 0 }],
      }),
    ).rejects.toMatchObject({ errorCode: "tool-execution-failed" });
    expect(
      (await runGit(repositoryPath, ["rev-parse", session.integrationBranchName]))
        .length,
    ).toBe(40);

    // 无会话报告：只分配未启动会话 → submitContribution 拒绝。
    // 提交越界路径（allowedPaths 仅 docs）→ 审查 rejected，不触碰仓库，
    // 随后无会话报告触发 task-sequence-not-found。
    const strayAllocation = await coordinator.worktreeAllocator().allocateWorker(
      {
        missionId: "mission-2",
        taskId: "task-stray",
        tertiaryAgentInstanceId: "agent-c",
        integrationBranchName: "integration/mission-2/never-started",
        targetBaseCommit: baseCommit,
        allowedPaths: ["docs"],
      },
      repositoryPath,
    );
    await fs.writeFile(path.join(strayAllocation.worktreePath, "a.txt"), "stray", "utf8");
    await runGit(strayAllocation.worktreePath, ["add", "a.txt"]);
    await runGit(strayAllocation.worktreePath, ["commit", "-m", "游离提交"]);
    const strayHead = await runGit(strayAllocation.worktreePath, ["rev-parse", "HEAD"]);
    await expect(
      coordinator.submitContribution({
        missionId: "mission-2",
        taskId: "task-stray",
        repositoryPath,
        baseCommit,
        headCommit: strayHead,
        executedChecks: [{ command: "npm test", exitCode: 0 }],
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
  });

  it("GitProcess：工作目录不存在报 spawn error；超时中止；isGitAvailable", async () => {
    const gitProcess = new GitProcess();
    expect(await GitProcess.isGitAvailable()).toBe(true);
    await expect(
      gitProcess.run(
        path.join(temporaryRootDirectory, "no-such-dir"),
        ["--version"],
        "测试不存在的 cwd",
      ),
    ).rejects.toThrow();
    // 超时分支：超时阈值极小时 git 启动未完成即被中止
    const slowProcess = new GitProcess({
      gitCommandTimeoutSeconds: 0.000_001,
    });
    await expect(
      slowProcess.run(repositoryPath, ["--version"], "测试超时"),
    ).rejects.toThrowError(/超时/);
  });

  it("分配器：worktree 目标路径被占用时失败并清理 worker 分支", async () => {
    const allocator = makeAllocator();
    const baseCommit = await runGit(repositoryPath, ["rev-parse", "main"]);
    // 预创建目标 worktree 目录（非空）→ worktree add 失败 → 分支清理
    const occupiedWorktreePath = path.join(
      stateBaseDirectory,
      "git-worktrees",
      "mission-1",
      "task-1",
      "agent-a",
    );
    await fs.mkdir(occupiedWorktreePath, { recursive: true });
    await fs.writeFile(path.join(occupiedWorktreePath, "occupied.txt"), "x", "utf8");
    await expect(
      allocator.allocateWorker(
        {
          missionId: "mission-1",
          taskId: "task-1",
          tertiaryAgentInstanceId: "agent-a",
          integrationBranchName: "integration/mission-1/integrator",
          targetBaseCommit: baseCommit,
          allowedPaths: ["docs"],
        },
        repositoryPath,
      ),
    ).rejects.toThrow();
    // 清理失败后 worker 分支不应残留
    const branchList = await runGit(repositoryPath, ["branch", "--list", "worker/*"]);
    expect(branchList).not.toContain("task-1");
  });
  },
  60_000,
);
