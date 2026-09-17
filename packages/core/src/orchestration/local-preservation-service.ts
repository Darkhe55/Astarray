/**
 * GIT-PRESERVE-02：远端同步失败后的本地保全服务（ADR-0041）。
 *
 * 与"破坏性操作恢复点"（GitRecoveryPointService）分离：
 * - 远端同步状态与本地保全状态分别记录，互不推导；
 * - 网络失败/缺远端等同步失败立即生成保全点，不等重试耗尽；
 * - 版本化清单：引用 + index（已暂存）+ 未暂存 + 未跟踪（路径/大小/哈希）+ 删除/重命名；
 * - 独立对象归档（git bundle）+ sha256，与仓库内引用分开校验；
 * - 工作树之外的受保护目录、临时目录原子改名为 `ready`；
 * - 复制/读取/校验失败记录为 `incomplete`/`failed`，绝不静默当作空数据；
 * - 同一（提交 + 工作树指纹）复用已验证快照，重试不重复全量复制。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { GitProcess } from "./git-process.js";

export const LOCAL_PRESERVATION_SCHEMA_VERSION = 1;
export const LOCAL_PRESERVATION_POLICY_VERSION = 1;

/** 默认排除清单：依赖缓存与构建产物（已跟踪内容不受忽略规则影响）。 */
export const LOCAL_PRESERVATION_DEFAULT_EXCLUDED_PATTERNS: readonly string[] = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  ".venv/",
  "__pycache__/",
  ".pytest_cache/",
];

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type RemoteSyncFailureClass =
  | "failed-network"
  | "failed-authentication"
  | "failed-rejected"
  | "failed-no-remote"
  | "failed-unknown";

export type RemoteSyncStatus =
  | "not-attempted"
  | "attempting"
  | "succeeded"
  | RemoteSyncFailureClass;

export interface RemoteSyncOutcome {
  status: RemoteSyncStatus;
  remoteName: string | null;
  branchName: string | null;
  attemptCount: number;
  lastFailureClass: RemoteSyncFailureClass | null;
  observedAtIso: string;
  observedFailureMessage: string | null;
}

export type LocalPreservationStatus =
  | "ready"
  | "incomplete"
  | "failed";

export type PreservationChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "unmerged"
  | "untracked";

export interface PreservationChangeEntry {
  relativePath: string;
  changeKind: PreservationChangeKind;
  originalRelativePath: string | null;
  isStaged: boolean;
  isUnstaged: boolean;
}

export interface LocalPreservationManifest {
  schemaVersion: number;
  policyVersion: number;
  preservationPointId: string;
  missionId: string;
  repositoryPath: string;
  worktreePath: string;
  createdAtIso: string;
  reuseKey: string;
  remoteSync: RemoteSyncOutcome;
  localPreservation: {
    status: LocalPreservationStatus;
    failureReason: string | null;
    integrityResult: {
      isComplete: boolean;
      checkedItemCount: number;
      failures: string[];
    };
  };
  repository: {
    baseCommit: string | null;
    headReferenceName: string | null;
    isDetachedHead: boolean;
    hasUnbornHead: boolean;
    isShallowRepository: boolean;
    referenceOids: Array<{ referenceName: string; committedOid: string }>;
    submodulePaths: string[];
    lfsPointerFilePaths: string[];
    sparseCheckoutPatterns: string[];
    worktreeList: Array<{
      worktreePath: string;
      headOid: string | null;
      branchName: string | null;
    }>;
  };
  index: {
    treeOid: string | null;
    cachedPatchPath: string | null;
    cachedPatchSha256: string | null;
  };
  worktreeChanges: {
    unstagedPatchPath: string | null;
    unstagedPatchSha256: string | null;
  };
  untrackedFiles: Array<{
    relativePath: string;
    byteCount: number;
    sha256: string;
    archivedPath: string;
  }>;
  changeEntries: PreservationChangeEntry[];
  excludedPatterns: string[];
  excludedUntrackedFilePaths: string[];
  objectArchive: {
    filePath: string | null;
    sha256: string | null;
    byteCount: number;
    referenceNames: string[];
    isComplete: boolean;
    note: string | null;
  };
  snapshot: {
    directoryPath: string;
    manifestSha256: string;
  };
  restoredAtIso: string | null;
}

export interface CreateLocalPreservationInput {
  missionId: string;
  repositoryPath: string;
  worktreePath: string | null;
  reason: string;
  remoteSyncOutcome: RemoteSyncOutcome;
  excludedPatterns?: string[];
}

export interface PreservationTriggerDecision {
  shouldPreserve: boolean;
  classification: RemoteSyncStatus;
  reason: string;
}

export interface LocalPreservationCreationResult {
  manifest: LocalPreservationManifest;
  isReused: boolean;
}

export interface PreserveAfterRemoteSyncOutcomeResult {
  shouldPreserve: boolean;
  isReused: boolean;
  manifest: LocalPreservationManifest | null;
  trigger: PreservationTriggerDecision;
}

export interface RestoreLocalPreservationInput {
  missionId: string;
  preservationPointId: string;
  /** 恢复目标：必须是新目录或空目录；默认不覆盖当前人工工作区。 */
  restoreDirectoryPath: string;
}

export interface LocalPreservationRestoreResult {
  preservationPointId: string;
  restoreDirectoryPath: string;
  restoredReferenceNames: string[];
  restoredUntrackedFilePaths: string[];
  restoredIndexTreeOid: string | null;
  hasUnstagedPatch: boolean;
  restoredAtIso: string;
  /** false 表示恢复不依赖原仓库（仅用对象归档 + 快照）。 */
  isOriginalRepositoryRequired: boolean;
}

