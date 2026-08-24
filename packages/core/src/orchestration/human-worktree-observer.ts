/**
 * 人工工作树观察器与变化 journal（T05D-02 / ADR-0028 §2/§3）。
 *
 * - 只读观察人工工作树：当前分支/HEAD 提交、工作树变化路径、规范资源
 *   指纹（sha256）；绝不修改人工文件；
 * - 与上次观察比对生成 HumanChangeObservation（认证用户来源由本地
 *   控制面注入；模型不能伪造）；
 * - 变化 journal 持久化：重启后读取历史观察（可重放、不丢失）。
 *
 * 人工未提交修改、已提交修改、切分支、rebase、reset 与重命名均通过
 * 分支/HEAD/路径/指纹的组合形成明确观察结果。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { sanitizePathSegment } from "./work-archive-store.js";
import { humanChangeObservationSchema } from "./human-agent-concurrent-change-schemas.js";
import type { HumanChangeObservation } from "./human-agent-concurrent-change-schemas.js";

/** 人工工作树状态端口（装配方接入真实 git；测试可注入）。 */
export interface HumanWorktreeStatusPort {
  readStatus(): Promise<{
    branchName: string;
    headCommitIdentifier: string;
    changedPaths: string[];
  }>;
}

/** 文件内容规范指纹端口（sha256；不修改文件）。 */
export interface HumanFileFingerprintPort {
  computeFingerprint(filePath: string): Promise<string>;
}

/** 基于文件内容计算的 sha256 指纹（标准实现）。 */
export class Sha256FileFingerprinter implements HumanFileFingerprintPort {
  async computeFingerprint(filePath: string): Promise<string> {
    const rawContent = await fs.readFile(filePath);
    const hash = createHash("sha256").update(rawContent).digest("hex");
    return `sha256:${hash}`;
  }
}

export interface HumanWorktreeObserverOptions {
  statusPort: HumanWorktreeStatusPort;
  fingerprintPort: HumanFileFingerprintPort;
  /** 认证用户来源（本地控制面注入；模型不能填写）。 */
  authenticatedUserSourceIdentifier: string;
  /** 观察 journal 存储目录（<base>/human-change-journal）。 */
  journalBaseDirectory: string;
}

export interface WorktreeObservationResult {
  /** 与上次观察相比的当前状态（无变化时 changedPaths 为空）。 */
  observation: HumanChangeObservation;
  hasChangesSinceLastObservation: boolean;
}

export class HumanWorktreeObserver {
  private readonly statusPort: HumanWorktreeStatusPort;
  private readonly fingerprintPort: HumanFileFingerprintPort;
  private readonly authenticatedUserSourceIdentifier: string;
  private readonly journalRootDirectory: string;
  private readonly observationsByKey = new Map<string, HumanChangeObservation>();

  constructor(options: HumanWorktreeObserverOptions) {
    this.statusPort = options.statusPort;
    this.fingerprintPort = options.fingerprintPort;
    this.authenticatedUserSourceIdentifier =
      options.authenticatedUserSourceIdentifier;
    this.journalRootDirectory = path.join(
      options.journalBaseDirectory,
      "human-change-journal",
    );
  }

  private journalFilePath(observationIdentifier: string): string {
    return path.join(
      this.journalRootDirectory,
      `${sanitizePathSegment(observationIdentifier)}.json`,
    );
  }

  /** 从 journal 读取历史观察（重启可重放）。 */
  async readHistoricalObservation(
    observationIdentifier: string,
  ): Promise<HumanChangeObservation | null> {
    try {
      const rawContent = await fs.readFile(
        this.journalFilePath(observationIdentifier),
        "utf8",
      );
      const parsed = humanChangeObservationSchema.safeParse(
        JSON.parse(rawContent),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * 观察人工工作树：读取状态与变化路径指纹，与上次观察比对，
   * 生成带认证用户来源的观察记录并持久化（journal 追加）。
   * 只读：不修改任何人工文件。
   */
  async observeWorktree(input: {
    observationIdentifier: string;
    nowIso: string;
  }): Promise<WorktreeObservationResult> {
    const status = await this.statusPort.readStatus();
    const fingerprintByPath: Record<string, string> = {};
    for (const changedPath of status.changedPaths) {
      try {
        fingerprintByPath[changedPath] =
          await this.fingerprintPort.computeFingerprint(changedPath);
      } catch {
        // 文件被删除/重命名：该路径不记录指纹（重命名/删除可观察）
      }
    }
    const previousObservation = this.observationsByKey.get(
      this.observationKey(status.branchName, status.headCommitIdentifier),
    );
    let observationRevision = 1;
    if (previousObservation !== null && previousObservation !== undefined) {
      observationRevision = previousObservation.observationRevision + 1;
    }
    const observation: HumanChangeObservation = {
      schemaVersion: 1,
      observationIdentifier: input.observationIdentifier,
      authenticatedUserSourceIdentifier: this.authenticatedUserSourceIdentifier,
      observedCommitIdentifier: status.headCommitIdentifier,
      changedPaths: status.changedPaths,
      changedResourceFingerprintsByPath: fingerprintByPath,
      observedAtIso: input.nowIso,
      observationRevision,
    };
    const parsed = humanChangeObservationSchema.safeParse(observation);
    if (!parsed.success) {
      throw new Error(`人工变化观察非法: ${parsed.error.message}`);
    }
    this.observationsByKey.set(
      this.observationKey(status.branchName, status.headCommitIdentifier),
      parsed.data,
    );
    // journal 持久化（重启可重放）
    await fs.mkdir(this.journalRootDirectory, { recursive: true });
    await fs.writeFile(
      this.journalFilePath(input.observationIdentifier),
      `${JSON.stringify(parsed.data, null, 2)}\n`,
      "utf8",
    );
    const hasChangesSinceLastObservation =
      status.changedPaths.length > 0;
    return { observation: parsed.data, hasChangesSinceLastObservation };
  }

  private observationKey(branchName: string, headCommitIdentifier: string): string {
    return `${branchName}@${headCommitIdentifier}`;
  }
}