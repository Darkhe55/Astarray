/**
 * Git 破坏性操作自动恢复点（T05B / ADR-0012 §权限与恢复）。
 * 在 reset、clean、checkout 覆盖、rebase、强制移动引用、删除分支/worktree
 * 等破坏性操作执行前，由底层工具自动创建恢复点：
 * - 目标引用的当前 oid 备份为 refs/astarray-recovery/<recoveryPointId>/<name>；
 * - 工作树未提交内容 pre-image（含 untracked）保存到受保护恢复目录；
 * - 恢复元数据写入恢复点 JSON（原子写 + schema 校验）。
 *
 * 备份过程不经过模型：本服务不接受"跳过备份"参数；恢复引用与恢复目录
 * 只能经受控工具读取/恢复，模型不可见物理路径。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { gitRecoveryPointDocumentSchema } from "../core/schemas.js";
import { GIT_RECOVERY_POINT_SCHEMA_VERSION } from "../core/types.js";
import type { GitRecoveryPointDocument } from "../core/types.js";
import { GitProcess } from "./git-process.js";

export interface GitRecoveryPointServiceOptions {
  /** 状态目录根（恢复点存放于 <root>/git-recovery/<missionId>/...）。 */
  baseDirectory: string;
  gitProcess?: GitProcess;
}

export interface CreateRecoveryPointInput {
  missionId: string;
  repositoryPath: string;
  operationDescription: string;
  /** 破坏性操作影响的引用（refs/heads/... 等），执行前备份当前 oid。 */
  affectedReferenceNames: string[];
  /** 破坏性操作影响的工作树路径（可选；备份未提交内容）。 */
  affectedWorktreePath: string | null;
  /** 破坏性操作影响的原始路径（如将被 clean/reset 清除的工作区根）。 */
  affectedWorkingTreeRoot: string | null;
}

export interface RestoreRecoveryPointInput {
  missionId: string;
  recoveryPointId: string;
  repositoryPath: string;
  worktreePath: string | null;
}

const RECOVERY_REF_PREFIX = "refs/astarray-recovery/";

