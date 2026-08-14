/**
 * 反自指读取账本（T07B / ADR-0017 §重复读取时间锁）。
 * 同一调用源（agentInstanceId + taskExecutionId）在窗口内再次请求已完整
 * 覆盖且未变化的同一资源时，拒绝返回正文，只返回 resource-already-read、
 * 读取回执与 retryAfterMilliseconds。
 *
 * - 键：agentInstanceId + taskExecutionId + canonicalResourceIdentity
 *   + operationKind + normalizedRange + parameterHash；
 * - 单调时钟（可注入 fake clock），不信任模型提供的时间；
 * - 保存文件身份（dev:ino + realpath）与内容指纹（sha256），
 *   未变化才抑制；文件真实变化可立即重读；
 * - 敏感内容禁读优先于时间锁（敏感文件先拒绝，不登记）。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";

import { DomainError } from "../core/errors.js";
import { SensitiveResourceIdentityResolver } from "./sensitive-content-access-policy.js";

/** 默认未变化读取抑制窗口（毫秒）。 */
export const UNCHANGED_READ_SUPPRESSION_WINDOW_MILLISECONDS = 30_000;

export type ReadOperationKind = "read" | "list" | "search" | "git-view";

export interface ReadSuppressionLedgerOptions {
  /** 单调时钟（毫秒）；测试注入 fake clock。 */
  nowUnixMilliseconds?: () => number;
  /** 未变化读取抑制窗口（毫秒）。 */
  unchangedReadSuppressionWindowMilliseconds?: number;
}

export interface ReadSuppressionEntry {
  readReceiptId: string;
  recordedAtUnixMilliseconds: number;
  resourceIdentity: {
    realPath: string;
    deviceInode: string;
    normalizedCasePath: string;
  };
  contentFingerprint: string | null;
  normalizedRange: string;
}

export interface QueryReadSuppressionInput {
  agentInstanceId: string;
  taskExecutionId: string | null;
  canonicalPath: string;
  operationKind: ReadOperationKind;
  normalizedRange: string;
  /** 规范化后的影响读取范围参数哈希（路径/范围），忽略无意义参数。 */
  parameterHash: string;
}

export interface ReadSuppressionDecision {
  isSuppressed: boolean;
  readReceiptId: string | null;
  firstReadAtUnixMilliseconds: number | null;
  retryAfterMilliseconds: number;
}

export interface RegisterReadInput extends QueryReadSuppressionInput {
  contentFingerprint: string | null;
}

/**
 * 规范资源身份解析器：合并相对/绝对路径、平台大小写、符号链接/联接点与
 * 硬链接身份，返回同一资源的稳定标识。
 */
export class CanonicalResourceIdentityResolver {
  private readonly sensitiveIdentityResolver = new SensitiveResourceIdentityResolver();

  /**
   * 解析规范身份；解析失败（非 ENOENT）时抛错（fail-closed）。
   * 路径不存在时回退词法规范化身份。
   */
  async resolveIdentity(canonicalPath: string): Promise<{
    realPath: string;
    deviceInode: string;
    normalizedCasePath: string;
  }> {
    const identity = await this.sensitiveIdentityResolver.resolveIdentity(
      canonicalPath,
    );
    return {
      realPath: identity.realPath ?? path.resolve(canonicalPath),
      deviceInode: identity.deviceInode ?? "unknown",
      normalizedCasePath: identity.normalizedCasePath,
    };
  }

