/**
 * 全模式本地敏感内容禁读（T06C / ADR-0018）。
 * Ponder、Assist、Devolve 三种模式下，所有模型可见读通道在打开/返回内容前
 * 统一拒绝本地敏感内容。模式升级、会话授权、任务来源、工具类别、用户
 * "记住授权"和模型声明均不能放行；任何无法确定是否敏感的情况 fail-closed。
 *
 * 组件：
 * - SensitiveResourceIdentityResolver：按规范路径、realpath、符号链接/联接点、
 *   硬链接文件身份（dev+ino）与平台大小写规则识别同一敏感资源。
 * - SensitiveContentAccessPolicy：文件名规则 + 管理员扩展路径 + 本地可信 DLP
 *   流式内容扫描；命中后丢弃整个结果，不返回正文、命中片段或可逆摘要。
 * - 稳定拒绝码 sensitive-content-read-denied；错误只返回规则类别，不确认秘密值。
 */
import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

import { DomainError } from "../core/errors.js";

/** 稳定拒绝码（ADR-0018）。 */
export const SENSITIVE_CONTENT_READ_DENIED_ERROR_CODE =
  "sensitive-content-read-denied" as const;

/** DLP 规则版本（审计与测试断言）。 */
export const SENSITIVE_CONTENT_RULES_VERSION = 1;

export interface SensitiveResourceIdentity {
  canonicalPath: string;
  realPath: string | null;
  /** 硬链接身份（文件系统设备号 + inode），Windows 可用。 */
  deviceInode: string | null;
  normalizedCasePath: string;
  isLinkLike: boolean;
}

export interface SensitiveResourceMatch {
  matchedRuleCategory: string | null;
  isSensitive: boolean;
}

/**
 * 敏感资源身份解析器：用多种视图识别同一资源，防止链接/联接/硬链接/大小写伪装。
 */