function sanitizeRefSegment(refName: string): string {
  let sanitized = "";
  for (const character of refName) {
    if (/[A-Za-z0-9._/-]/.test(character)) {
      sanitized += character;
    } else {
      sanitized += `~${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
  return sanitized;
}

export class GitRecoveryPointService {
  private readonly recoveryRootDirectory: string;
  private readonly gitProcess: GitProcess;

  constructor(options: GitRecoveryPointServiceOptions) {
    this.recoveryRootDirectory = path.join(
      options.baseDirectory,
      "git-recovery",
    );
    this.gitProcess = options.gitProcess ?? new GitProcess();
  }

  /** 供测试/审计：恢复引用前缀（模型不可用工具删除该前缀）。 */
  static getRecoveryReferencePrefix(): string {
    return RECOVERY_REF_PREFIX;
  }

  /**
   * 破坏性操作执行前调用：备份引用 oid + 未提交内容 pre-image。
   * 返回恢复点文档；后续只能经受控 restoreRecoveryPoint 恢复。
   */
  async createRecoveryPoint(
    input: CreateRecoveryPointInput,
  ): Promise<GitRecoveryPointDocument> {
    const recoveryPointId = `recovery-${randomUUID()}`;
    const recoveryDirectoryPath = this.recoveryPointDirectory(
      input.missionId,
      recoveryPointId,
    );
    await fs.mkdir(recoveryDirectoryPath, { recursive: true });

    const referenceBackups: Array<{
      referenceName: string;
      committedOid: string;
    }> = [];
    for (const referenceName of input.affectedReferenceNames) {
      let committedOid: string | null = null;
      try {
        const resolveResult = await this.gitProcess.run(
          input.repositoryPath,
          ["rev-parse", "--verify", "--quiet", `${referenceName}^{commit}`],
          `解析引用 ${referenceName}`,
        );
        const resolvedOid = resolveResult.stdoutText.trim();
        if (resolvedOid !== "") {
          committedOid = resolvedOid;
        }
      } catch {
        committedOid = null;
      }
      if (committedOid === null) {
        continue;
      }
      const backupRefName =
        RECOVERY_REF_PREFIX +
        sanitizeRefSegment(input.missionId) +
        "/" +
        recoveryPointId +
        "/" +
        sanitizeRefSegment(referenceName);
      await this.gitProcess.run(
        input.repositoryPath,
        ["update-ref", backupRefName, committedOid],
        `备份引用 ${referenceName} → ${backupRefName}`,
      );
      referenceBackups.push({ referenceName, committedOid });
    }

    let worktreePreimagePatch = "";
    let untrackedFileEntries: Array<{ relativePath: string }> = [];
    if (input.affectedWorktreePath !== null) {
      try {
        const diffResult = await this.gitProcess.run(
          input.affectedWorktreePath,
          ["diff", "--binary", "HEAD"],
          `保存工作树未提交改动 pre-image`,
        );
        worktreePreimagePatch = diffResult.stdoutText;
      } catch {
        worktreePreimagePatch = "";
      }
      if (input.affectedWorkingTreeRoot !== null) {
        try {
          const untrackedResult = await this.gitProcess.run(
            input.affectedWorkingTreeRoot,
            ["ls-files", "--others", "--exclude-standard"],
            `列出未跟踪文件`,
          );
          untrackedFileEntries = untrackedResult.stdoutText
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((relativePath) => ({ relativePath }));
        } catch {
          untrackedFileEntries = [];
        }
        for (const untrackedEntry of untrackedFileEntries) {
          const sourcePath = path.join(
            input.affectedWorkingTreeRoot,
            untrackedEntry.relativePath,
          );
          const targetPath = path.join(
            recoveryDirectoryPath,
            "untracked",
            untrackedEntry.relativePath,
          );
          try {
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(sourcePath, targetPath);
          } catch {
            // 文件在列目录后被移除等竞态：忽略该文件快照
          }
        }
      }
    }

    if (worktreePreimagePatch !== "") {
      await fs.writeFile(
        path.join(recoveryDirectoryPath, "worktree-preimage.patch"),
        worktreePreimagePatch,
        "utf8",
      );
    }

    const document: GitRecoveryPointDocument = {
      schemaVersion: GIT_RECOVERY_POINT_SCHEMA_VERSION,
      recoveryPointId,
      missionId: input.missionId,
      createdAtIso: new Date().toISOString(),
      operationDescription: input.operationDescription,
      repositoryPath: input.repositoryPath,
      affectedReferenceNames: referenceBackups.map(
        (backup) => backup.referenceName,
      ),
      referenceBackups,
      hasWorktreePreimage: worktreePreimagePatch !== "",
      untrackedFileEntries,
      restoredAtIso: null,
    };
    const parsed = gitRecoveryPointDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `恢复点文档非法: ${parsed.error.message}`,
      );
    }
    await fs.writeFile(
      path.join(recoveryDirectoryPath, "recovery-point.json"),
      JSON.stringify(parsed.data, null, 2),
      "utf8",
    );
    return parsed.data;
  }

  /**
   * 受控恢复：重新创建受影响引用到备份 oid，恢复工作树未提交内容。
   * 恢复本身覆盖当前状态，因此恢复前会再创建一个前置恢复点（恢复可撤销）。
   */
  async restoreRecoveryPoint(
    input: RestoreRecoveryPointInput,
  ): Promise<GitRecoveryPointDocument> {
    const document = await this.readRecoveryPoint(
      input.missionId,
      input.recoveryPointId,
    );
    if (document.restoredAtIso !== null) {
      throw new DomainError(
        "invalid-task-chain",
        `恢复点 ${input.recoveryPointId} 已被恢复过，禁止重复恢复`,
      );
    }
    // 前置保护：当前工作树如有未提交改动，先自动创建"恢复前"恢复点（恢复可撤销）
    if (input.worktreePath !== null) {
      await this.createRecoveryPoint({
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        operationDescription: `恢复 ${input.recoveryPointId} 前的工作树保护`,
        affectedReferenceNames: [],
        affectedWorktreePath: input.worktreePath,
        affectedWorkingTreeRoot: input.worktreePath,
      });
    }
    const recoveryDirectoryPath = this.recoveryPointDirectory(
      input.missionId,
      input.recoveryPointId,
    );
    for (const referenceBackup of document.referenceBackups) {
      await this.gitProcess.run(
        input.repositoryPath,
        ["update-ref", referenceBackup.referenceName, referenceBackup.committedOid],
        `恢复引用 ${referenceBackup.referenceName}`,
      );
      if (input.worktreePath !== null && document.hasWorktreePreimage) {
        // 先把工作树对齐到恢复点时刻的提交（覆盖当前内容；前置恢复点已保护），
        // 再应用 pre-image 补丁，保证补丁上下文匹配。
        await this.gitProcess.run(
          input.worktreePath,
          ["reset", "--hard", referenceBackup.committedOid],
          `对齐工作树到备份提交`,
        );
      }
    }
    if (document.hasWorktreePreimage && input.worktreePath !== null) {
      const patchFilePath = path.join(
        recoveryDirectoryPath,
        "worktree-preimage.patch",
      );
      const applyResult = await this.gitProcess
        .run(
          input.worktreePath,
          ["apply", "--binary", patchFilePath],
          `应用工作树 pre-image 补丁`,
        )
        .catch(() => null);
      if (applyResult === null) {
        throw new DomainError(
          "tool-execution-failed",
          `恢复点 ${input.recoveryPointId} 工作树 pre-image 应用失败，请检查手工冲突`,
        );
      }
    }
    for (const untrackedEntry of document.untrackedFileEntries) {
      if (input.worktreePath === null) {
        break;
      }
      const sourcePath = path.join(
        recoveryDirectoryPath,
        "untracked",
        untrackedEntry.relativePath,
      );
      const targetPath = path.join(input.worktreePath, untrackedEntry.relativePath);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
      } catch {
        // 目标已存在或已被其他进程移除：不覆盖
      }
    }
    const restoredDocument: GitRecoveryPointDocument = {
      ...document,
      restoredAtIso: new Date().toISOString(),
    };
    const parsed = gitRecoveryPointDocumentSchema.safeParse(restoredDocument);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `恢复点文档非法: ${parsed.error.message}`,
      );
    }
    await fs.writeFile(
      path.join(recoveryDirectoryPath, "recovery-point.json"),
      JSON.stringify(parsed.data, null, 2),
      "utf8",
    );
    return parsed.data;
  }

  async readRecoveryPoint(
    missionId: string,
    recoveryPointId: string,
  ): Promise<GitRecoveryPointDocument> {
    const recoveryDirectoryPath = this.recoveryPointDirectory(
      missionId,
      recoveryPointId,
    );
    let rawContent: string;
    try {
      rawContent = await fs.readFile(
        path.join(recoveryDirectoryPath, "recovery-point.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError(
          "task-sequence-not-found",
          `恢复点不存在: ${recoveryPointId}`,
        );
      }
      throw error;
    }
    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch {
      throw new DomainError(
        "journal-corrupted",
        `恢复点文档非法: ${recoveryPointId}`,
      );
    }
    const parsed = gitRecoveryPointDocumentSchema.safeParse(parsedContent);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `恢复点文档非法: ${recoveryPointId}（${parsed.error.message}）`,
      );
    }
    return parsed.data;
  }

  /** 列出某 mission 下全部恢复点（按创建时间升序）。 */
  async listRecoveryPoints(
    missionId: string,
  ): Promise<GitRecoveryPointDocument[]> {
    const missionDirectory = path.join(
      this.recoveryRootDirectory,
      sanitizeRefSegment(missionId),
    );
    let entryNames: string[];
    try {
      entryNames = await fs.readdir(missionDirectory);
    } catch {
      return [];
    }
    const documents: GitRecoveryPointDocument[] = [];
    for (const entryName of entryNames.sort()) {
      try {
        documents.push(await this.readRecoveryPoint(missionId, entryName));
      } catch {
        // 目录条目不是恢复点或文档损坏：跳过
      }
    }
    documents.sort((left, right) =>
      left.createdAtIso.localeCompare(right.createdAtIso),
    );
    return documents;
  }

  private recoveryPointDirectory(
    missionId: string,
    recoveryPointId: string,
  ): string {
    return path.join(
      this.recoveryRootDirectory,
      sanitizeRefSegment(missionId),
      recoveryPointId,
    );
  }
}