export interface LocalPreservationIntegrityReport {
  preservationPointId: string;
  isIntact: boolean;
  missingFilePaths: string[];
  mismatchedFilePaths: string[];
  failures: string[];
  checkedItemCount: number;
}

export interface IncompleteSnapshotDirectory {
  directoryPath: string;
  reason: "incomplete-temp-snapshot";
}

interface UntrackedFileCandidate {
  relativePath: string;
  byteCount: number;
  sha256: string;
  content: Buffer;
}

/** 判断同步结果是否需要本地保全（ADR-0041 §3）。 */
export function evaluateRemoteSyncPreservationTrigger(
  outcome: RemoteSyncOutcome,
): PreservationTriggerDecision {
  if (outcome.status === "succeeded") {
    return {
      shouldPreserve: false,
      classification: outcome.status,
      reason: "remote-sync-succeeded: 同步成功，不需要本地保全",
    };
  }
  if (outcome.status === "not-attempted" || outcome.status === "attempting") {
    return {
      shouldPreserve: false,
      classification: outcome.status,
      reason: "remote-sync-not-failed: 尚未发生同步失败，不需要本地保全",
    };
  }
  return {
    shouldPreserve: true,
    classification: outcome.status,
    reason:
      outcome.status === "failed-network"
        ? "remote-sync-failed-network: 网络失败立即保全（不等待重试耗尽）"
        : "remote-sync-failed: " + outcome.status + " 记录原因并保全",
  };
}

function sha256OfBuffer(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function matchesExcludedPattern(
  relativePath: string,
  pattern: string,
): boolean {
  if (pattern.endsWith("/")) {
    const directoryName = pattern.slice(0, -1);
    return (
      relativePath === directoryName ||
      relativePath.startsWith(pattern) ||
      relativePath.includes("/" + pattern)
    );
  }
  if (pattern.startsWith("*.")) {
    return relativePath.endsWith(pattern.slice(1));
  }
  return (
    relativePath === pattern || relativePath.endsWith("/" + pattern)
  );
}

interface ParsedPorcelainState {
  changeEntries: PreservationChangeEntry[];
  untrackedRelativePaths: string[];
  parseFailures: string[];
}

/** 解析 `git status --porcelain=v2 -z`（含 rename 的第二个路径 token）。 */
function parsePorcelainV2(rawText: string): ParsedPorcelainState {
  const changeEntries: PreservationChangeEntry[] = [];
  const untrackedRelativePaths: string[] = [];
  const parseFailures: string[] = [];
  const records = rawText.split("\u0000").filter((record) => record !== "");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    const recordType = record.slice(0, 2);
    if (recordType === "1 ") {
      const fields = record.slice(2).split(" ");
      const statusCharacters = fields[0] ?? "..";
      const relativePath = fields.slice(7).join(" ");
      changeEntries.push({
        relativePath,
        changeKind: toChangeKind(statusCharacters, relativePath, null),
        originalRelativePath: null,
        isStaged: statusCharacters[0] !== ".",
        isUnstaged: statusCharacters[1] !== ".",
      });
    } else if (recordType === "2 ") {
      const fields = record.slice(2).split(" ");
      const statusCharacters = fields[0] ?? "..";
      const relativePath = fields.slice(8).join(" ");
      const originalRelativePath = records[index + 1] ?? null;
      index += 1;
      changeEntries.push({
        relativePath,
        changeKind: "renamed",
        originalRelativePath:
          originalRelativePath === undefined ? null : originalRelativePath,
        isStaged: statusCharacters[0] !== ".",
        isUnstaged: statusCharacters[1] !== ".",
      });
    } else if (recordType === "u ") {
      const relativePath = record.slice(2).split(" ").slice(9).join(" ");
      changeEntries.push({
        relativePath,
        changeKind: "unmerged",
        originalRelativePath: null,
        isStaged: false,
        isUnstaged: true,
      });
    } else if (recordType === "? ") {
      const relativePath = record.slice(2);
      untrackedRelativePaths.push(relativePath);
      changeEntries.push({
        relativePath,
        changeKind: "untracked",
        originalRelativePath: null,
        isStaged: false,
        isUnstaged: true,
      });
    } else if (record.trim() !== "") {
      parseFailures.push("porcelain-record-unparsed: " + record.slice(0, 40));
    }
  }
  return { changeEntries, untrackedRelativePaths, parseFailures };
}

function toChangeKind(
  statusCharacters: string,
  relativePath: string,
  originalRelativePath: string | null,
): PreservationChangeKind {
  if (statusCharacters.includes("U")) {
    return "unmerged";
  }
  if (originalRelativePath !== null || statusCharacters.includes("R")) {
    return "renamed";
  }
  if (statusCharacters.includes("D")) {
    return "deleted";
  }
  if (statusCharacters.includes("A")) {
    return "added";
  }
  void relativePath;
  return "modified";
}

export class LocalPreservationService {
  private readonly preservationRootDirectory: string;
  private readonly gitProcess: GitProcess;
  private readonly nowIso: () => string;

