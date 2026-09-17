/**
 * GIT-PRESERVE-02：远端同步失败后的本地保全（对象归档、index/工作树/未跟踪快照、原子清单）。
 * 行为反例优先：触发分类、诚实失败、无提交仓库、复用与完整性。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_PRESERVATION_DEFAULT_EXCLUDED_PATTERNS,
  LOCAL_PRESERVATION_SCHEMA_VERSION,
  LocalPreservationService,
  evaluateRemoteSyncPreservationTrigger,
  type RemoteSyncOutcome,
} from "../../../packages/core/src/orchestration/local-preservation-service.js";

const NOW = "2026-09-16T00:00:00.000Z";
let stateDirectory: string;
let repositoryPath: string;

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
        reject(
          new Error(
            "git " + arguments_.join(" ") + " 失败(" + String(exitCode) + "): " + stderrText,
          ),
        );
      }
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function syncOutcome(
  overrides: Partial<RemoteSyncOutcome> = {},
): RemoteSyncOutcome {
  return {
    status: "failed-network",
    remoteName: "origin",
    branchName: "main",
    attemptCount: 1,
    lastFailureClass: "failed-network",
    observedAtIso: NOW,
    observedFailureMessage: "ssh: connection reset by peer",
    ...overrides,
  };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-preserve-"));
  repositoryPath = path.join(stateDirectory, "repository");
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "test-maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
  await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\n", "utf8");
  await fs.mkdir(path.join(repositoryPath, "docs"), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, "docs", "a.md"), "doc-a\n", "utf8");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "基线提交"]);
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function createService(): LocalPreservationService {
  return new LocalPreservationService({
    baseDirectory: path.join(stateDirectory, "state"),
    nowIso: () => NOW,
  });
}

describe("GIT-PRESERVE-02 触发分类", () => {
  it("网络失败与缺远端触发保全；成功/未尝试/进行中不触发", () => {
    for (const status of ["failed-network", "failed-no-remote", "failed-authentication", "failed-rejected", "failed-unknown"] as const) {
      const decision = evaluateRemoteSyncPreservationTrigger(syncOutcome({ status }));
      expect(decision.shouldPreserve).toBe(true);
      expect(decision.classification).toBe(status);
    }
    for (const status of ["succeeded", "not-attempted", "attempting"] as const) {
      const decision = evaluateRemoteSyncPreservationTrigger(syncOutcome({ status }));
      expect(decision.shouldPreserve).toBe(false);
    }
  }, 60_000);

  it("push 成功时不创建保全点（不产生空目录）", async () => {
    const service = createService();
    const result = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-1",
      repositoryPath,
      worktreePath: repositoryPath,
      reason: "git push 成功",
      remoteSyncOutcome: syncOutcome({ status: "succeeded", lastFailureClass: null }),
    });
    expect(result.shouldPreserve).toBe(false);
    expect(result.manifest).toBeNull();
    await expect(
      fs.readdir(path.join(stateDirectory, "state", "local-preservation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});

describe("GIT-PRESERVE-02 清单、范围与完整性", () => {
  it("普通仓库：引用归档 + index/未暂存/未跟踪快照 + 原子清单全部就绪", async () => {
    // 构造：已暂存 + 未暂存 + 未跟踪（含二进制）+ 删除 + 重命名
    await fs.writeFile(path.join(repositoryPath, "docs", "c.md"), "doc-c\n", "utf8");
    await runGit(repositoryPath, ["add", "docs/c.md"]);
    await runGit(repositoryPath, ["commit", "-m", "新增 c"]);
    await runGit(repositoryPath, ["mv", "docs/a.md", "docs/b.md"]);
    await runGit(repositoryPath, ["rm", "docs/c.md"]);
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nline-2\n", "utf8");
    await runGit(repositoryPath, ["add", "tracked.txt"]);
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nline-2\nline-3\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "binary.bin"), Buffer.from([0, 1, 2, 255, 0]));
    await fs.writeFile(path.join(repositoryPath, "notes.txt"), "untracked-notes\n", "utf8");

    const service = createService();
    const result = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-1",
      repositoryPath,
      worktreePath: repositoryPath,
      reason: "git push 网络失败",
      remoteSyncOutcome: syncOutcome(),
    });
    const manifest = result.manifest;
    expect(result.shouldPreserve).toBe(true);
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.schemaVersion).toBe(LOCAL_PRESERVATION_SCHEMA_VERSION);
    expect(manifest.localPreservation.status).toBe("ready");
    expect(manifest.localPreservation.integrityResult.isComplete).toBe(true);
    expect(manifest.remoteSync.status).toBe("failed-network");
    expect(manifest.localPreservation.status).not.toBe(manifest.remoteSync.status);

    // 对象归档独立于仓库内引用，且可被 git bundle 校验
    expect(manifest.objectArchive.filePath).not.toBeNull();
    expect(manifest.objectArchive.referenceNames.length).toBeGreaterThan(0);
    expect(manifest.objectArchive.sha256).not.toBeNull();
    const archivePath = path.join(
      path.join(stateDirectory, "state", "local-preservation"),
      manifest.missionId,
      manifest.preservationPointId,
      "objects.bundle",
    );
    expect(await sha256File(archivePath)).toBe(manifest.objectArchive.sha256);
    await runGit(repositoryPath, ["bundle", "verify", archivePath]);

    // index 与未暂存分开记录
    expect(manifest.index.treeOid).not.toBeNull();
    expect(manifest.index.cachedPatchPath).not.toBeNull();
    expect(manifest.worktreeChanges.unstagedPatchPath).not.toBeNull();
    expect(manifest.index.cachedPatchSha256).not.toBe(manifest.worktreeChanges.unstagedPatchSha256);

    // 未跟踪（含二进制）有大小与哈希
    const untrackedPaths = manifest.untrackedFiles.map((entry) => entry.relativePath).sort();
    expect(untrackedPaths).toContain("notes.txt");
    expect(untrackedPaths).toContain("binary.bin");
    const binaryEntry = manifest.untrackedFiles.find(
      (entry) => entry.relativePath === "binary.bin",
    );
    expect(binaryEntry?.sha256).toBe(
      await sha256File(path.join(repositoryPath, "binary.bin")),
    );
    expect(binaryEntry?.byteCount).toBe(5);

    // 删除/重命名显式记录
    const changeKinds = manifest.changeEntries.map((entry) => entry.changeKind);
    expect(changeKinds).toContain("renamed");
    expect(changeKinds).toContain("deleted");

    // 清单哈希：独立 manifest.sha256 文件与清单字段一致，且读取时校验通过
    const preservationPointDirectory = path.join(
      path.join(stateDirectory, "state", "local-preservation"),
      manifest.missionId,
      manifest.preservationPointId,
    );
    const storedManifestSha256 = await fs.readFile(
      path.join(preservationPointDirectory, "manifest.sha256"),
      "utf8",
    );
    expect(storedManifestSha256.trim()).toBe(manifest.snapshot.manifestSha256);
    expect(manifest.snapshot.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await service.readPreservationPoint(
        manifest.missionId,
        manifest.preservationPointId,
      ),
    ).toMatchObject({ preservationPointId: manifest.preservationPointId });

    // 没有临时残留目录（原子发布）
    const pointEntries = await fs.readdir(
      path.join(
        path.join(stateDirectory, "state", "local-preservation"),
        manifest.missionId,
      ),
    );
    expect(pointEntries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  }, 90_000);

  it("默认排除依赖缓存与构建产物，但显式记录被排除的未跟踪文件（不静默丢弃）", async () => {
    await fs.mkdir(path.join(repositoryPath, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(repositoryPath, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
      "utf8",
    );
    await fs.writeFile(path.join(repositoryPath, "keep.txt"), "keep\n", "utf8");

    const service = createService();
    const manifest = (
      await service.preserveAfterRemoteSyncOutcome({
        missionId: "mission-1",
        repositoryPath,
        worktreePath: repositoryPath,
        reason: "git push 网络失败",
        remoteSyncOutcome: syncOutcome(),
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.untrackedFiles.map((entry) => entry.relativePath)).toEqual([
      "keep.txt",
    ]);
    expect(manifest.excludedUntrackedFilePaths).toContain(
      "node_modules/pkg/index.js",
    );
    expect(manifest.excludedPatterns).toEqual(
      expect.arrayContaining([...LOCAL_PRESERVATION_DEFAULT_EXCLUDED_PATTERNS]),
    );
  }, 90_000);

  it("尚无提交的仓库：不使用 HEAD diff，index 与工作树仍被记录", async () => {
    const unbornRepositoryPath = path.join(stateDirectory, "unborn");
    await fs.mkdir(unbornRepositoryPath, { recursive: true });
    await runGit(unbornRepositoryPath, ["init", "-b", "main"]);
    await runGit(unbornRepositoryPath, ["config", "user.name", "test-maintainer"]);
    await runGit(unbornRepositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
    await fs.writeFile(path.join(unbornRepositoryPath, "staged.txt"), "staged\n", "utf8");
    await runGit(unbornRepositoryPath, ["add", "staged.txt"]);
    await fs.writeFile(path.join(unbornRepositoryPath, "staged.txt"), "staged+unstaged\n", "utf8");
    await fs.writeFile(path.join(unbornRepositoryPath, "brand-new.txt"), "new\n", "utf8");

    const service = createService();
    const manifest = (
      await service.preserveAfterRemoteSyncOutcome({
        missionId: "mission-2",
        repositoryPath: unbornRepositoryPath,
        worktreePath: unbornRepositoryPath,
        reason: "无远端且仓库尚无提交",
        remoteSyncOutcome: syncOutcome({ status: "failed-no-remote", remoteName: null, lastFailureClass: "failed-no-remote" }),
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.repository.hasUnbornHead).toBe(true);
    expect(manifest.repository.baseCommit).toBeNull();
    expect(manifest.localPreservation.status).toBe("ready");
    expect(manifest.index.treeOid).not.toBeNull();
    expect(manifest.untrackedFiles.map((entry) => entry.relativePath)).toContain(
      "brand-new.txt",
    );
    // 已暂存与未暂存内容都被记录（不是静默为空）
    expect(manifest.index.cachedPatchSha256).not.toBeNull();
    expect(manifest.worktreeChanges.unstagedPatchSha256).not.toBeNull();
    expect(manifest.objectArchive.note).toBe("no-refs-to-archive");
  }, 90_000);

  it("LFS 声明与子模块 gitlink 标注为不完整，绝不宣称完整可恢复", async () => {
    await fs.writeFile(
      path.join(repositoryPath, ".gitattributes"),
      "*.psd filter=lfs diff=lfs merge=lfs -text\n",
      "utf8",
    );
    await runGit(repositoryPath, [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,vendor/sub",
    ]);
    const service = createService();
    const manifest = (
      await service.preserveAfterRemoteSyncOutcome({
        missionId: "mission-3",
        repositoryPath,
        worktreePath: repositoryPath,
        reason: "git push 网络失败",
        remoteSyncOutcome: syncOutcome(),
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.localPreservation.status).toBe("incomplete");
    expect(manifest.localPreservation.integrityResult.isComplete).toBe(false);
    expect(manifest.repository.lfsPointerFilePaths).toContain(".gitattributes");
    expect(manifest.repository.submodulePaths).toContain("vendor/sub");
    expect(
      manifest.localPreservation.integrityResult.failures.join(" "),
    ).toMatch(/lfs-objects-not-included|submodule-content-not-included/);
  }, 90_000);

  it("仓库不可用：记录失败原因，不伪造成功、不留 ready 快照", async () => {
    const service = createService();
    const manifest = (
      await service.preserveAfterRemoteSyncOutcome({
        missionId: "mission-4",
        repositoryPath: path.join(stateDirectory, "not-a-repository"),
        worktreePath: path.join(stateDirectory, "not-a-repository"),
        reason: "git push 网络失败",
        remoteSyncOutcome: syncOutcome(),
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.localPreservation.status).toBe("failed");
    expect(manifest.localPreservation.failureReason).toBeTruthy();
    expect(manifest.localPreservation.integrityResult.isComplete).toBe(false);
  }, 90_000);

  it("同一提交与工作树指纹复用已验证快照，不重复全量复制", async () => {
    await fs.writeFile(path.join(repositoryPath, "untracked-1.txt"), "value-1\n", "utf8");
    const service = createService();
    const first = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-5",
      repositoryPath,
      worktreePath: repositoryPath,
      reason: "git push 网络失败",
      remoteSyncOutcome: syncOutcome(),
    });
    expect(first.isReused).toBe(false);

    const second = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-5",
      repositoryPath,
      worktreePath: repositoryPath,
      reason: "git push 网络失败（重试）",
      remoteSyncOutcome: syncOutcome({ attemptCount: 2 }),
    });
    expect(second.isReused).toBe(true);
    expect(second.manifest?.preservationPointId).toBe(
      first.manifest?.preservationPointId,
    );
    const missionDirectory = path.join(
      path.join(stateDirectory, "state", "local-preservation"),
      "mission-5",
    );
    expect(await fs.readdir(missionDirectory)).toHaveLength(1);

    // 工作树变化后不再复用
    await fs.writeFile(path.join(repositoryPath, "untracked-1.txt"), "value-2\n", "utf8");
    const third = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-5",
      repositoryPath,
      worktreePath: repositoryPath,
      reason: "git push 网络失败（内容已变）",
      remoteSyncOutcome: syncOutcome({ attemptCount: 3 }),
    });
    expect(third.isReused).toBe(false);
    expect(third.manifest?.preservationPointId).not.toBe(
      first.manifest?.preservationPointId,
    );
    expect(await fs.readdir(missionDirectory)).toHaveLength(2);
  }, 90_000);
  it("稀疏检出与自定义排除模式：标注不完整并记录排除原因", async () => {
    await runGit(repositoryPath, ["config", "core.sparseCheckout", "true"]);
    await fs.mkdir(path.join(repositoryPath, ".git", "info"), { recursive: true });
    await fs.writeFile(
      path.join(repositoryPath, ".git", "info", "sparse-checkout"),
      "docs/\n",
      "utf8",
    );
    await fs.writeFile(path.join(repositoryPath, "debug.log"), "log\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "exact-name"), "exact\n", "utf8");
    const manifest = (
      await createService().preserveAfterRemoteSyncOutcome({
        missionId: "mission-sparse",
        repositoryPath,
        worktreePath: repositoryPath,
        reason: "git push 网络失败",
        remoteSyncOutcome: syncOutcome(),
        excludedPatterns: ["*.log", "exact-name"],
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.repository.sparseCheckoutPatterns).toEqual(["docs/"]);
    expect(manifest.localPreservation.status).toBe("incomplete");
    expect(
      manifest.localPreservation.integrityResult.failures.join(" "),
    ).toContain("sparse-checkout-content-not-included");
    expect(manifest.excludedUntrackedFilePaths).toEqual(
      expect.arrayContaining(["debug.log", "exact-name"]),
    );
    expect(manifest.untrackedFiles).toEqual([]);
  }, 90_000);

  it("新增（added）变更、缺失/篡改清单与临时残留处理诚实", async () => {
    await fs.writeFile(path.join(repositoryPath, "new-file.txt"), "new\n", "utf8");
    await runGit(repositoryPath, ["add", "new-file.txt"]);
    const service = createService();
    const manifest = (
      await service.preserveAfterRemoteSyncOutcome({
        missionId: "mission 6",
        repositoryPath,
        worktreePath: repositoryPath,
        reason: "git push 网络失败",
        remoteSyncOutcome: syncOutcome(),
      })
    ).manifest;
    expect(manifest).not.toBeNull();
    if (manifest === null) {
      return;
    }
    expect(manifest.changeEntries.map((entry) => entry.changeKind)).toContain(
      "added",
    );

    // 缺失保全点
    await expect(
      service.readPreservationPoint("mission 6", "preservation-missing"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });

    // 临时残留被 list 忽略；正常保全点仍可见
    const preservationPointDirectory = manifest.snapshot.directoryPath;
    const missionDirectory = path.dirname(preservationPointDirectory);
    await fs.mkdir(path.join(missionDirectory, ".tmp-stale"), { recursive: true });
    await fs.writeFile(
      path.join(missionDirectory, ".tmp-stale", "preservation-manifest.json"),
      "{}",
      "utf8",
    );
    expect(await service.listPreservationPoints("mission 6")).toHaveLength(1);

    // 非 JSON 与非哈希一致的清单都判损坏，不假装可恢复
    const manifestPath = path.join(
      preservationPointDirectory,
      "preservation-manifest.json",
    );
    await fs.writeFile(manifestPath, "not-json", "utf8");
    await expect(
      service.readPreservationPoint("mission 6", manifest.preservationPointId),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });

    const tamperedManifest = { ...manifest, createdAtIso: "2000-01-01T00:00:00.000Z" };
    await fs.writeFile(
      manifestPath,
      JSON.stringify(tamperedManifest, null, 2) + "\n",
      "utf8",
    );
    await expect(
      service.readPreservationPoint("mission 6", manifest.preservationPointId),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  }, 90_000);
});
