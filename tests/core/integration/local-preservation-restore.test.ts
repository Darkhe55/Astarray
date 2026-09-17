/**
 * GIT-PRESERVE-03：崩溃恢复与独立恢复演练（原仓库不可用仍可恢复；缺对象/并发改写/目标冲突不虚报）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalPreservationService,
  type RemoteSyncOutcome,
} from "../../../packages/core/src/orchestration/local-preservation-service.js";
import { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";

const NOW = "2026-09-16T00:00:00.000Z";
let stateDirectory: string;
let repositoryPath: string;
let restoreRootPath: string;

async function runGit(
  workingDirectory: string,
  arguments_: string[],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", arguments_, {
      cwd: workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdoutText);
      } else {
        reject(new Error("git " + arguments_.join(" ") + ": " + stderrText));
      }
    });
  });
}

function syncOutcome(): RemoteSyncOutcome {
  return {
    status: "failed-network",
    remoteName: "origin",
    branchName: "main",
    attemptCount: 1,
    lastFailureClass: "failed-network",
    observedAtIso: NOW,
    observedFailureMessage: "ssh: connection reset by peer",
  };
}

function createService(gitProcess?: GitProcess): LocalPreservationService {
  return new LocalPreservationService({
    baseDirectory: path.join(stateDirectory, "state"),
    nowIso: () => NOW,
    ...(gitProcess === undefined ? {} : { gitProcess }),
  });
}

async function createPreservationPoint(
  service: LocalPreservationService,
  missionId: string,
  currentRepositoryPath: string = repositoryPath,
) {
  const result = await service.preserveAfterRemoteSyncOutcome({
    missionId,
    repositoryPath: currentRepositoryPath,
    worktreePath: currentRepositoryPath,
    reason: "git push 网络失败",
    remoteSyncOutcome: syncOutcome(),
  });
  if (result.manifest === null) {
    throw new Error("保全点未创建");
  }
  return result.manifest;
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-restore-"));
  restoreRootPath = path.join(stateDirectory, "restore-targets");
  await fs.mkdir(restoreRootPath, { recursive: true });
  repositoryPath = path.join(stateDirectory, "repository");
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "test-maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
  await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\n", "utf8");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "基线提交"]);
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GIT-PRESERVE-03 独立恢复", () => {
  it("原仓库不可用仍可恢复已声明范围（index/未暂存/未跟踪/引用）", async () => {
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nstaged\n", "utf8");
    await runGit(repositoryPath, ["add", "tracked.txt"]);
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nstaged\nunstaged\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "notes.txt"), "notes-content\n", "utf8");
    const service = createService();
    const manifest = await createPreservationPoint(service, "mission-1");
    expect(manifest.localPreservation.status).toBe("ready");

    // 原仓库彻底不可用
    await fs.rm(repositoryPath, { recursive: true, force: true, maxRetries: 5 });
    await expect(fs.readdir(repositoryPath)).rejects.toMatchObject({ code: "ENOENT" });

    const restoreDirectoryPath = path.join(restoreRootPath, "restored-1");
    const restoreResult = await service.restorePreservationPoint({
      missionId: "mission-1",
      preservationPointId: manifest.preservationPointId,
      restoreDirectoryPath,
    });
    expect(restoreResult.isOriginalRepositoryRequired).toBe(false);
    expect(restoreResult.restoredUntrackedFilePaths).toEqual(["notes.txt"]);

    // 已提交内容 + 未暂存内容都在工作树
    expect(await fs.readFile(path.join(restoreDirectoryPath, "tracked.txt"), "utf8")).toBe(
      "line-1\nstaged\nunstaged\n",
    );
    // 已暂存（index）状态恢复：暂存区与 HEAD 的差异非空且与记录一致
    const stagedDiff = await runGit(restoreDirectoryPath, ["diff", "--cached", "--stat"]);
    expect(stagedDiff.trim()).not.toBe("");
    const restoredIndexTreeOid = (
      await runGit(restoreDirectoryPath, ["write-tree"])
    ).trim();
    expect(restoredIndexTreeOid).toBe(manifest.index.treeOid);
    // 未跟踪内容
    expect(await fs.readFile(path.join(restoreDirectoryPath, "notes.txt"), "utf8")).toBe(
      "notes-content\n",
    );

    // 恢复记录回写且不产生新保全点
    const restoredManifest = await service.readPreservationPoint(
      "mission-1",
      manifest.preservationPointId,
    );
    expect(restoredManifest.restoredAtIso).toBe(NOW);
    expect(await service.listPreservationPoints("mission-1")).toHaveLength(1);
  }, 120_000);

  it("无提交仓库恢复到新目录", async () => {
    const unbornRepositoryPath = path.join(stateDirectory, "unborn");
    await fs.mkdir(unbornRepositoryPath, { recursive: true });
    await runGit(unbornRepositoryPath, ["init", "-b", "main"]);
    await runGit(unbornRepositoryPath, ["config", "user.name", "test-maintainer"]);
    await runGit(unbornRepositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
    await fs.writeFile(path.join(unbornRepositoryPath, "staged.txt"), "staged\n", "utf8");
    await runGit(unbornRepositoryPath, ["add", "staged.txt"]);
    await fs.writeFile(path.join(unbornRepositoryPath, "brand-new.txt"), "new\n", "utf8");
    const service = createService();
    const manifest = await createPreservationPoint(service, "mission-2", unbornRepositoryPath);

    const restoreDirectoryPath = path.join(restoreRootPath, "restored-unborn");
    await service.restorePreservationPoint({
      missionId: "mission-2",
      preservationPointId: manifest.preservationPointId,
      restoreDirectoryPath,
    });
    expect(await fs.readFile(path.join(restoreDirectoryPath, "staged.txt"), "utf8")).toBe(
      "staged\n",
    );
    expect(await fs.readFile(path.join(restoreDirectoryPath, "brand-new.txt"), "utf8")).toBe(
      "new\n",
    );
    const stagedDiff = await runGit(restoreDirectoryPath, ["diff", "--cached", "--stat"]);
    expect(stagedDiff.trim()).not.toBe("");
  }, 120_000);

  it("恢复到非空目标被拒绝，不覆盖当前人工工作区", async () => {
    const service = createService();
    const manifest = await createPreservationPoint(service, "mission-3");
    const occupiedDirectoryPath = path.join(restoreRootPath, "occupied");
    await fs.mkdir(occupiedDirectoryPath, { recursive: true });
    await fs.writeFile(path.join(occupiedDirectoryPath, "user-file.txt"), "keep\n", "utf8");

    await expect(
      service.restorePreservationPoint({
        missionId: "mission-3",
        preservationPointId: manifest.preservationPointId,
        restoreDirectoryPath: occupiedDirectoryPath,
      }),
    ).rejects.toMatchObject({ errorCode: "restore-target-not-empty" });
    expect(await fs.readFile(path.join(occupiedDirectoryPath, "user-file.txt"), "utf8")).toBe(
      "keep\n",
    );
  }, 120_000);

  it("缺对象：完整性报告点名缺失，恢复直接失败，不虚报成功", async () => {
    const service = createService();
    const manifest = await createPreservationPoint(service, "mission-4");
    const bundlePath = manifest.objectArchive.filePath;
    expect(bundlePath).not.toBeNull();
    if (bundlePath === null) {
      return;
    }
    await fs.rm(bundlePath);

    const integrityReport = await service.verifyPreservationPointIntegrity({
      missionId: "mission-4",
      preservationPointId: manifest.preservationPointId,
    });
    expect(integrityReport.isIntact).toBe(false);
    expect(integrityReport.missingFilePaths).toContain(bundlePath);
    expect(integrityReport.failures.join(" ")).toContain("preservation-object-missing");

    await expect(
      service.restorePreservationPoint({
        missionId: "mission-4",
        preservationPointId: manifest.preservationPointId,
        restoreDirectoryPath: path.join(restoreRootPath, "restored-missing"),
      }),
    ).rejects.toMatchObject({ errorCode: "preservation-object-missing" });
  }, 120_000);

  it("快照期间工作树被并发改写：标注并发改写为不完整，不标 ready", async () => {
    const baseGitProcess = new GitProcess();
    const originalRun = baseGitProcess.run.bind(baseGitProcess);
    let statusCallCount = 0;
    const concurrentGitProcess = new GitProcess();
    concurrentGitProcess.run = async (workingDirectoryPath, arguments_, description) => {
      if (arguments_[0] === "status") {
        statusCallCount += 1;
        if (statusCallCount === 2) {
          await fs.writeFile(
            path.join(repositoryPath, "concurrent-change.txt"),
            "changed-during-snapshot\n",
            "utf8",
          );
        }
      }
      return await originalRun(workingDirectoryPath, arguments_, description);
    };
    const service = createService(concurrentGitProcess);
    const manifest = await createPreservationPoint(service, "mission-5");
    expect(manifest.localPreservation.status).toBe("incomplete");
    expect(
      manifest.localPreservation.integrityResult.failures.join(" "),
    ).toContain("concurrent-modification-detected");
  }, 120_000);

  it("临时残留快照被报告为不完整，且永不列入 ready", async () => {
    const service = createService();
    await createPreservationPoint(service, "mission-6");
    const missionDirectory = path.join(
      path.join(stateDirectory, "state", "local-preservation"),
      "mission-6",
    );
    const staleDirectoryPath = path.join(missionDirectory, ".tmp-crashed");
    await fs.mkdir(staleDirectoryPath, { recursive: true });
    await fs.writeFile(
      path.join(staleDirectoryPath, "preservation-manifest.json"),
      "{}",
      "utf8",
    );
    const incompleteSnapshots = await service.listIncompleteSnapshotDirectories("mission-6");
    expect(incompleteSnapshots.map((entry) => entry.directoryPath)).toContain(
      staleDirectoryPath,
    );
    expect(incompleteSnapshots[0]?.reason).toBe("incomplete-temp-snapshot");
    const readyPoints = await service.listPreservationPoints("mission-6");
    expect(readyPoints).toHaveLength(1);
    expect(readyPoints.every((entry) => entry.localPreservation.status !== "failed")).toBe(
      true,
    );
  }, 120_000);

  it("完整性报告：完好快照逐项校验通过", async () => {
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nchanged\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "untracked.txt"), "u\n", "utf8");
    const service = createService();
    const manifest = await createPreservationPoint(service, "mission-7");
    const integrityReport = await service.verifyPreservationPointIntegrity({
      missionId: "mission-7",
      preservationPointId: manifest.preservationPointId,
    });
    expect(integrityReport.isIntact).toBe(true);
    expect(integrityReport.missingFilePaths).toEqual([]);
    expect(integrityReport.mismatchedFilePaths).toEqual([]);
    expect(integrityReport.checkedItemCount).toBeGreaterThan(0);
  }, 120_000);
});