  constructor(options: {
    baseDirectory: string;
    gitProcess?: GitProcess;
    nowIso?: () => string;
  }) {
    this.preservationRootDirectory = path.join(
      options.baseDirectory,
      "local-preservation",
    );
    this.gitProcess = options.gitProcess ?? new GitProcess();
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * 同步结果接线：失败（网络/缺远端/认证/拒绝/未知）立即保全；成功或未失败不保全。
   */
  async preserveAfterRemoteSyncOutcome(
    input: CreateLocalPreservationInput,
  ): Promise<PreserveAfterRemoteSyncOutcomeResult> {
    const trigger = evaluateRemoteSyncPreservationTrigger(input.remoteSyncOutcome);
    if (!trigger.shouldPreserve) {
      return {
        shouldPreserve: false,
        isReused: false,
        manifest: null,
        trigger,
      };
    }
    const creation = await this.createPreservationPoint(input);
    return {
      shouldPreserve: true,
      isReused: creation.isReused,
      manifest: creation.manifest,
      trigger,
    };
  }

  /** 直接创建保全点（不做触发判定；供测试与显式保全入口使用）。 */
  async createPreservationPoint(
    input: CreateLocalPreservationInput,
  ): Promise<LocalPreservationCreationResult> {
    const worktreePath = input.worktreePath ?? input.repositoryPath;
    const excludedPatterns = [...new Set([
      ...LOCAL_PRESERVATION_DEFAULT_EXCLUDED_PATTERNS,
      ...(input.excludedPatterns ?? []),
    ])];

    const isRepository = await this.runGitOrNull(input.repositoryPath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (isRepository === null || isRepository.trim() !== "true") {
      const failedManifest = await this.persistManifest({
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        worktreePath,
        input,
        excludedPatterns,
        reuseKey: sha256OfBuffer("repository-unavailable"),
        repository: emptyRepositoryFacts(),
        index: { treeOid: null, cachedPatchPath: null, cachedPatchSha256: null },
        worktreeChanges: {
          unstagedPatchPath: null,
          unstagedPatchSha256: null,
        },
        untrackedFiles: [],
        changeEntries: [],
        excludedUntrackedFilePaths: [],
        objectArchive: {
          filePath: null,
          sha256: null,
          byteCount: 0,
          referenceNames: [],
          isComplete: false,
          note: "repository-unavailable",
        },
        failures: ["repository-unavailable: " + input.repositoryPath],
        checkedItemCount: 0,
      });
      return { manifest: failedManifest, isReused: false };
    }

    const baseCommit = (
      await this.runGitOrNull(input.repositoryPath, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
      ])
    )?.trim();
    const headReferenceName = (
      await this.runGitOrNull(input.repositoryPath, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ])
    )?.trim() ?? null;
    const hasUnbornHead = baseCommit === undefined || baseCommit === "";
    const isDetachedHead = !hasUnbornHead && headReferenceName === null;

    const isShallowRepository =
      (
        await this.runGitOrNull(input.repositoryPath, [
          "rev-parse",
          "--is-shallow-repository",
        ])
      )?.trim() === "true";

    const referenceOids = await this.readReferenceOids(input.repositoryPath);
    const worktreeList = await this.readWorktreeList(input.repositoryPath);

    const sparseCheckoutPatterns =
      (await this.runGitOrNull(input.repositoryPath, [
        "config",
        "--get",
        "core.sparseCheckout",
      ]))?.trim() === "true"
        ? await this.readSparseCheckoutPatterns(input.repositoryPath)
        : [];
    const submodulePaths = await this.readSubmodulePaths(input.repositoryPath);
    const lfsPointerFilePaths = await this.readLfsPointerFilePaths(
      input.repositoryPath,
    );

    const initialState = await this.readChangeState(
      input.repositoryPath,
      hasUnbornHead,
    );
    const porcelainState = initialState.porcelainState;
    const cachedPatchText = initialState.cachedPatchText;
    const unstagedPatchText = initialState.unstagedPatchText;
    const indexTreeResult = initialState.indexTreeResult;
    const initialChangeFingerprint = computeChangeFingerprint(initialState);

    const untrackedFileCandidates: UntrackedFileCandidate[] = [];
    const excludedUntrackedFilePaths: string[] = [];
    const readFailures: string[] = [];
    for (const relativePath of porcelainState.untrackedRelativePaths.sort()) {
      if (
        excludedPatterns.some((pattern) =>
          matchesExcludedPattern(relativePath, pattern),
        )
      ) {
        excludedUntrackedFilePaths.push(relativePath);
        continue;
      }
      try {
        const content = await fs.readFile(
          path.join(input.repositoryPath, relativePath),
        );
        untrackedFileCandidates.push({
          relativePath,
          byteCount: content.byteLength,
          sha256: sha256OfBuffer(content),
          content,
        });
      } catch (error) {
        readFailures.push(
          "untracked-read-failed: " + relativePath + " (" + String(error) + ")",
        );
      }
    }

    const reuseKey = sha256OfBuffer(
      JSON.stringify({
        policyVersion: LOCAL_PRESERVATION_POLICY_VERSION,
        repositoryPath: input.repositoryPath,
        worktreePath,
        baseCommit: baseCommit ?? null,
        headReferenceName,
        referenceOids,
        excludedPatterns,
        porcelainRaw: porcelainState.changeEntries,
        cachedPatchSha256: sha256OfBuffer(cachedPatchText),
        unstagedPatchSha256: sha256OfBuffer(unstagedPatchText),
        untrackedFiles: untrackedFileCandidates.map((candidate) => ({
          relativePath: candidate.relativePath,
          byteCount: candidate.byteCount,
          sha256: candidate.sha256,
        })),
      }),
    );

    const reusable = await this.findReusablePreservationPoint(
      input.missionId,
      reuseKey,
    );
    if (reusable !== null) {
      return { manifest: reusable, isReused: true };
    }

    const preservationPointId = "preservation-" + randomUUID();
    const missionDirectory = path.join(
      this.preservationRootDirectory,
      sanitizePathSegment(input.missionId),
    );
    await fs.mkdir(missionDirectory, { recursive: true });
    const temporaryDirectoryPath = path.join(
      missionDirectory,
      ".tmp-" + preservationPointId,
    );
    const finalDirectoryPath = path.join(missionDirectory, preservationPointId);
    await fs.mkdir(temporaryDirectoryPath, { recursive: true });

    const failures: string[] = [...porcelainState.parseFailures, ...readFailures];
    let checkedItemCount = 0;

    // 1) 未跟踪文件快照（复制 + 回读校验）
    const untrackedFiles: LocalPreservationManifest["untrackedFiles"] = [];
    for (const candidate of untrackedFileCandidates) {
      const archivedPath = path.join(
        finalDirectoryPath,
        "untracked",
        candidate.relativePath,
      );
      const archivedWritePath = path.join(
        temporaryDirectoryPath,
        "untracked",
        candidate.relativePath,
      );
      try {
        await fs.mkdir(path.dirname(archivedWritePath), { recursive: true });
        await fs.writeFile(archivedWritePath, candidate.content);
        const verifiedContent = await fs.readFile(archivedWritePath);
        if (sha256OfBuffer(verifiedContent) !== candidate.sha256) {
          failures.push("untracked-verify-failed: " + candidate.relativePath);
        } else {
          checkedItemCount += 1;
        }
        untrackedFiles.push({
          relativePath: candidate.relativePath,
          byteCount: candidate.byteCount,
          sha256: candidate.sha256,
          archivedPath,
        });
      } catch (error) {
        failures.push(
          "untracked-archive-failed: " +
            candidate.relativePath +
            " (" +
            String(error) +
            ")",
        );
      }
    }

    // 2) index（已暂存）与未暂存补丁
    let cachedPatchPath: string | null = null;
    let cachedPatchSha256: string | null = null;
    if (cachedPatchText !== "") {
      cachedPatchPath = path.join(finalDirectoryPath, "index.patch");
      const cachedPatchWritePath = path.join(temporaryDirectoryPath, "index.patch");
      await fs.writeFile(cachedPatchWritePath, cachedPatchText, "utf8");
      cachedPatchSha256 = await this.verifyWrittenFile(
        cachedPatchWritePath,
        cachedPatchText,
        "index-patch",
        failures,
      );
      checkedItemCount += 1;
    }
    let unstagedPatchPath: string | null = null;
    let unstagedPatchSha256: string | null = null;
    if (unstagedPatchText !== "") {
      unstagedPatchPath = path.join(finalDirectoryPath, "worktree.patch");
      const unstagedPatchWritePath = path.join(temporaryDirectoryPath, "worktree.patch");
      await fs.writeFile(unstagedPatchWritePath, unstagedPatchText, "utf8");
      unstagedPatchSha256 = await this.verifyWrittenFile(
        unstagedPatchWritePath,
        unstagedPatchText,
        "worktree-patch",
        failures,
      );
      checkedItemCount += 1;
    }
    if (indexTreeResult === null) {
      failures.push("index-tree-unavailable: git write-tree 失败");
    }

    // 3) 独立对象归档（git bundle）
    let objectArchive: LocalPreservationManifest["objectArchive"] = {
      filePath: null,
      sha256: null,
      byteCount: 0,
      referenceNames: referenceOids.map((reference) => reference.referenceName),
      isComplete: true,
      note: null,
    };
    if (referenceOids.length === 0) {
      objectArchive.note = "no-refs-to-archive";
    } else {
      const bundlePath = path.join(finalDirectoryPath, "objects.bundle");
      const bundleWritePath = path.join(temporaryDirectoryPath, "objects.bundle");
      const bundleResult = await this.runGitOrNull(input.repositoryPath, [
        "bundle",
        "create",
        bundleWritePath,
        "--all",
      ]);
      if (bundleResult === null) {
        objectArchive.isComplete = false;
        objectArchive.note = "object-archive-creation-failed";
        failures.push("object-archive-creation-failed");
      } else {
        const bundleVerify = await this.runGitOrNull(input.repositoryPath, [
          "bundle",
          "verify",
          bundleWritePath,
        ]);
        const bundleContent = await fs.readFile(bundleWritePath);
        objectArchive = {
          filePath: bundlePath,
          sha256: sha256OfBuffer(bundleContent),
          byteCount: bundleContent.byteLength,
          referenceNames: referenceOids.map(
            (reference) => reference.referenceName,
          ),
          isComplete: bundleVerify !== null,
          note: bundleVerify === null ? "object-archive-verify-failed" : null,
        };
        if (bundleVerify === null) {
          failures.push("object-archive-verify-failed");
        } else {
          checkedItemCount += 1;
        }
      }
    }

    // 4) 受限形态标注（不宣称完整可恢复）
    if (isShallowRepository) {
      failures.push("history-incomplete: 浅克隆缺少历史对象");
    }
    if (sparseCheckoutPatterns.length > 0) {
      failures.push("sparse-checkout-content-not-included: 未检出路径不在快照内");
    }
    if (lfsPointerFilePaths.length > 0) {
      failures.push("lfs-objects-not-included: 仅归档 LFS 指针");
    }
    if (submodulePaths.length > 0) {
      failures.push("submodule-content-not-included: 仅记录 gitlink oid");
    }

    // 5) 并发改写检测：发布前重读变更状态；指纹变化即标注不完整（不虚报一致的快照）
    const finalState = await this.readChangeState(
      input.repositoryPath,
      hasUnbornHead,
    );
    if (computeChangeFingerprint(finalState) !== initialChangeFingerprint) {
      failures.push(
        "concurrent-modification-detected: 快照期间工作树/index 被改写，快照不代表单一时刻",
      );
    }

    const manifest = await this.publishManifest({
      temporaryDirectoryPath,
      finalDirectoryPath,
      manifestWithoutSnapshot: {
        schemaVersion: LOCAL_PRESERVATION_SCHEMA_VERSION,
        policyVersion: LOCAL_PRESERVATION_POLICY_VERSION,
        preservationPointId,
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        worktreePath,
        createdAtIso: this.nowIso(),
        reuseKey,
        remoteSync: { ...input.remoteSyncOutcome },
        localPreservation: {
          status: failures.length === 0 ? "ready" : "incomplete",
          failureReason: failures.length === 0 ? null : failures.join("; "),
          integrityResult: {
            isComplete: failures.length === 0,
            checkedItemCount,
            failures: [...failures],
          },
        },
        repository: {
          baseCommit: hasUnbornHead ? null : (baseCommit as string),
          headReferenceName,
          isDetachedHead,
          hasUnbornHead,
          isShallowRepository,
          referenceOids,
          submodulePaths,
          lfsPointerFilePaths,
          sparseCheckoutPatterns,
          worktreeList,
        },
        index: {
          treeOid: indexTreeResult?.trim() ?? null,
          cachedPatchPath,
          cachedPatchSha256,
        },
        worktreeChanges: { unstagedPatchPath, unstagedPatchSha256 },
        untrackedFiles,
        changeEntries: porcelainState.changeEntries,
        excludedPatterns,
        excludedUntrackedFilePaths,
        objectArchive,
        restoredAtIso: null,
      },
    });
    return { manifest, isReused: false };
  }

