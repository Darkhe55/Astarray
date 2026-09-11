/**
 * 恢复对账本地端口（T12A-R1-02）。
 *
 * - worktree 存在性：真实文件系统只读检查（<base>/git-worktrees/...）；
 * - 人工变化观察：读取观察 journal 中 revision 最大的一条（只读）；
 * - Git 状态：受控 GitProcess 只读执行 `git status --porcelain=v1 --branch`；
 *   无 `.git` 或 git 不可用时抛 `ReconciliationStateUnavailableError`，
 *   由恢复中心 fail-closed 处理（不得当作“无差异”）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { GitProcess } from "./git-process.js";
import { humanChangeObservationSchema } from "./human-agent-concurrent-change-schemas.js";
import type { HumanChangeObservation } from "./human-agent-concurrent-change-schemas.js";
import type {
  GitStatusPort,
  HumanChangeObservationPort,
  WorktreeExistencePort,
} from "./readonly-reconciliation-service.js";
import { sanitizePathSegment } from "./work-archive-store.js";

/** Git 状态不可读（缺 .git / git 不可用 / 非仓库）：调用方必须 fail-closed。 */
export class ReconciliationStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationStateUnavailableError";
  }
}

export interface LocalGitStatusPortOptions {
  /** 项目工作区（含 .git 的目录）。 */
  workspaceDirectoryPath: string;
  gitProcess?: GitProcess;
}

/**
 * 真实只读 Git 状态端口：解析 `git status --porcelain=v1 --branch` 首行。
 * 只读：不执行任何写操作，不修改工作树。
 */
export function createLocalGitStatusPort(
  options: LocalGitStatusPortOptions,
): GitStatusPort {
  const gitProcess = options.gitProcess ?? new GitProcess({ gitCommandTimeoutSeconds: 15 });
  return {
    async readStatus() {
      if (
        !(await directoryExists(path.join(options.workspaceDirectoryPath, ".git")))
      ) {
        throw new ReconciliationStateUnavailableError(
          "工作区不是 git 仓库（缺少 .git）；无法确认检查点记录的 Git 状态",
        );
      }
      let result;
      try {
        result = await gitProcess.run(
          options.workspaceDirectoryPath,
          ["status", "--porcelain=v1", "--branch"],
          "读取工作区只读状态（恢复对账）",
        );
      } catch (error) {
        throw new ReconciliationStateUnavailableError(
          `git 状态不可读: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const outputLines = result.stdoutText.split(/\r?\n/).filter((line) => line !== "");
      const headerLine = outputLines[0] ?? "";
      const branchMatch = /^##\s+(?:No commits yet on\s+)?([^\s.]+)/.exec(headerLine);
      const branchName = branchMatch?.[1] ?? "HEAD";
      let headCommitIdentifier = "unknown";
      try {
        const headResult = await gitProcess.run(
          options.workspaceDirectoryPath,
          ["rev-parse", "HEAD"],
          "读取 HEAD 提交（恢复对账）",
        );
        headCommitIdentifier = headResult.stdoutText.trim();
      } catch {
        // 空仓库（无提交）：保持 unknown，仍以分支与脏状态对账
      }
      return {
        branchName,
        headCommitIdentifier,
        hasDirtyWorkingTree: outputLines.length > 1,
      };
    },
  };
}

/** 真实只读 worktree 存在性端口（相对 <base>/git-worktrees 的标识）。 */
export function createLocalWorktreeExistencePort(
  baseDirectory: string,
): WorktreeExistencePort {
  return {
    async doesWorktreeExist({ worktreeIdentifier }) {
      const segments = worktreeIdentifier
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => sanitizePathSegment(segment));
      if (segments.length === 0) {
        return false;
      }
      return directoryExists(
        path.join(baseDirectory, "git-worktrees", ...segments),
      );
    },
  };
}

/**
 * 真实只读人工变化观察端口：读取 <base>/human-change-journal/*.json，
 * 返回 revision 最大的一条；无记录返回 null。
 */
export function createLocalHumanChangeObservationPort(
  baseDirectory: string,
): HumanChangeObservationPort {
  return {
    async readLatestObservation(): Promise<HumanChangeObservation | null> {
      const journalDirectoryPath = path.join(
        baseDirectory,
        "human-change-journal",
      );
      let entryNames: string[];
      try {
        entryNames = await fs.readdir(journalDirectoryPath);
      } catch {
        return null;
      }
      let latest: HumanChangeObservation | null = null;
      for (const entryName of entryNames) {
        if (!entryName.endsWith(".json")) {
          continue;
        }
        try {
          const rawContent = await fs.readFile(
            path.join(journalDirectoryPath, entryName),
            "utf8",
          );
          const parsed = humanChangeObservationSchema.safeParse(
            JSON.parse(rawContent),
          );
          if (
            parsed.success &&
            (latest === null ||
              parsed.data.observationRevision > latest.observationRevision)
          ) {
            latest = parsed.data;
          }
        } catch {
          // 损坏条目跳过：对账不得因单条损坏 journal 而误判为无变化
        }
      }
      return latest;
    },
  };
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const statistics = await fs.stat(directoryPath);
    return statistics.isDirectory();
  } catch {
    return false;
  }
}
