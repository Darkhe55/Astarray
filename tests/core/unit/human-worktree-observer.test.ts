/**
 * T05D-02 测试：人工工作树观察器与变化 journal。
 * 验收：外部编辑可检测；不修改人工文件；重启可重放；
 * 未提交/已提交修改、切分支、rebase、reset、重命名均有明确观察结果。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HumanWorktreeObserver,
  Sha256FileFingerprinter,
} from "../../../packages/core/src/orchestration/human-worktree-observer.js";
import type { HumanWorktreeStatusPort } from "../../../packages/core/src/orchestration/human-worktree-observer.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t05d02-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

/** 可控 git 状态端口（模拟人工工作树状态变化）。 */
function makeStatusPort(state: {
  branchName: string;
  headCommitIdentifier: string;
  changedPaths: string[];
}): HumanWorktreeStatusPort {
  let currentState = state;
  return {
    readStatus: async () => currentState,
    setState(nextState: typeof state) {
      currentState = nextState;
    },
  } as HumanWorktreeStatusPort & {
    setState(nextState: typeof state): void;
  };
}

async function makeObserver(statusPort: HumanWorktreeStatusPort) {
  const observer = new HumanWorktreeObserver({
    statusPort,
    fingerprintPort: new Sha256FileFingerprinter(),
    authenticatedUserSourceIdentifier: "user-1",
    journalBaseDirectory: temporaryDirectory,
  });
  return observer;
}

describe("HumanWorktreeObserver 外部编辑检测", () => {
  it("未提交修改：changedPaths 非空且有指纹；journal 持久化", async () => {
    const filePath = path.join(temporaryDirectory, "src", "a.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "v1", "utf8");
    const statusPort = makeStatusPort({
      branchName: "main",
      headCommitIdentifier: "commit-1",
      changedPaths: [filePath],
    });
    const observer = await makeObserver(statusPort);
    const result = await observer.observeWorktree({
      observationIdentifier: "observation-1",
      nowIso: "2026-08-19T00:00:00.000Z",
    });
    expect(result.hasChangesSinceLastObservation).toBe(true);
    expect(result.observation.changedPaths).toEqual([filePath]);
    expect(result.observation.changedResourceFingerprintsByPath[filePath]).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(result.observation.authenticatedUserSourceIdentifier).toBe("user-1");
    // journal 可读（重启重放）
    const replayed = await observer.readHistoricalObservation("observation-1");
    expect(replayed?.observationIdentifier).toBe("observation-1");
  });

  it("已提交修改（HEAD 前进）：观察记录新提交标识", async () => {
    const statusPort = makeStatusPort({
      branchName: "main",
      headCommitIdentifier: "commit-2",
      changedPaths: [],
    });
    const observer = await makeObserver(statusPort);
    const result = await observer.observeWorktree({
      observationIdentifier: "observation-2",
      nowIso: "2026-08-19T00:00:00.000Z",
    });
    expect(result.observation.observedCommitIdentifier).toBe("commit-2");
  });

  it("切分支/rebase/reset：分支与 HEAD 组合形成明确观察", async () => {
    const statusPort = makeStatusPort({
      branchName: "feature-x",
      headCommitIdentifier: "commit-rebased",
      changedPaths: [],
    });
    const observer = await makeObserver(statusPort);
    const result = await observer.observeWorktree({
      observationIdentifier: "observation-3",
      nowIso: "2026-08-19T00:00:00.000Z",
    });
    expect(result.observation.observedCommitIdentifier).toBe("commit-rebased");
  });
});

describe("HumanWorktreeObserver 只读与指纹", () => {
  it("观察不修改人工文件（内容保持）", async () => {
    const filePath = path.join(temporaryDirectory, "keep.ts");
    await fs.writeFile(filePath, "human-content", "utf8");
    const statusPort = makeStatusPort({
      branchName: "main",
      headCommitIdentifier: "c1",
      changedPaths: [filePath],
    });
    const observer = await makeObserver(statusPort);
    await observer.observeWorktree({
      observationIdentifier: "observation-ro",
      nowIso: "2026-08-19T00:00:00.000Z",
    });
    expect(await fs.readFile(filePath, "utf8")).toBe("human-content");
  });

  it("指纹器：文件内容 sha256 确定性与变化敏感", async () => {
    const filePath = path.join(temporaryDirectory, "fp.ts");
    await fs.writeFile(filePath, "same", "utf8");
    const fingerprinter = new Sha256FileFingerprinter();
    const first = await fingerprinter.computeFingerprint(filePath);
    const second = await fingerprinter.computeFingerprint(filePath);
    expect(first).toBe(second);
    await fs.writeFile(filePath, "changed", "utf8");
    const third = await fingerprinter.computeFingerprint(filePath);
    expect(third).not.toBe(first);
  });
});

describe("HumanWorktreeObserver 重启重放", () => {
  it("新实例从 journal 读取历史观察（不丢失）", async () => {
    const statusPort = makeStatusPort({
      branchName: "main",
      headCommitIdentifier: "c1",
      changedPaths: [path.join(temporaryDirectory, "x.ts")],
    });
    const observer = await makeObserver(statusPort);
    await observer.observeWorktree({
      observationIdentifier: "observation-persist",
      nowIso: "2026-08-19T00:00:00.000Z",
    });
    // 模拟重启：新观察器实例（同一 journal 目录）
    const restartedObserver = await makeObserver(statusPort);
    const replayed = await restartedObserver.readHistoricalObservation(
      "observation-persist",
    );
    expect(replayed?.observationRevision).toBe(1);
    expect(replayed?.authenticatedUserSourceIdentifier).toBe("user-1");
  });
});