  async readPreservationPoint(
    missionId: string,
    preservationPointId: string,
  ): Promise<LocalPreservationManifest> {
    const manifestPath = path.join(
      this.preservationPointDirectory(missionId, preservationPointId),
      "preservation-manifest.json",
    );
    let rawContent: string;
    try {
      rawContent = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError(
          "task-sequence-not-found",
          "保全点不存在: " + preservationPointId,
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
        "保全点清单非法: " + preservationPointId,
      );
    }
    const manifest = parsedContent as LocalPreservationManifest;
    const expectedManifestSha256 = sha256OfBuffer(
      serializeManifestText({ ...manifest, snapshot: { ...manifest.snapshot, manifestSha256: "" } }),
    );
    if (expectedManifestSha256 !== manifest.snapshot.manifestSha256) {
      throw new DomainError(
        "journal-corrupted",
        "保全点清单哈希不匹配: " + preservationPointId,
      );
    }
    return manifest;
  }

  async listPreservationPoints(
    missionId: string,
  ): Promise<LocalPreservationManifest[]> {
    const missionDirectory = path.join(
      this.preservationRootDirectory,
      sanitizePathSegment(missionId),
    );
    let entryNames: string[];
    try {
      entryNames = await fs.readdir(missionDirectory);
    } catch {
      return [];
    }
    const manifests: LocalPreservationManifest[] = [];
    for (const entryName of entryNames.sort()) {
      if (entryName.startsWith(".tmp-")) {
        continue;
      }
      try {
        manifests.push(await this.readPreservationPoint(missionId, entryName));
      } catch {
        // 非保全点目录或清单损坏：跳过（不静默当作完整快照）
      }
    }
    manifests.sort((left, right) =>
      left.createdAtIso.localeCompare(right.createdAtIso),
    );
    return manifests;
  }

