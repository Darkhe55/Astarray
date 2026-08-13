/**
 * Git 集成协调器（T05B / ADR-0012）。
 * 由具体且不可复用的次级 Agent 个体绑定 mission 集成会话；只有它能写集成分支。
 * 流程：固定基线 → 创建集成分支 → 分配 worker → 三级 Agent 提交 →
 * 验证（身份/祖先/越界/敏感信息/测试证据）→ 通过后保留来源合并 →
 * 集成测试 → 模式/用户门禁 → 目标分支合并 → 生成结构化报告。
 *
 * 门禁规则：git push、PR、发布、强制推送、受保护分支修改始终需要独立授权；
 * 协调器只提供受控的本地合并，不允许模型可控的"跳过审查/跳过备份/强制合并"。
 */
import { spawnSync } from "node:child_process";

import { DomainError } from "../core/errors.js";
import type {
  GitCheckExecutionRecord,
  GitContributionReviewRecord,
  GitIntegrationReport,
} from "../core/types.js";
import type { GitContributionVerifier } from "./git-contribution-verifier.js";
import type { GitIntegrationReportStore } from "./git-integration-report-store.js";
import { GitProcess } from "./git-process.js";
import type { GitRecoveryPointService } from "./git-recovery-point-service.js";
import { GitWorktreeAllocator } from "./git-worktree-allocator.js";

export interface StartIntegrationSessionInput {
  missionId: string;
  /** 具体次级 Agent 实例（集成分支唯一写入者）。 */
  integratingAgentInstanceId: string;
  repositoryPath: string;
  targetBranchName: string;
}

export interface SubmitContributionInput {
  missionId: string;
  taskId: string;
  repositoryPath: string;
  baseCommit: string;
  headCommit: string;
  executedChecks: GitCheckExecutionRecord[];
}

export interface FinalizeIntegrationInput {
  missionId: string;
  integratingAgentInstanceId: string;
  repositoryPath: string;
  integrationTestCommands: string[];
  /** 目标分支合并是否被模式与用户授权允许（由 harness 注入，协调器不自行判定）。 */
  isTargetBranchMergeAllowed: boolean;
}

export interface GitIntegrationCoordinatorOptions {
  worktreeAllocator: GitWorktreeAllocator;
  verifier: GitContributionVerifier;
  reportStore: GitIntegrationReportStore;
  recoveryPointService: GitRecoveryPointService;
  gitProcess?: GitProcess;
}

export class GitIntegrationCoordinator {
  private readonly gitProcess: GitProcess;
  private readonly integrationTestTimeoutSeconds = 300;

  constructor(private readonly options: GitIntegrationCoordinatorOptions) {
    this.gitProcess = options.gitProcess ?? new GitProcess();
  }

  /** 供上级（harness/测试）访问分配器以创建 worker。 */
  worktreeAllocator(): GitWorktreeAllocator {
    return this.options.worktreeAllocator;
  }

