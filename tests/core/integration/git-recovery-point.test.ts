/**
 * T05B 集成测试：Git 破坏性操作自动恢复点（ADR-0012 §权限与恢复）。
 * 真实 git 仓库：创建恢复点 → 破坏引用/工作树 → 受控恢复 → 内容还原；
 * 重复恢复拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";
import { GitRecoveryPointService } from "../../../packages/core/src/orchestration/git-recovery-point-service.js";

let temporaryRootDirectory: string;
let repositoryPath: string;
let stateBaseDirectory: string;

async function runGit(
  workingDirectoryPath: string,
  gitArguments: string[],
): Promise<string> {
  const gitProcess = new GitProcess();
  const result = await gitProcess.run(workingDirectoryPath, gitArguments, "测试 git 命令");
  return result.stdoutText.trim();
}

beforeEach(async () => {
  temporaryRootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-git-recovery-"),
  );
  repositoryPath = path.join(temporaryRootDirectory, "repo");
  stateBaseDirectory = path.join(temporaryRootDirectory, "state");
  await fs.mkdir(repositoryPath);
  await fs.mkdir(stateBaseDirectory);
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "test-maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
  await fs.mkdir(path.join(repositoryPath, "docs"), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "v1", "utf8");
  await runGit(repositoryPath, ["add", "docs/a.md"]);
  await runGit(repositoryPath, ["commit", "-m", "基线提交"]);
});

afterEach(async () => {
  await fs.rm(temporaryRootDirectory, { recursive: true, force: true });
});

// vitest coverage 插桩会拖慢真实 git 流程，放宽文件级超时。
describe(
  "GitRecoveryPointService",
  () => {
  it("破坏引用后恢复点还原分支引用与工作树未提交内容", async () => {
    const service = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
    });
    // 工作树未提交改动
    await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "未提交改动", "utf8");
    const originalTip = await runGit(repositoryPath, ["rev-parse", "main"]);
    const recoveryPoint = await service.createRecoveryPoint({
      missionId: "mission-1",
      repositoryPath,
      operationDescription: "测试：reset --hard 前的恢复点",
      affectedReferenceNames: ["refs/heads/main"],
      affectedWorktreePath: repositoryPath,
      affectedWorkingTreeRoot: repositoryPath,
    });
    expect(recoveryPoint.affectedReferenceNames).toContain("refs/heads/main");
    expect(recoveryPoint.hasWorktreePreimage).toBe(true);

    // 破坏：reset --hard 丢弃未提交改动
    await runGit(repositoryPath, ["reset", "--hard", "HEAD"]);
    await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "被破坏", "utf8");
    const listAfterBreak = await service.listRecoveryPoints("mission-1");
    expect(listAfterBreak.map((point) => point.recoveryPointId)).toContain(
      recoveryPoint.recoveryPointId,
    );

    // 恢复：引用还原 + 未提交内容还原
    const restored = await service.restoreRecoveryPoint({
      missionId: "mission-1",
      recoveryPointId: recoveryPoint.recoveryPointId,
      repositoryPath,
      worktreePath: repositoryPath,
    });
    expect(restored.restoredAtIso).not.toBeNull();
    const restoredTip = await runGit(repositoryPath, ["rev-parse", "main"]);
    expect(restoredTip).toBe(originalTip);
    const restoredContent = await fs.readFile(
      path.join(repositoryPath, "docs", "a.md"),
      "utf8",
    );
    expect(restoredContent).toBe("未提交改动");
  });

  it("重复恢复同一恢复点被拒绝", async () => {
    const service = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
    });
    const recoveryPoint = await service.createRecoveryPoint({
      missionId: "mission-1",
      repositoryPath,
      operationDescription: "测试恢复点",
      affectedReferenceNames: ["refs/heads/main"],
      affectedWorktreePath: null,
      affectedWorkingTreeRoot: null,
    });
    await service.restoreRecoveryPoint({
      missionId: "mission-1",
      recoveryPointId: recoveryPoint.recoveryPointId,
      repositoryPath,
      worktreePath: null,
    });
    await expect(
      service.restoreRecoveryPoint({
        missionId: "mission-1",
        recoveryPointId: recoveryPoint.recoveryPointId,
        repositoryPath,
        worktreePath: null,
      }),
    ).rejects.toThrowError(/已被恢复过/);
  });

  it("恢复点引用使用受保护前缀，模型工具不可删除", async () => {
    const service = new GitRecoveryPointService({
      baseDirectory: stateBaseDirectory,
    });
    await service.createRecoveryPoint({
      missionId: "mission-1",
      repositoryPath,
      operationDescription: "测试恢复引用前缀",
      affectedReferenceNames: ["refs/heads/main"],
      affectedWorktreePath: null,
      affectedWorkingTreeRoot: null,
    });
    const recoveryRefs = await runGit(repositoryPath, [
      "for-each-ref",
      "--format=%(refname)",
      GitRecoveryPointService.getRecoveryReferencePrefix(),
    ]);
    expect(recoveryRefs).toContain("refs/astarray-recovery/");
  });
  },
  60_000,
);