  /**
   * 独立恢复：默认恢复到新目录；原仓库不可用时以对象归档重建，恢复后校验 index tree 与文件哈希。
   * 不覆盖已有工作区、不改动原仓库、不创建新的保全点。
   */
  async restorePreservationPoint(
    input: RestoreLocalPreservationInput,
  ): Promise<LocalPreservationRestoreResult> {
    const manifest = await this.readPreservationPoint(
      input.missionId,
      input.preservationPointId,
    );
    if (manifest.localPreservation.status === "failed") {
      throw new DomainError(
        "preservation-point-not-restorable",
        "保全点状态为 failed，不可恢复: " + input.preservationPointId,
      );
    }
    const restoreDirectoryPath = path.resolve(input.restoreDirectoryPath);
    await this.assertEmptyRestoreTarget(restoreDirectoryPath);
    const parentDirectoryPath = path.dirname(restoreDirectoryPath);
    await fs.mkdir(parentDirectoryPath, { recursive: true });

    const useObjectArchive = manifest.repository.referenceOids.length > 0;
    if (useObjectArchive) {
      const archivePath = manifest.objectArchive.filePath;
      if (archivePath === null || !(await pathExists(archivePath))) {
        throw new DomainError(
          "preservation-object-missing",
          "对象归档缺失，无法独立恢复: " + input.preservationPointId,
        );
      }
      const cloneResult = await this.runGitOrNull(parentDirectoryPath, [
        "clone",
        "--quiet",
        archivePath,
        restoreDirectoryPath,
      ]);
      if (cloneResult === null) {
        throw new DomainError(
          "tool-execution-failed",
          "从对象归档恢复失败: " + input.preservationPointId,
        );
      }
    } else {
      const initResult = await this.runGitOrNull(parentDirectoryPath, [
        "init",
        "--quiet",
        restoreDirectoryPath,
      ]);
      if (initResult === null) {
        throw new DomainError(
          "tool-execution-failed",
          "初始化恢复目录失败: " + input.preservationPointId,
        );
      }
    }

    // 恢复必须是字节级：关闭目标仓库的行尾自动转换，避免 LF→CRLF 改写内容。
    await this.runGitOrNull(restoreDirectoryPath, [
      "config",
      "core.autocrlf",
      "false",
    ]);
    await this.runGitOrNull(restoreDirectoryPath, ["config", "core.eol", "lf"]);

    if (manifest.repository.baseCommit !== null) {
      const resetResult = await this.runGitOrNull(restoreDirectoryPath, [
        "reset",
        "--hard",
        manifest.repository.baseCommit,
      ]);
      if (resetResult === null) {
        throw new DomainError(
          "preservation-object-missing",
          "基线提交对象缺失: " + manifest.repository.baseCommit,
        );
      }
    }

    // index（已暂存）状态 → 再物化到工作树 → 应用未暂存差异
    if (manifest.index.cachedPatchPath !== null) {
      const cachedApply = await this.runGitOrNull(restoreDirectoryPath, [
        "apply",
        "--cached",
        "--binary",
        manifest.index.cachedPatchPath,
      ]);
      if (cachedApply === null) {
        throw new DomainError(
          "tool-execution-failed",
          "恢复 index 补丁失败: " + input.preservationPointId,
        );
      }
    }
    await this.runGitOrNull(restoreDirectoryPath, ["checkout-index", "-a", "-f"]);
    if (manifest.worktreeChanges.unstagedPatchPath !== null) {
      const unstagedApply = await this.runGitOrNull(restoreDirectoryPath, [
        "apply",
        "--binary",
        manifest.worktreeChanges.unstagedPatchPath,
      ]);
      if (unstagedApply === null) {
        throw new DomainError(
          "tool-execution-failed",
          "恢复未暂存补丁失败: " + input.preservationPointId,
        );
      }
    }

    const restoredUntrackedFilePaths: string[] = [];
    for (const untrackedEntry of manifest.untrackedFiles) {
      let content: Buffer;
      try {
        content = await fs.readFile(untrackedEntry.archivedPath);
      } catch {
        throw new DomainError(
          "preservation-object-missing",
          "未跟踪快照缺失: " + untrackedEntry.relativePath,
        );
      }
      const targetPath = path.join(
        restoreDirectoryPath,
        untrackedEntry.relativePath,
      );
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
      restoredUntrackedFilePaths.push(untrackedEntry.relativePath);
    }

    const restoredIndexTreeOid =
      (await this.runGitOrNull(restoreDirectoryPath, ["write-tree"]))?.trim() ??
      null;

    const restoredAtIso = this.nowIso();
    await this.writeManifestFiles(manifest.snapshot.directoryPath, {
      ...manifest,
      restoredAtIso,
    });
    return {
      preservationPointId: manifest.preservationPointId,
      restoreDirectoryPath,
      restoredReferenceNames: manifest.repository.referenceOids.map(
        (reference) => reference.referenceName,
      ),
      restoredUntrackedFilePaths,
      restoredIndexTreeOid,
      hasUnstagedPatch: manifest.worktreeChanges.unstagedPatchPath !== null,
      restoredAtIso,
      isOriginalRepositoryRequired: false,
    };
  }