  /** 当前文件身份与内容指纹（未变化判定用）。 */
  async currentFingerprint(canonicalPath: string): Promise<{
    deviceInode: string;
    contentFingerprint: string;
  } | null> {
    try {
      const fileStat = await stat(canonicalPath);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(canonicalPath, "utf8").catch(() => null);
      if (content === null) {
        return null;
      }
      return {
        deviceInode: `${fileStat.dev}:${fileStat.ino}`,
        contentFingerprint: `sha256:${sha256(content)}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

export class ReadSuppressionLedger {
  private readonly entries = new Map<string, ReadSuppressionEntry>();
  private readonly nowUnixMilliseconds: () => number;
  private readonly windowMilliseconds: number;
  private readonly identityResolver = new CanonicalResourceIdentityResolver();

  constructor(options: ReadSuppressionLedgerOptions = {}) {
    this.nowUnixMilliseconds =
      options.nowUnixMilliseconds ?? (() => Date.now());
    this.windowMilliseconds =
      options.unchangedReadSuppressionWindowMilliseconds ??
      UNCHANGED_READ_SUPPRESSION_WINDOW_MILLISECONDS;
  }

  private buildKey(
    input: QueryReadSuppressionInput,
    identity: {
      normalizedCasePath: string;
    },
  ): string {
    return [
      input.agentInstanceId,
      input.taskExecutionId ?? "",
      identity.normalizedCasePath,
      input.operationKind,
      input.normalizedRange,
      // 参数哈希基于规范身份派生：路径别名/大小写/无关参数不能改变键
      sha256(identity.normalizedCasePath),
    ].join("|");
  }

  /**
   * 查询抑制决定：窗口内存在同源同资源记录且文件未变化 → 抑制；
   * 文件已变化 → 清除旧记录放行。
   * 键使用规范身份（realpath + 大小写折叠），路径别名/大小写变体不能绕过。
   */
  async querySuppression(
    input: QueryReadSuppressionInput,
  ): Promise<ReadSuppressionDecision> {
    const identity = await this.identityResolver.resolveIdentity(
      input.canonicalPath,
    );
    const key = this.buildKey(input, {
      normalizedCasePath: identity.normalizedCasePath,
    });
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return {
        isSuppressed: false,
        readReceiptId: null,
        firstReadAtUnixMilliseconds: null,
        retryAfterMilliseconds: 0,
      };
    }
    const elapsedMilliseconds =
      this.nowUnixMilliseconds() - entry.recordedAtUnixMilliseconds;
    if (elapsedMilliseconds >= this.windowMilliseconds) {
      return {
        isSuppressed: false,
        readReceiptId: null,
        firstReadAtUnixMilliseconds: null,
        retryAfterMilliseconds: 0,
      };
    }
    // 窗口内：本地验证文件身份与内容指纹是否变化（不返回正文）
    const currentFingerprint =
      await this.identityResolver.currentFingerprint(input.canonicalPath);
    if (
      currentFingerprint === null ||
      currentFingerprint.deviceInode !== entry.resourceIdentity.deviceInode ||
      (entry.contentFingerprint !== null &&
        currentFingerprint.contentFingerprint !== entry.contentFingerprint)
    ) {
      // 文件真实变化：允许重读，移除旧记录
      this.entries.delete(key);
      return {
        isSuppressed: false,
        readReceiptId: null,
        firstReadAtUnixMilliseconds: null,
        retryAfterMilliseconds: 0,
      };
    }
    return {
      isSuppressed: true,
      readReceiptId: entry.readReceiptId,
      firstReadAtUnixMilliseconds: entry.recordedAtUnixMilliseconds,
      retryAfterMilliseconds: this.windowMilliseconds - elapsedMilliseconds,
    };
  }

  /** 登记一次成功读取（覆盖范围 + 内容指纹）。 */
  async registerRead(input: RegisterReadInput): Promise<string> {
    const identity = await this.identityResolver.resolveIdentity(
      input.canonicalPath,
    );
    const readReceiptId = `receipt-${sha256(
      `${input.agentInstanceId}|${input.taskExecutionId ?? ""}|${identity.normalizedCasePath}|${this.nowUnixMilliseconds()}`,
    ).slice(0, 16)}`;
    this.entries.set(
      this.buildKey(input, {
        normalizedCasePath: identity.normalizedCasePath,
      }),
      {
        readReceiptId,
        recordedAtUnixMilliseconds: this.nowUnixMilliseconds(),
        resourceIdentity: identity,
        contentFingerprint: input.contentFingerprint,
        normalizedRange: input.normalizedRange,
      },
    );
    return readReceiptId;
  }

  /** 测试：当前账本大小（验证键隔离）。 */
  getEntryCount(): number {
    return this.entries.size;
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 构建 readFile 的规范化参数哈希（只含影响读取范围的参数）。 */
export function buildReadParameterHash(canonicalPath: string): string {
  return sha256(canonicalPath);
}

/** 构造时间锁拒绝（resource-already-read）。 */
export function buildReadSuppressionDenial(input: {
  readReceiptId: string;
  firstReadAtUnixMilliseconds: number;
  retryAfterMilliseconds: number;
}): DomainError {
  return new DomainError(
    "resource-already-read",
    JSON.stringify({
      errorCode: "resource-already-read",
      readReceiptId: input.readReceiptId,
      firstReadAtUnixMilliseconds: input.firstReadAtUnixMilliseconds,
      retryAfterMilliseconds: input.retryAfterMilliseconds,
      hint: "内容未变化；可等待 retryAfterMilliseconds 后重读，或读取尚未覆盖的新范围",
    }),
  );
}
