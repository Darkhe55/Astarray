/**
 * G1 Step 2 验收（2026-11-08 第 246 轮）：**门面真的能创建集成分支**。
 *
 * ## 背景
 *
 * G1 的判定（`AGENTS.md`）：涉及 Git 写入的多 Agent 任务必须由次级 Agent 负责分支/工作树分流、
 * 差异审查、测试验证和**受控合并**。勘测结论是 **G1 整层不可达**（门面没有入口）。
 *
 * 第 245 轮已接线门面侧：`gitIntegration?` 选项 + `startIntegrationSession` 入口
 * （构造 分配器/验证器/报告存储/恢复点服务/协调器）。
 *
 * ## 本文件的断言
 *
 * 1. **未传 `gitIntegration`** ⇒ 入口抛 `git-integration-disabled`（缺省不启用）；
 * 2. **传入真实仓库** ⇒ 返回报告，且 `integrationBranchName` 非空、
 *    `targetBaseCommit` 指向目标分支的真实提交。
 *
 * ## 明确**不在**本文件范围
 *
 * 目标分支合并（Step 3）与 Worker 的 worktree 分流（编排器侧 `buildGitWorktreeToolPort`）
 * —— 前者需用户授权且须满足五道门禁，后者见总表 §8.6。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let workingDirectory: string;
let repositoryPath: string;
let stateDirectory: string;

async function runGit(arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, { cwd: repositoryPath });
  return result.stdout;
}

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g1-"));
  repositoryPath = path.join(workingDirectory, "repo");
  stateDirectory = path.join(workingDirectory, "state");
  await fs.mkdir(repositoryPath, { recursive: true });
  await fs.mkdir(stateDirectory, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: repositoryPath,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], {
    cwd: repositoryPath,
  });
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("G1 Step 2：Git 集成会话（真实仓库）", () => {
  it("未传 gitIntegration ⇒ 入口必须拒绝（缺省不启用）", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "devolve",
      runtime: "mock",
      useFeedbackProcess: false,
    } as unknown as Parameters<typeof AstarrayApplicationFacade.create>[0]);

    await expect(
      application.startIntegrationSession({
        missionId: "mission-1",
        integratingAgentInstanceId: "agent-1",
      }),
    ).rejects.toMatchObject({ errorCode: "git-integration-disabled" });

    await application.shutdown();
  });

  it("传入真实仓库 ⇒ 创建集成分支并返回报告", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "devolve",
      runtime: "mock",
      useFeedbackProcess: false,
      gitIntegration: { repositoryPath, targetBranchName: "main" },
    } as unknown as Parameters<typeof AstarrayApplicationFacade.create>[0]);

    const report = await application.startIntegrationSession({
      missionId: "mission-1",
      integratingAgentInstanceId: "agent-1",
    });

    expect(report.integrationBranchName, "集成分支名必须非空").not.toBe("");
    expect(report.targetBranchName).toBe("main");
    expect(report.targetBaseCommit, "目标分支基点提交必须解析到真实提交").not.toBe("");

    // 分支真的建出来了（git 侧实证，不只看返回值）
    const branches = await runGit(["branch", "--list", report.integrationBranchName]);
    expect(branches, "集成分支必须真实存在（git branch 可见）").toContain(
      report.integrationBranchName,
    );

    /**
     * Step 3 门禁（`AGENTS.md`：须提交哈希+测试+验收+人工体验+操作授权全满足才可 merge-ready）：
     * 本次会话**不得**改动目标分支 —— 用 git 实证，而不是看返回值。
     */
    const targetHead = (await runGit(["rev-parse", "main"])).trim();
    expect(targetHead, "目标分支必须保持原样（不得自动合并）").toBe(report.targetBaseCommit);

    await application.shutdown();
  });
});