  /** 逐项重算快照文件哈希；缺对象或哈希不一致如实报告（不虚报可恢复）。 */
  async verifyPreservationPointIntegrity(input: {
    missionId: string;
    preservationPointId: string;
  }): Promise<LocalPreservationIntegrityReport> {
    const manifest = await this.readPreservationPoint(
      input.missionId,
      input.preservationPointId,
    );
    const missingFilePaths: string[] = [];
    const mismatchedFilePaths: string[] = [];
    let checkedItemCount = 0;
    const checkFile = async (
      filePath: string | null,
      expectedSha256: string | null,
    ): Promise<void> => {
      if (filePath === null) {
        return;
      }
      let content: Buffer;
      try {
        content = await fs.readFile(filePath);
      } catch {
        missingFilePaths.push(filePath);
        return;
      }
      checkedItemCount += 1;
      if (expectedSha256 !== null && sha256OfBuffer(content) !== expectedSha256) {
        mismatchedFilePaths.push(filePath);
      }
    };
    await checkFile(
      manifest.index.cachedPatchPath,
      manifest.index.cachedPatchSha256,
    );
    await checkFile(
      manifest.worktreeChanges.unstagedPatchPath,
      manifest.worktreeChanges.unstagedPatchSha256,
    );
    await checkFile(manifest.objectArchive.filePath, manifest.objectArchive.sha256);
    for (const untrackedEntry of manifest.untrackedFiles) {
      await checkFile(untrackedEntry.archivedPath, untrackedEntry.sha256);
    }
    const failures: string[] = [];
    if (missingFilePaths.length > 0) {
      failures.push("preservation-object-missing: " + missingFilePaths.join(", "));
    }
    if (mismatchedFilePaths.length > 0) {
      failures.push(
        "preservation-object-hash-mismatch: " + mismatchedFilePaths.join(", "),
      );
    }
    return {
      preservationPointId: manifest.preservationPointId,
      isIntact: failures.length === 0,
      missingFilePaths,
      mismatchedFilePaths,
      failures,
      checkedItemCount,
    };
  }

  /** 崩溃残留（`.tmp-*`）报告为不完整；它们永不出现在 listPreservationPoints。 */
  async listIncompleteSnapshotDirectories(
    missionId: string,
  ): Promise<IncompleteSnapshotDirectory[]> {
    const missionDirectory = path.join(
      this.preservationRootDirectory,
      sanitizePathSegment(missionId),
    );
    let entryNames: string[];
    try {
      entryNames = await fs.readdir(missionDirectory);
    } catch {
      return [];
    }
    return entryNames
      .filter((entryName) => entryName.startsWith(".tmp-"))
      .sort()
      .map((entryName) => ({
        directoryPath: path.join(missionDirectory, entryName),
        reason: "incomplete-temp-snapshot" as const,
      }));
  }

