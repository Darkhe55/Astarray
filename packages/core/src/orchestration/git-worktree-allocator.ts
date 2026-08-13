/**
 * Git 工作树分配器（T05B / ADR-0012 §分流规则）。
 * 从固定基线为每个写入型三级任务创建隔离分支 + worktree：
 * - 分支名：worker/<task>/<agent>（任务与 Agent 具体化）；
 * - worktree 位于状态目录 <root>/git-worktrees/<mission>/<task>/<agent>；
 * - worktree 中设置 git user.name/user.email = 绑定的 agentInstanceId（提交身份绑定）；
 * - 分配记录（GitWorkerAllocation）持久化到状态目录，供验证器使用。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import { gitWorkerAllocationSchema } from "../core/schemas.js";
import type { GitWorkerAllocation } from "../core/types.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import { GitProcess } from "./git-process.js";

export interface GitWorktreeAllocatorOptions {
  baseDirectory: string;
  gitProcess?: GitProcess;
}

export interface AllocateWorkerInput {
  missionId: string;
  taskId: string;
  tertiaryAgentInstanceId: string;
  integrationBranchName: string;
  /** 固定基线提交（worker 分支从该提交创建）。 */
  targetBaseCommit: string;
  /** 任务允许修改路径（仓库相对路径）。 */
  allowedPaths: string[];
}

export class GitWorktreeAllocator {
  private readonly worktreesRootDirectory: string;
  private readonly allocationsRootDirectory: string;
  private readonly gitProcess: GitProcess;

  constructor(options: GitWorktreeAllocatorOptions) {
    this.worktreesRootDirectory = path.join(options.baseDirectory, "git-worktrees");
    this.allocationsRootDirectory = path.join(
      options.baseDirectory,
      "git-allocations",
    );
    this.gitProcess = options.gitProcess ?? new GitProcess();
  }

  static buildWorkerBranchName(
    taskId: string,
    tertiaryAgentInstanceId: string,
  ): string {
    return `worker/${taskId}/${tertiaryAgentInstanceId}`;
  }

  static buildIntegrationBranchName(
    missionId: string,
    integratingAgentInstanceId: string,
  ): string {
    return `integration/${missionId}/${integratingAgentInstanceId}`;
  }

  /**
   * 创建隔离 worktree：校验基线存在 → 创建集成分支（若不存在）→
   * 从基线创建 worker 分支 → 添加 worktree → 绑定身份 → 持久化分配记录。
   */
  async allocateWorker(
    input: AllocateWorkerInput,
    repositoryPath: string,
  ): Promise<GitWorkerAllocation> {
    const workerBranchName = GitWorktreeAllocator.buildWorkerBranchName(
      input.taskId,
      input.tertiaryAgentInstanceId,
    );
    const workerWorktreePath = path.join(
      this.worktreesRootDirectory,
      sanitizePathSegment(input.missionId),
      sanitizePathSegment(input.taskId),
      sanitizePathSegment(input.tertiaryAgentInstanceId),
    );
    // 基线必须是有效提交
    const baseCheckResult = await this.gitProcess
      .run(
        repositoryPath,
        ["rev-parse", "--verify", "--quiet", `${input.targetBaseCommit}^{commit}`],
        `校验基线提交 ${input.targetBaseCommit}`,
      )
      .catch(() => null);
    if (baseCheckResult === null || baseCheckResult.stdoutText.trim() === "") {
      throw new DomainError(
        "dependency-not-found",
        `基线提交无效: ${input.targetBaseCommit}`,
      );
    }
    const targetBaseCommit = baseCheckResult.stdoutText.trim();
    // 若 worker 分支已存在（重试），拒绝重复分配
    const existingBranchResult = await this.gitProcess
      .run(
        repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${workerBranchName}`],
        `检查 worker 分支是否已存在`,
      )
      .catch(() => null);
    if (
      existingBranchResult !== null &&
      existingBranchResult.stdoutText.trim() !== ""
    ) {
      throw new DomainError(
        "invalid-task-chain",
        `worker 分支已存在: ${workerBranchName}`,
      );
    }
    await this.gitProcess.run(
      repositoryPath,
      ["check-ref-format", "--branch", workerBranchName],
      `校验分支名格式 ${workerBranchName}`,
    );
    // 集成分支（不存在则从基线创建）
    const integrationExists = await this.gitProcess
      .run(
        repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${input.integrationBranchName}`],
        `检查集成分支是否已存在`,
      )
      .catch(() => null);
    if (
      integrationExists === null ||
      integrationExists.stdoutText.trim() === ""
    ) {
      await this.gitProcess.run(
        repositoryPath,
        ["branch", input.integrationBranchName, targetBaseCommit],
        `创建集成分支 ${input.integrationBranchName}`,
      );
    }
    // 从基线创建 worker 分支 + worktree
    await this.gitProcess.run(
      repositoryPath,
      ["branch", workerBranchName, targetBaseCommit],
      `从基线创建 worker 分支 ${workerBranchName}`,
    );
    try {
      await this.gitProcess.run(
        repositoryPath,
        ["worktree", "add", workerWorktreePath, workerBranchName],
        `添加隔离 worktree ${workerWorktreePath}`,
      );
    } catch (error) {
      await this.gitProcess
        .run(repositoryPath, ["branch", "-D", workerBranchName], `清理失败的 worker 分支`)
        .catch(() => {});
      throw error;
    }
    // 身份绑定：先启用 worktree 作用域 config 扩展（幂等），再设置身份，
    // 保证各 worktree 的提交身份独立且不污染共享配置。
    await this.gitProcess
      .run(
        repositoryPath,
        ["config", "--local", "extensions.worktreeConfig", "true"],
        `启用 worktreeConfig 扩展`,
      )
      .catch(() => {});
    await this.gitProcess.run(
      workerWorktreePath,
      ["config", "--worktree", "user.name", input.tertiaryAgentInstanceId],
      `绑定 worktree 提交身份 name`,
    );
    await this.gitProcess.run(
      workerWorktreePath,
      [
        "config",
        "--worktree",
        "user.email",
        `${input.tertiaryAgentInstanceId}@astarray.local`,
      ],
      `绑定 worktree 提交身份 email`,
    );
    const allocation: GitWorkerAllocation = {
      allocationId: `allocation-${randomUUID()}`,
      missionId: input.missionId,
      taskId: input.taskId,
      tertiaryAgentInstanceId: input.tertiaryAgentInstanceId,
      integrationBranchName: input.integrationBranchName,
      workerBranchName,
      worktreePath: workerWorktreePath,
      targetBaseCommit,
      allowedPaths: [...input.allowedPaths],
      createdAtIso: new Date().toISOString(),
    };
    const parsed = gitWorkerAllocationSchema.safeParse(allocation);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `分配记录非法: ${parsed.error.message}`,
      );
    }
    await writeAtomicJson(this.allocationFilePath(input.taskId), parsed.data);
    return parsed.data;
  }

  async readAllocation(taskId: string): Promise<GitWorkerAllocation | null> {
    try {
      const rawContent = await fs.readFile(
        this.allocationFilePath(taskId),
        "utf8",
      );
      const parsed = gitWorkerAllocationSchema.safeParse(JSON.parse(rawContent));
      if (!parsed.success) {
        throw new DomainError(
          "journal-corrupted",
          `分配记录非法: ${taskId}`,
        );
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private allocationFilePath(taskId: string): string {
    return path.join(
      this.allocationsRootDirectory,
      `${sanitizePathSegment(taskId)}.json`,
    );
  }
}
