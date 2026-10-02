/**
 * 行为反例（RELIABILITY-01-02 · R3，2026-10-02）：
 *
 * 审计（RELIABILITY-01-01 §疑点3）确认两处缺陷：
 *  ① `finalizeIntegration` 把 `checkout --detach` 的失败 `.catch(() => {})` **静默吞掉**
 *     （工作区可能仍停在目标分支）；
 *  ② `merge` 失败/超时**直接抛出**，没有"合并是否已生效"的对账
 *     （卡内要求"超时不能等同操作失败或停止成功"）。
 *
 * 本文件在修复前必须失败（①② 均红）。
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GitIntegrationCoordinator } from "../../../packages/core/src/orchestration/git-integration-coordinator.js";
import type { GitProcess } from "../../../packages/core/src/orchestration/git-process.js";
import type { GitIntegrationReport } from "../../../packages/core/src/core/types.js";

const REPORT: GitIntegrationReport = {
  missionId: "mission-1",
  integratingAgentInstanceId: "secondary-1",
  targetBranchName: "main",
  integrationBranchName: "mission-1-integration",
  targetBaseCommit: "abc123",
  reviewedContributions: [],
  integrationCommit: "def456",
  unresolvedRisks: [],
  createdAtIso: "2026-10-02T00:00:00.000Z",
};

/**
 * 本用例只验证"合并对账 + 错误可见性"，因此**不注入集成测试命令**：
 * `runIntegrationTestCommand` 走 `spawnSync(shell:true)`，在本机沙箱下受限，
 * 会干扰判定；命令执行本身由既有测试覆盖。
 */

interface RecordedGitCall {
  gitArguments: string[];
  commandDescription: string;
}

function buildCoordinator(input: {
  gitProcess: Partial<GitProcess>;
  reportOverrides?: Partial<GitIntegrationReport>;
}): { coordinator: GitIntegrationCoordinator; savedReports: GitIntegrationReport[] } {
  const savedReports: GitIntegrationReport[] = [];
  const report: GitIntegrationReport = { ...REPORT, ...input.reportOverrides };
  const coordinator = new GitIntegrationCoordinator({
    worktreeAllocator: {} as never,
    verifier: {} as never,
    reportStore: {
      readReport: async () => ({ ...report, unresolvedRisks: [...report.unresolvedRisks] }),
      saveReport: async (nextReport: GitIntegrationReport) => {
        savedReports.push(structuredClone(nextReport));
      },
    } as never,
    recoveryPointService: {
      createRecoveryPoint: async () => ({ backupIdentifier: "recovery-1" }),
    } as never,
    gitProcess: input.gitProcess as GitProcess,
  });
  return { coordinator, savedReports };
}

describe("目标分支合并的对账与错误可见性（R3）", () => {
  it("① merge 超时 + 探测确认已合并 → 记入未决风险且注明已确认", async () => {
    const gitCalls: RecordedGitCall[] = [];
    const { coordinator, savedReports } = buildCoordinator({
      gitProcess: {
        run: async (_path: string, gitArguments: string[], commandDescription: string) => {
          gitCalls.push({ gitArguments, commandDescription });
          if (gitArguments[0] === "merge") {
            throw new Error("git 命令超时（60 秒）: 目标分支合并集成分支");
          }
          if (gitArguments[0] === "merge-base") {
            return { commandDescription, stdoutText: "", stderrText: "", exitCode: 0, durationSeconds: 0.01 };
          }
          return { commandDescription, stdoutText: "ok", stderrText: "", exitCode: 0, durationSeconds: 0.01 };
        },
      } as Partial<GitProcess>,
    });

    const report = await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: "secondary-1",
      repositoryPath: "/repo",
      integrationTestCommands: [],
      isTargetBranchMergeAllowed: true,
    });

    expect(report.unresolvedRisks.some((risk) => risk.includes("目标分支合并未确认"))).toBe(true);
    expect(report.unresolvedRisks.some((risk) => risk.includes("merged"))).toBe(true);
    // 必须真的做过只读对账（merge-base --is-ancestor）。
    expect(gitCalls.some((call) => call.gitArguments[0] === "merge-base")).toBe(true);
    expect(savedReports.length).toBeGreaterThan(0);
  });

  it("② 脱离目标分支失败 → 必须记入未决风险（不得静默吞掉）", async () => {
    const { coordinator } = buildCoordinator({
      gitProcess: {
        run: async (_path: string, gitArguments: string[], commandDescription: string) => {
          if (gitArguments[0] === "checkout" && gitArguments.includes("--detach")) {
            throw new Error("detach 失败（夹具）");
          }
          return { commandDescription, stdoutText: "ok", stderrText: "", exitCode: 0, durationSeconds: 0.01 };
        },
      } as Partial<GitProcess>,
    });

    const report = await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: "secondary-1",
      repositoryPath: "/repo",
      integrationTestCommands: [],
      isTargetBranchMergeAllowed: true,
    });

    expect(report.unresolvedRisks.some((risk) => risk.includes("脱离目标分支失败"))).toBe(true);
  });

  it("③ 正常路径（合并与脱离都成功）→ 不得产生未决风险（不误报）", async () => {
    const { coordinator } = buildCoordinator({
      gitProcess: {
        run: async (_path: string, _gitArguments: string[], commandDescription: string) => ({
          commandDescription,
          stdoutText: "ok",
          stderrText: "",
          exitCode: 0,
          durationSeconds: 0.01,
        }),
      } as Partial<GitProcess>,
    });

    const report = await coordinator.finalizeIntegration({
      missionId: "mission-1",
      integratingAgentInstanceId: "secondary-1",
      repositoryPath: "/repo",
      integrationTestCommands: [],
      isTargetBranchMergeAllowed: true,
    });

    expect(report.unresolvedRisks).toEqual([]);
  });
});

// 抑制未使用导入告警（保留以便后续扩展真实文件系统断言）。
void existsSync;
void readFileSync;