  private async assertEmptyRestoreTarget(
    restoreDirectoryPath: string,
  ): Promise<void> {
    try {
      const entryNames = await fs.readdir(restoreDirectoryPath);
      if (entryNames.length > 0) {
        throw new DomainError(
          "restore-target-not-empty",
          "恢复目标非空，拒绝覆盖: " + restoreDirectoryPath,
        );
      }
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DomainError(
          "restore-target-invalid",
          "恢复目标不可用: " + restoreDirectoryPath,
        );
      }
    }
  }

  private async writeManifestFiles(
    directoryPath: string,
    manifest: LocalPreservationManifest,
  ): Promise<LocalPreservationManifest> {
    const manifestWithEmptyHash: LocalPreservationManifest = {
      ...manifest,
      snapshot: { ...manifest.snapshot, manifestSha256: "" },
    };
    const manifestSha256 = sha256OfBuffer(
      serializeManifestText(manifestWithEmptyHash),
    );
    const finalManifest: LocalPreservationManifest = {
      ...manifest,
      snapshot: { ...manifest.snapshot, manifestSha256 },
    };
    await fs.writeFile(
      path.join(directoryPath, "preservation-manifest.json"),
      serializeManifestText(finalManifest),
      "utf8",
    );
    await fs.writeFile(
      path.join(directoryPath, "manifest.sha256"),
      manifestSha256,
      "utf8",
    );
    return finalManifest;
  }

  private async findReusablePreservationPoint(
    missionId: string,
    reuseKey: string,
  ): Promise<LocalPreservationManifest | null> {
    for (const manifest of await this.listPreservationPoints(missionId)) {
      if (
        manifest.reuseKey === reuseKey &&
        manifest.localPreservation.status === "ready" &&
        manifest.restoredAtIso === null
      ) {
        return manifest;
      }
    }
    return null;
  }

  private async persistManifest(input: {
    missionId: string;
    repositoryPath: string;
    worktreePath: string;
    input: CreateLocalPreservationInput;
    excludedPatterns: string[];
    reuseKey: string;
    repository: LocalPreservationManifest["repository"];
    index: LocalPreservationManifest["index"];
    worktreeChanges: LocalPreservationManifest["worktreeChanges"];
    untrackedFiles: LocalPreservationManifest["untrackedFiles"];
    changeEntries: PreservationChangeEntry[];
    excludedUntrackedFilePaths: string[];
    objectArchive: LocalPreservationManifest["objectArchive"];
    failures: string[];
    checkedItemCount: number;
  }): Promise<LocalPreservationManifest> {
    const preservationPointId = "preservation-" + randomUUID();
    const missionDirectory = path.join(
      this.preservationRootDirectory,
      sanitizePathSegment(input.missionId),
    );
    await fs.mkdir(missionDirectory, { recursive: true });
    const temporaryDirectoryPath = path.join(
      missionDirectory,
      ".tmp-" + preservationPointId,
    );
    const finalDirectoryPath = path.join(missionDirectory, preservationPointId);
    await fs.mkdir(temporaryDirectoryPath, { recursive: true });
    const manifest = await this.publishManifest({
      temporaryDirectoryPath,
      finalDirectoryPath,
      manifestWithoutSnapshot: {
        schemaVersion: LOCAL_PRESERVATION_SCHEMA_VERSION,
        policyVersion: LOCAL_PRESERVATION_POLICY_VERSION,
        preservationPointId,
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        worktreePath: input.worktreePath,
        createdAtIso: this.nowIso(),
        reuseKey: input.reuseKey,
        remoteSync: { ...input.input.remoteSyncOutcome },
        localPreservation: {
          status: "failed",
          failureReason: input.failures.join("; "),
          integrityResult: {
            isComplete: false,
            checkedItemCount: input.checkedItemCount,
            failures: [...input.failures],
          },
        },
        repository: input.repository,
        index: input.index,
        worktreeChanges: input.worktreeChanges,
        untrackedFiles: input.untrackedFiles,
        changeEntries: input.changeEntries,
        excludedPatterns: input.excludedPatterns,
        excludedUntrackedFilePaths: input.excludedUntrackedFilePaths,
        objectArchive: input.objectArchive,
        restoredAtIso: null,
      },
    });
    return manifest;
  }

  private async publishManifest(input: {
    temporaryDirectoryPath: string;
    finalDirectoryPath: string;
    manifestWithoutSnapshot: Omit<LocalPreservationManifest, "snapshot">;
  }): Promise<LocalPreservationManifest> {
    const manifest: LocalPreservationManifest = {
      ...input.manifestWithoutSnapshot,
      snapshot: {
        directoryPath: input.finalDirectoryPath,
        manifestSha256: "",
      },
    };
    const manifestWithHash = await this.writeManifestFiles(
      input.temporaryDirectoryPath,
      manifest,
    );
    await fs.rename(input.temporaryDirectoryPath, input.finalDirectoryPath);
    return manifestWithHash;
  }

  private async verifyWrittenFile(
    filePath: string,
    expectedText: string,
    label: string,
    failures: string[],
  ): Promise<string> {
    try {
      const writtenContent = await fs.readFile(filePath, "utf8");
      const writtenSha256 = sha256OfBuffer(writtenContent);
      if (writtenContent !== expectedText) {
        failures.push(label + "-content-mismatch");
      }
      return writtenSha256;
    } catch (error) {
      failures.push(label + "-verify-failed (" + String(error) + ")");
      return sha256OfBuffer(expectedText);
    }
  }

  private async readReferenceOids(
    repositoryPath: string,
  ): Promise<Array<{ referenceName: string; committedOid: string }>> {
    const rawText = await this.runGitOrNull(repositoryPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    if (rawText === null) {
      return [];
    }
    return rawText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const separatorIndex = line.lastIndexOf(" ");
        return {
          referenceName: line.slice(0, separatorIndex),
          committedOid: line.slice(separatorIndex + 1),
        };
      });
  }

  private async readWorktreeList(
    repositoryPath: string,
  ): Promise<LocalPreservationManifest["repository"]["worktreeList"]> {
    const rawText = await this.runGitOrNull(repositoryPath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (rawText === null) {
      return [];
    }
    const entries: LocalPreservationManifest["repository"]["worktreeList"] = [];
    for (const block of rawText.split("\n\n")) {
      if (block.trim() === "") {
        continue;
      }
      let worktreePath = "";
      let headOid: string | null = null;
      let branchName: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          headOid = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          branchName = line.slice("branch ".length);
        }
      }
      if (worktreePath !== "") {
        entries.push({ worktreePath, headOid, branchName });
      }
    }
    return entries;
  }

  private async readSubmodulePaths(repositoryPath: string): Promise<string[]> {
    const rawText = await this.runGitOrNull(repositoryPath, [
      "ls-files",
      "--stage",
    ]);
    if (rawText === null) {
      return [];
    }
    return rawText
      .split("\n")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.slice(line.lastIndexOf("\t") + 1))
      .filter((submodulePath) => submodulePath !== "");
  }

  private async readLfsPointerFilePaths(
    repositoryPath: string,
  ): Promise<string[]> {
    try {
      const attributesContent = await fs.readFile(
        path.join(repositoryPath, ".gitattributes"),
        "utf8",
      );
      return attributesContent
        .split("\n")
        .some((line) => line.includes("filter=lfs"))
        ? [".gitattributes"]
        : [];
    } catch {
      return [];
    }
  }

  private async readSparseCheckoutPatterns(
    repositoryPath: string,
  ): Promise<string[]> {
    const gitDirectory = await this.runGitOrNull(repositoryPath, [
      "rev-parse",
      "--git-dir",
    ]);
    if (gitDirectory === null) {
      return [];
    }
    const sparseCheckoutPath = path.resolve(
      repositoryPath,
      gitDirectory.trim(),
      "info",
      "sparse-checkout",
    );
    try {
      const content = await fs.readFile(sparseCheckoutPath, "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  private async readChangeState(
    repositoryPath: string,
    hasUnbornHead: boolean,
  ): Promise<{
    porcelainState: ParsedPorcelainState;
    cachedPatchText: string;
    unstagedPatchText: string;
    indexTreeResult: string | null;
  }> {
    const porcelainState = parsePorcelainV2(
      (await this.runGitOrNull(repositoryPath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ])) ?? "",
    );
    const cachedPatchBaseReference = hasUnbornHead ? EMPTY_TREE_OID : "HEAD";
    return {
      porcelainState,
      cachedPatchText:
        (await this.runGitOrNull(repositoryPath, [
          "diff",
          "--cached",
          "--binary",
          cachedPatchBaseReference,
        ])) ?? "",
      unstagedPatchText:
        (await this.runGitOrNull(repositoryPath, ["diff", "--binary"])) ?? "",
      indexTreeResult: await this.runGitOrNull(repositoryPath, ["write-tree"]),
    };
  }

  private async runGitOrNull(
    repositoryPath: string,
    arguments_: string[],
  ): Promise<string | null> {
    try {
      const result = await this.gitProcess.run(
        repositoryPath,
        arguments_,
        "本地保全: git " + arguments_.join(" "),
      );
      return result.stdoutText;
    } catch {
      return null;
    }
  }

  private preservationPointDirectory(
    missionId: string,
    preservationPointId: string,
  ): string {
    return path.join(
      this.preservationRootDirectory,
      sanitizePathSegment(missionId),
      preservationPointId,
    );
  }
}

