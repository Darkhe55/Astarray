/**
 * GIT-PRESERVE-03：本地保全 CLI（create/status/show/restore）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executePreserveCreateCommand,
  executePreserveRestoreCommand,
  executePreserveShowCommand,
  executePreserveStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

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
    let stderrText = "";
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve("");
      } else {
        reject(new Error("git " + arguments_.join(" ") + ": " + stderrText));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
  });
}

function captureStdout(): { getOutput: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    },
  );
  return { getOutput: () => chunks.join("") };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-preserve-cli-"));
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
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GIT-PRESERVE-03 本地保全 CLI", () => {
  it("create（网络失败）→ status 可见 → show 完整性 → restore 到新目录", async () => {
    await fs.writeFile(path.join(repositoryPath, "tracked.txt"), "line-1\nchanged\n", "utf8");
    await fs.writeFile(path.join(repositoryPath, "notes.txt"), "notes\n", "utf8");

    const createCapture = captureStdout();
    const createExit = await executePreserveCreateCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      repositoryPath,
      syncStatus: "failed-network",
      isJsonOutput: true,
    });
    expect(createExit).toBe(0);
    const created = JSON.parse(createCapture.getOutput()) as {
      status: string;
      shouldPreserve: boolean;
      point: { preservationPointId: string; status: string };
    };
    expect(created.status).toBe("ok");
    expect(created.shouldPreserve).toBe(true);
    expect(created.point.status).toBe("ready");

    const statusCapture = captureStdout();
    const statusExit = await executePreserveStatusCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      isJsonOutput: true,
    });
    expect(statusExit).toBe(0);
    expect(JSON.parse(statusCapture.getOutput())).toMatchObject({
      status: "ok",
      points: [{ preservationPointId: created.point.preservationPointId }],
    });

    const showCapture = captureStdout();
    const showExit = await executePreserveShowCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      preservationPointId: created.point.preservationPointId,
      isJsonOutput: true,
    });
    expect(showExit).toBe(0);
    expect(JSON.parse(showCapture.getOutput())).toMatchObject({
      status: "ok",
      integrityReport: { isIntact: true },
    });

    const restoreDirectoryPath = path.join(stateDirectory, "restored-cli");
    const restoreCapture = captureStdout();
    const restoreExit = await executePreserveRestoreCommand({
      stateDirectory,
      missionIdentifier: "mission-1",
      preservationPointId: created.point.preservationPointId,
      restoreDirectoryPath,
      isJsonOutput: true,
    });
    expect(restoreExit).toBe(0);
    expect(JSON.parse(restoreCapture.getOutput())).toMatchObject({
      status: "ok",
      restoreResult: {
        restoreDirectoryPath,
        restoredUntrackedFilePaths: ["notes.txt"],
      },
    });
    expect(
      await fs.readFile(path.join(restoreDirectoryPath, "tracked.txt"), "utf8"),
    ).toBe("line-1\nchanged\n");
    expect(
      await fs.readFile(path.join(restoreDirectoryPath, "notes.txt"), "utf8"),
    ).toBe("notes\n");
  }, 120_000);

  it("无保全点诚实输出 no-preservation；push 成功不保全", async () => {
    const emptyCapture = captureStdout();
    await executePreserveStatusCommand({
      stateDirectory,
      missionIdentifier: "mission-empty",
      isJsonOutput: true,
    });
    expect(JSON.parse(emptyCapture.getOutput())).toMatchObject({
      status: "no-preservation",
      points: [],
    });

    const successCapture = captureStdout();
    const successExit = await executePreserveCreateCommand({
      stateDirectory,
      missionIdentifier: "mission-2",
      repositoryPath,
      syncStatus: "succeeded",
      isJsonOutput: true,
    });
    expect(successExit).toBe(0);
    expect(JSON.parse(successCapture.getOutput())).toMatchObject({
      status: "not-preserved",
      shouldPreserve: false,
      point: null,
    });
  }, 90_000);

  it("非法同步状态返回用法错误（2），不创建保全点", async () => {
    captureStdout();
    const exitCode = await executePreserveCreateCommand({
      stateDirectory,
      missionIdentifier: "mission-3",
      repositoryPath,
      syncStatus: "maybe-failed",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);

    const statusCapture = captureStdout();
    await executePreserveStatusCommand({
      stateDirectory,
      missionIdentifier: "mission-3",
      isJsonOutput: true,
    });
    expect(JSON.parse(statusCapture.getOutput())).toMatchObject({
      status: "no-preservation",
    });
  }, 90_000);
});