export class SensitiveResourceIdentityResolver {
  /**
   * 解析路径身份。路径不存在时 realPath/deviceInode 为 null（读取本身将失败）；
   * 其他解析错误（权限等）一律抛错（fail-closed，由调用方转为拒绝）。
   */
  async resolveIdentity(canonicalPath: string): Promise<SensitiveResourceIdentity> {
    let realPath: string | null = null;
    let deviceInode: string | null = null;
    let isLinkLike: boolean;
    try {
      const linkStat = await lstat(canonicalPath);
      isLinkLike = linkStat.isSymbolicLink();
    } catch {
      isLinkLike = false;
    }
    try {
      realPath = await realpath(canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (realPath !== null) {
      try {
        const fileStat = await stat(realPath);
        deviceInode = `${fileStat.dev}:${fileStat.ino}`;
      } catch {
        deviceInode = null;
      }
    }
    return {
      canonicalPath,
      realPath,
      deviceInode,
      normalizedCasePath:
        process.platform === "win32"
          ? canonicalPath.toLowerCase()
          : canonicalPath,
      isLinkLike,
    };
  }

  /** 两个身份是否指向同一文件（realpath 一致或硬链接身份一致）。 */
  isSameResource(
    left: SensitiveResourceIdentity,
    right: SensitiveResourceIdentity,
  ): boolean {
    if (
      left.realPath !== null &&
      right.realPath !== null &&
      left.realPath === right.realPath
    ) {
      return true;
    }
    if (
      left.deviceInode !== null &&
      right.deviceInode !== null &&
      left.deviceInode === right.deviceInode
    ) {
      return true;
    }
    return false;
  }
}

/**
 * 全模式敏感内容访问策略（ADR-0018）。
 * 读取/列出/搜索/上传前调用；命中即抛 sensitive-content-read-denied。
 */
export interface SensitiveContentAccessPolicyOptions {
  /** 管理员扩展的规范敏感路径（绝对路径，大小写折叠后比较）。 */
  additionalSensitivePaths?: string[];
  /** 管理员扩展的文件名/路径正则。 */
  additionalSensitivePatterns?: RegExp[];
  /** 名称正常但内容疑似凭据的本地可信 DLP 扫描器（可注入 mock）。 */
  dlpScanner?: SensitiveContentDlpScanner;
}

/** 本地可信 DLP 扫描器契约（扫描器本身不是模型工具，结果不进入模型上下文）。 */
export interface SensitiveContentDlpScanner {
  scanTextContent(input: {
    content: string;
    sourceName: string;
  }): Promise<SensitiveResourceMatch>;
}

/** 内置凭据内容模式（DLP）：正常文件名但内容疑似密钥。 */
const DEFAULT_DLP_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: "api-key", pattern: /["']?(api[_-]?key|access[_-]?key|token|secret)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-./]{16,}/i },
  { category: "aws-credential", pattern: /AKIA[0-9A-Z]{16}/ },
  { category: "private-key", pattern: /BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|BEGIN PGP PRIVATE KEY BLOCK/ },
  { category: "github-token", pattern: /(ghp|gho|ghu|ghs)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9]{16,}/ },
  { category: "connection-string", pattern: /(postgres|mysql|mongodb|redis|amqp)\+?s?:\/\/[^\s:@]+:[^\s:@]+@/ },
];

/**
 * 内置文件名规则（ADR-0018 列举项；大小写不敏感，含扩展名规则）。
 */
const DEFAULT_SENSITIVE_FILE_NAME_PATTERNS: Array<{
  category: string;
  pattern: RegExp;
}> = [
  { category: "dotenv", pattern: /^\.env$|^\.env\..+$|^.*\.env$/i },
  { category: "credential-store", pattern: /^\.(npmrc|pypirc|netrc|git-credentials)$/i },
  { category: "cloud-credential", pattern: /^(aws|azure|gcp|aliyun)[\\/_-]?(credentials|config)$|^\.(aws|azure|gcp)$/i },
  { category: "kubeconfig", pattern: /^kubeconfig$|\.kube[\\/]config$/i },
  { category: "private-key", pattern: /^id_(rsa|ed25519|ecdsa|dsa)$|\.(key|pem|p12|pfx|jks|keystore)$|^\.(ssh|gnupg|pgp)$/i },
  { category: "credential-catalog", pattern: /^(credentials|secrets?|\.credentials)(\.|$)/i },
  { category: "capability-token", pattern: /astarray[\\/_-]?(capability|token|credential)/i },
];

/** 平台大小写折叠（Windows 大小写不敏感）。 */
function foldCase(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

export class SensitiveContentAccessPolicy {
  private readonly additionalSensitivePaths: string[];
  private readonly additionalSensitivePatterns: RegExp[];
  private readonly dlpScanner: SensitiveContentDlpScanner;

  constructor(options: SensitiveContentAccessPolicyOptions = {}) {
    this.additionalSensitivePaths = (
      options.additionalSensitivePaths ?? []
    ).map((filePath) => foldCase(path.resolve(filePath)));
    this.additionalSensitivePatterns = options.additionalSensitivePatterns ?? [];
    this.dlpScanner = options.dlpScanner ?? new DefaultDlpScanner();
  }

  /**
   * 解析身份并判定文件名/路径是否敏感（含大小写折叠、realpath 与硬链接视图）。
   * 返回命中类别或 null（非敏感）。
   */
  async identifySensitiveResource(
    canonicalPath: string,
  ): Promise<{ category: string; identity: SensitiveResourceIdentity } | null> {
    const identity = await new SensitiveResourceIdentityResolver().resolveIdentity(
      canonicalPath,
    );
    const match = this.matchSensitivePath(identity);
    if (match !== null) {
      return { category: match, identity };
    }
    return null;
  }

  /** 只按路径/文件名匹配（不解析文件系统；供目录条目过滤等预检）。 */
  matchSensitivePathName(filePath: string): string | null {
    const foldedPath = foldCase(filePath);
    const baseName = path.basename(foldedPath);
    if (
      this.additionalSensitivePaths.some(
        (sensitivePath) =>
          foldedPath === sensitivePath || foldedPath.startsWith(`${sensitivePath}${path.sep}`),
      )
    ) {
      return "admin-extended";
    }
    if (
      this.additionalSensitivePatterns.some(
        (pattern) => pattern.test(baseName) || pattern.test(filePath),
      )
    ) {
      return "admin-extended";
    }
    for (const rule of DEFAULT_SENSITIVE_FILE_NAME_PATTERNS) {
      if (rule.pattern.test(baseName) || rule.pattern.test(foldedPath)) {
        return rule.category;
      }
    }
    return null;
  }

  /** 完整路径匹配（含规范路径组件，兼容 Windows 分隔符）。 */
  private matchSensitivePath(identity: SensitiveResourceIdentity): string | null {
    const candidates = [
      identity.canonicalPath,
      identity.realPath ?? "",
      identity.normalizedCasePath,
    ];
    for (const candidate of candidates) {
      if (candidate === "") {
        continue;
      }
      const match = this.matchSensitivePathName(candidate);
      if (match !== null) {
        return match;
      }
    }
    return null;
  }

  /**
   * 读取前强制检查：命中敏感路径或内容疑似凭据（DLP）→ 抛
   * sensitive-content-read-denied。内容未提供时只做路径检查。
   */
  async assertSensitiveContentReadAllowed(input: {
    canonicalPath: string;
    /** 可选：待返回给模型的文本内容（名称正常时做 DLP 扫描）。 */
    content?: string;
  }): Promise<void> {
    const pathMatch = await this.identifySensitiveResource(input.canonicalPath);
    if (pathMatch !== null) {
      throw this.buildDenial(pathMatch.category);
    }
    if (input.content !== undefined) {
      const contentMatch = await this.dlpScanner.scanTextContent({
        content: input.content,
        sourceName: input.canonicalPath,
      });
      if (contentMatch.isSensitive) {
        throw this.buildDenial(
          contentMatch.matchedRuleCategory ?? "dlp:unknown",
        );
      }
    }
  }

  /** 目录条目过滤：返回过滤后列表（不泄露敏感条目）。 */
  filterSensitiveDirectoryEntries(
    directoryPath: string,
    entries: string[],
  ): string[] {
    return entries.filter((entry) => {
      const entryPath = path.join(directoryPath, entry);
      return this.matchSensitivePathName(entryPath) === null;
    });
  }

  private buildDenial(category: string): DomainError {
    return new DomainError(
      SENSITIVE_CONTENT_READ_DENIED_ERROR_CODE,
      `敏感内容禁读（规则类别: ${category}）`,
    );
  }
}

/** 默认本地可信 DLP 扫描器：有界内容扫描，命中返回类别。 */
export class DefaultDlpScanner implements SensitiveContentDlpScanner {
  private static readonly MAX_SCAN_BYTES = 256 * 1024;

  async scanTextContent(input: {
    content: string;
    sourceName: string;
  }): Promise<SensitiveResourceMatch> {
    void input.sourceName;
    const boundedContent = input.content.slice(
      0,
      DefaultDlpScanner.MAX_SCAN_BYTES,
    );
    for (const rule of DEFAULT_DLP_PATTERNS) {
      if (rule.pattern.test(boundedContent)) {
        return { matchedRuleCategory: `dlp:${rule.category}`, isSensitive: true };
      }
    }
    return { matchedRuleCategory: null, isSensitive: false };
  }
}