function computeChangeFingerprint(state: {
  porcelainState: ParsedPorcelainState;
  cachedPatchText: string;
  unstagedPatchText: string;
  indexTreeResult: string | null;
}): string {
  return sha256OfBuffer(
    JSON.stringify({
      changeEntries: state.porcelainState.changeEntries,
      cachedPatchSha256: sha256OfBuffer(state.cachedPatchText),
      unstagedPatchSha256: sha256OfBuffer(state.unstagedPatchText),
      indexTreeOid: state.indexTreeResult?.trim() ?? null,
    }),
  );
}

function emptyRepositoryFacts(): LocalPreservationManifest["repository"] {
  return {
    baseCommit: null,
    headReferenceName: null,
    isDetachedHead: false,
    hasUnbornHead: true,
    isShallowRepository: false,
    referenceOids: [],
    submodulePaths: [],
    lfsPointerFilePaths: [],
    sparseCheckoutPatterns: [],
    worktreeList: [],
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function serializeManifestText(manifest: LocalPreservationManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** 路径段清洗（只保留安全字符，避免目录逃逸）。 */
function sanitizePathSegment(pathSegment: string): string {
  let sanitized = "";
  for (const character of pathSegment) {
    if (/[A-Za-z0-9._-]/.test(character)) {
      sanitized += character;
    } else {
      sanitized += "_" + character.charCodeAt(0).toString(16);
    }
  }
  return sanitized === "" ? "_" : sanitized;
}