  /**
   * 固定任务基线并创建集成分支。只有绑定本次会话的次级 Agent 能推进会话；
   * 会话记录（目标分支、基线）持久化到报告存储。
   */
  async startIntegrationSession(
    input: StartIntegrationSessionInput,
  ): Promise<GitIntegrationReport> {
    const baseResolve = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `${input.targetBranchName}^{commit}`],
        `解析目标分支 ${input.targetBranchName}`,
      )
      .catch(() => null);
    const targetBaseCommit = baseResolve?.stdoutText.trim() ?? "";
    if (targetBaseCommit === "") {
      throw new DomainError(
        "dependency-not-found",
        `目标分支无效: ${input.targetBranchName}`,
      );
    }
    const integrationBranchName = GitWorktreeAllocator.buildIntegrationBranchName(
      input.missionId,
      input.integratingAgentInstanceId,
    );
    const integrationExists = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranchName}`],
        `检查集成分支是否存在`,
      )
      .catch(() => null);
    if (
      integrationExists === null ||
      integrationExists.stdoutText.trim() === ""
    ) {
      await this.gitProcess.run(
        input.repositoryPath,
        ["branch", integrationBranchName, targetBaseCommit],
        `创建集成分支 ${integrationBranchName}`,
      );
    }
    const report: GitIntegrationReport = {
      missionId: input.missionId,
      integratingAgentInstanceId: input.integratingAgentInstanceId,
      targetBranchName: input.targetBranchName,
      integrationBranchName,
      targetBaseCommit,
      reviewedContributions: [],
      integrationCommit: null,
      unresolvedRisks: [],
      createdAtIso: new Date().toISOString(),
    };
    await this.options.reportStore.saveReport(report);
    return report;
  }

  /**
   * 三级 Agent 上报贡献后调用：读取分配记录 → 验证 → 通过则保留来源合并
   * （merge --no-ff 创建合并提交）→ 更新报告。审查失败返回结构化拒绝。
   */
  async submitContribution(
    input: SubmitContributionInput,
  ): Promise<{
    reviewDecision: "accepted" | "rejected" | "needs-rework";
    rejectionReasons: string[];
    report: GitIntegrationReport;
  }> {
    const allocation = await this.options.worktreeAllocator.readAllocation(
      input.taskId,
    );
    if (allocation === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `未找到任务 ${input.taskId} 的 worker 分配记录`,
      );
    }
    const verification = await this.options.verifier.verifyContribution({
      allocation,
      repositoryPath: input.repositoryPath,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      executedChecks: input.executedChecks,
    });
    const contributionRecord: GitContributionReviewRecord = {
      taskId: input.taskId,
      contributingAgentInstanceId: allocation.tertiaryAgentInstanceId,
      workerBranchName: allocation.workerBranchName,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      changedPaths: verification.changedPaths,
      reviewDecision: verification.reviewDecision,
      rejectionReason:
        verification.failureReasons.length > 0
          ? verification.failureReasons.join("；")
          : null,
      executedChecks: input.executedChecks.map((check) => ({ ...check })),
    };
    if (verification.reviewDecision === "accepted") {
      await this.gitProcess.run(
        input.repositoryPath,
        [
          "checkout",
          allocation.integrationBranchName,
        ],
        `切换集成分支 ${allocation.integrationBranchName}`,
      );
      // 恢复点：合并本身非破坏性，但若冲突处理失败需要可回退（先记录当前集成 tip）
      const recoveryPoint = await this.options.recoveryPointService.createRecoveryPoint(
        {
          missionId: input.missionId,
          repositoryPath: input.repositoryPath,
          operationDescription: `合并 ${allocation.workerBranchName} 到集成分支`,
          affectedReferenceNames: [
            `refs/heads/${allocation.integrationBranchName}`,
          ],
          affectedWorktreePath: null,
          affectedWorkingTreeRoot: null,
        },
      );
      await this.gitProcess
        .run(
          input.repositoryPath,
          [
            "merge",
            "--no-ff",
            "--no-edit",
            allocation.workerBranchName,
          ],
          `保留来源合并 ${allocation.workerBranchName}`,
        )
        .catch((error: unknown) => {
          throw new DomainError(
            "tool-execution-failed",
            `合并失败（冲突需创建独立修复任务，禁止静默选边）: ${(error as Error).message}；恢复点 ${recoveryPoint.recoveryPointId} 可用`,
          );
        });
      await this.gitProcess
        .run(input.repositoryPath, ["checkout", "--detach", "HEAD"], `完成集成分支合并后脱离分支`)
        .catch(() => {});
    }
    // 更新会话报告：读取既有会话记录（目标分支/集成者身份不可变），追加本次贡献
    const integratingAgentInstanceId = allocation.integrationBranchName
      .split("/")
      .at(-1)!;
    const sessionReport = await this.options.reportStore.readReport(
      input.missionId,
      integratingAgentInstanceId,
    );
    if (sessionReport === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `集成会话不存在: ${input.missionId}（集成者 ${integratingAgentInstanceId}）`,
      );
    }
    const integrationCommitResult = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${allocation.integrationBranchName}^{commit}`],
        `解析集成分支 tip`,
      )
      .catch(() => null);
    const integrationCommit =
      integrationCommitResult?.stdoutText.trim() ?? null;
    const report: GitIntegrationReport = {
      ...sessionReport,
      reviewedContributions: [
        ...sessionReport.reviewedContributions,
        contributionRecord,
      ],
      integrationCommit,
      unresolvedRisks: sessionReport.unresolvedRisks,
    };
    await this.options.reportStore.saveReport(report);
    return {
      reviewDecision: verification.reviewDecision,
      rejectionReasons: verification.failureReasons,
      report,
    };
  }

  /**
   * 全部 worker 集成后：运行集成测试与质量门禁 → 门禁通过且模式/用户授权
   * 允许时把集成分支合入目标分支。未授权时报告保留，目标分支不动。
   */
  async finalizeIntegration(
    input: FinalizeIntegrationInput,
  ): Promise<GitIntegrationReport> {
    const report = await this.options.reportStore.readReport(
      input.missionId,
      input.integratingAgentInstanceId,
    );
    if (report === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `集成会话不存在: ${input.missionId}`,
      );
    }
    if (report.integrationCommit === null) {
      throw new DomainError(
        "invalid-task-chain",
        "集成分支尚无合并提交，不能收尾",
      );
    }
    // 集成测试（命令由会话配置，在仓库目录以 shell 执行，全部必须成功）
    for (const testCommand of input.integrationTestCommands) {
      const testResult = this.runIntegrationTestCommand(
        input.repositoryPath,
        testCommand,
      );
      if (!testResult) {
        report.unresolvedRisks.push(`集成测试失败: ${testCommand}`);
      }
    }
    if (report.unresolvedRisks.length > 0) {
      await this.options.reportStore.saveReport(report);
      return report;
    }
    if (input.isTargetBranchMergeAllowed) {
      // 目标分支合并前自动创建恢复点（目标分支引用可回退）
      await this.options.recoveryPointService.createRecoveryPoint({
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        operationDescription: `集成分支合入目标分支 ${report.targetBranchName}`,
        affectedReferenceNames: [`refs/heads/${report.targetBranchName}`],
        affectedWorktreePath: null,
        affectedWorkingTreeRoot: null,
      });
      await this.gitProcess.run(
        input.repositoryPath,
        ["checkout", report.targetBranchName],
        `切换目标分支 ${report.targetBranchName}`,
      );
      await this.gitProcess.run(
        input.repositoryPath,
        ["merge", "--no-ff", "--no-edit", report.integrationBranchName],
        `目标分支合并集成分支`,
      );
      await this.gitProcess
        .run(input.repositoryPath, ["checkout", "--detach", "HEAD"], `脱离目标分支`)
        .catch(() => {});
    }
    await this.options.reportStore.saveReport(report);
    return report;
  }

  /** 在仓库目录以 shell 执行集成测试命令（命令由会话配置，非模型输入）。 */
  private runIntegrationTestCommand(
    repositoryPath: string,
    command: string,
  ): boolean {
    const result = spawnSync(command, {
      cwd: repositoryPath,
      shell: true,
      windowsHide: true,
      timeout: this.integrationTestTimeoutSeconds * 1000,
      encoding: "utf8",
    });
    return result.status === 0;
  }
}
