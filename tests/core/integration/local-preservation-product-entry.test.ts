/**
 * GIT-PRESERVE-03：公共门面产品入口（同步结果接线、状态、完整性、独立恢复）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import {
  AstarrayApplicationFacade,
  PublicApplicationError,
} from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;
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
        reject(new Error("git " + arguments_.join(" ") + ": " + stderrText));
      }
    });
  });
}

async function createFacade(): Promise<AstarrayApplicationFacade> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory: baseDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  const facade = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory: baseDirectory,
  });
  facade.createSession({ sessionId: "session-1", mode: "assist" });
  return facade;
}

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-preserve-entry-"));
  repositoryPath = path.join(baseDirectory, "repository");
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "test-maintainer"]);
  await runGit(repositoryPath, ["config", "user.email", "maintainer@astarray.local"]);
  await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\n", "utf8");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "基线提交"]);
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("GIT-PRESERVE-03 公共入口", () => {
  it("网络失败联网接线 → 新进程可见状态 → 原仓库删除后仍可独立恢复", async () => {
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nchanged\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "notes.txt"), "notes\n", "utf8");
    const preservationPointId = await (async (): Promise<string> => {
      const first = await createFacade();
      try {
        const recordResult = await first.recordRemoteSyncOutcome({
          missionId: "mission-1",
          repositoryPath,
          reason: "git push 网络失败",
          syncStatus: "failed-network",
          remoteName: "origin",
          branchName: "main",
        });
        expect(recordResult.shouldPreserve).toBe(true);
        expect(recordResult.point?.status).toBe("ready");
        expect(recordResult.point?.hasUnstagedChanges).toBe(true);
        const pointIdentifier = recordResult.point?.preservationPointId ?? "";
        expect(pointIdentifier).not.toBe("");

        const integrityReport = await first.verifyLocalPreservationIntegrity({
          missionId: "mission-1",
          preservationPointId: pointIdentifier,
        });
        expect(integrityReport.isIntact).toBe(true);
        return pointIdentifier;
      } finally {
        await first.shutdown();
      }
    })();

    // 原仓库不可用
    await fs.rm(repositoryPath, { recursive: true, force: true, maxRetries: 5 });

    const second = await createFacade();
    try {
      const points = await second.listLocalPreservationPoints("mission-1");
      expect(points).toHaveLength(1);
      expect(points[0]?.preservationPointId).toBe(preservationPointId);

      const restoreDirectoryPath = path.join(baseDirectory, "restored-by-entry");
      const restoreResult = await second.restoreLocalPreservationPoint({
        missionId: "mission-1",
        preservationPointId,
        restoreDirectoryPath,
      });
      expect(restoreResult.isOriginalRepositoryRequired).toBe(false);
      expect(restoreResult.restoredUntrackedFilePaths).toEqual(["notes.txt"]);
      expect(
        await fs.readFile(path.join(restoreDirectoryPath, "tracked.txt"), "utf8"),
      ).toBe("line-1\nchanged\n");
      expect(
        await fs.readFile(path.join(restoreDirectoryPath, "notes.txt"), "utf8"),
      ).toBe("notes\n");

      const restoredPoint = await second.readLocalPreservationPoint({
        missionId: "mission-1",
        preservationPointId,
      });
      expect(restoredPoint.restoredAtIso).not.toBeNull();
    } finally {
      await second.shutdown();
    }
  }, 120_000);

  it("push 成功不保全；本地状态如实为 no-preservation 语义", async () => {
    const facade = await createFacade();
    try {
      const recordResult = await facade.recordRemoteSyncOutcome({
        missionId: "mission-2",
        repositoryPath,
        reason: "git push 成功",
        syncStatus: "succeeded",
      });
      expect(recordResult.shouldPreserve).toBe(false);
      expect(recordResult.point).toBeNull();
      expect(await facade.listLocalPreservationPoints("mission-2")).toEqual([]);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("仓库不可用：保全点状态 failed，公共入口拒绝恢复（不虚报成功）", async () => {
    const facade = await createFacade();
    try {
      const recordResult = await facade.recordRemoteSyncOutcome({
        missionId: "mission-3",
        repositoryPath: path.join(baseDirectory, "not-a-repository"),
        reason: "git push 网络失败",
        syncStatus: "failed-network",
      });
      expect(recordResult.point?.status).toBe("failed");
      expect(recordResult.point?.integrityFailures.join(" ")).toContain(
        "repository-unavailable",
      );

      await expect(
        facade.restoreLocalPreservationPoint({
          missionId: "mission-3",
          preservationPointId: recordResult.point?.preservationPointId ?? "",
          restoreDirectoryPath: path.join(baseDirectory, "restore-failed"),
        }),
      ).rejects.toMatchObject({
        errorCode: "preservation-point-not-restorable",
      });

      await expect(
        facade.readLocalPreservationPoint({
          missionId: "mission-3",
          preservationPointId: "preservation-missing",
        }),
      ).rejects.toBeInstanceOf(PublicApplicationError);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("恢复到非空目录被公共入口拒绝，不覆盖用户文件", async () => {
    await fs.writeFile(path.join(repositoryPath, "untracked.txt"), "u\n", "utf8");
    const facade = await createFacade();
    try {
      const recordResult = await facade.recordRemoteSyncOutcome({
        missionId: "mission-4",
        repositoryPath,
        reason: "git push 网络失败",
        syncStatus: "failed-network",
      });
      const occupiedDirectoryPath = path.join(baseDirectory, "occupied");
      await fs.mkdir(occupiedDirectoryPath, { recursive: true });
      await fs.writeFile(path.join(occupiedDirectoryPath, "keep.txt"), "keep\n", "utf8");

      await expect(
        facade.restoreLocalPreservationPoint({
          missionId: "mission-4",
          preservationPointId: recordResult.point?.preservationPointId ?? "",
          restoreDirectoryPath: occupiedDirectoryPath,
        }),
      ).rejects.toMatchObject({ errorCode: "restore-target-not-empty" });
      expect(
        await fs.readFile(path.join(occupiedDirectoryPath, "keep.txt"), "utf8"),
      ).toBe("keep\n");
    } finally {
      await facade.shutdown();
    }
  }, 90_000);
});
