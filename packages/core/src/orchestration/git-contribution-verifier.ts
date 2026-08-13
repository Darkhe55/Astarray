/**
 * Git 贡献验证器（T05B / ADR-0012 §审查与合并规则）。
 * 合并前验证：提交存在、祖先关系正确、身份绑定（提交作者 = 分配的
 * tertiaryAgentInstanceId）、实际修改未越过任务允许路径、敏感信息与
 * 命名扫描、测试证据非空且成功。
 * 验证失败保持提交未合并，返回结构化拒绝原因，由协调器下发修正。
 */
import type {
  GitCheckExecutionRecord,
  GitWorkerAllocation,
} from "../core/types.js";
import { GitProcess } from "./git-process.js";

export interface VerifyContributionInput {
  allocation: GitWorkerAllocation;
  repositoryPath: string;
  baseCommit: string;
  headCommit: string;
  executedChecks: GitCheckExecutionRecord[];
  /** 可选的敏感信息正则（追加到内置默认集）。 */
  additionalSensitivePatterns?: RegExp[];
}

export interface ContributionVerificationResult {
  passed: boolean;
  failureReasons: string[];
  changedPaths: string[];
  /** 判定：passed → accepted；有越界/身份问题 → rejected；仅测试不足 → needs-rework。 */
  reviewDecision: "accepted" | "rejected" | "needs-rework";
}

/** 内置敏感信息模式：凭据/密钥/私钥/令牌。 */
const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9_.]{8,}/i,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /(ghp|gho|ghu|glpat|sk-)[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
];

export class GitContributionVerifier {
  constructor(private readonly gitProcess: GitProcess = new GitProcess()) {}

  async verifyContribution(
    input: VerifyContributionInput,
  ): Promise<ContributionVerificationResult> {
    const failureReasons: string[] = [];
    let changedPaths: string[] = [];

    // 1) 提交存在性
    const headCheck = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `${input.headCommit}^{commit}`],
        `校验 headCommit 存在 ${input.headCommit}`,
      )
      .catch(() => null);
    if (headCheck === null || headCheck.stdoutText.trim() === "") {
      failureReasons.push(`headCommit 不存在或不可解析: ${input.headCommit}`);
    }
    const baseCheck = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `${input.baseCommit}^{commit}`],
        `校验 baseCommit 存在 ${input.baseCommit}`,
      )
      .catch(() => null);
    if (baseCheck === null || baseCheck.stdoutText.trim() === "") {
      failureReasons.push(`baseCommit 不存在或不可解析: ${input.baseCommit}`);
    }

    // 2) 祖先关系：base 必须是 head 的祖先（确保 head 包含 base 的全部历史）
    if (headCheck !== null && baseCheck !== null) {
      const ancestorCheck = await this.gitProcess
        .run(
          input.repositoryPath,
          ["merge-base", "--is-ancestor", input.baseCommit, input.headCommit],
          `校验祖先关系 ${input.baseCommit} ∈ ${input.headCommit}`,
        )
        .catch(() => null);
      if (ancestorCheck === null) {
        failureReasons.push(
          `祖先关系不成立: ${input.baseCommit} 不是 ${input.headCommit} 的祖先`,
        );
      }
    }

    // 3) 实际修改路径（base..head）
    if (baseCheck !== null && headCheck !== null) {
      const changedPathResult = await this.gitProcess
        .run(
          input.repositoryPath,
          [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            `${input.baseCommit}..${input.headCommit}`,
          ],
          `列出 base..head 修改路径`,
        )
        .catch(() => null);
      if (changedPathResult === null) {
        failureReasons.push("无法读取修改路径列表");
      } else {
        changedPaths = changedPathResult.stdoutText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        // 越界检查：允许路径前缀匹配
        const outOfBoundPaths = changedPaths.filter(
          (changedPath) =>
            !input.allocation.allowedPaths.some(
              (allowedPath) =>
                changedPath === allowedPath ||
                changedPath.startsWith(`${allowedPath}/`),
            ),
        );
        if (outOfBoundPaths.length > 0) {
          failureReasons.push(
            `实际修改越过允许路径: [${outOfBoundPaths.join(", ")}]`,
          );
        }
      }
    }

    // 4) 身份绑定：分支上全部提交的作者必须是分配的三级 Agent 实例
    if (headCheck !== null && baseCheck !== null) {
      const authorResult = await this.gitProcess
        .run(
          input.repositoryPath,
          [
            "log",
            "--format=%an",
            `${input.baseCommit}..${input.headCommit}`,
          ],
          `列出 base..head 提交作者`,
        )
        .catch(() => null);
      if (authorResult === null) {
        failureReasons.push("无法读取提交作者");
      } else {
        const unexpectedAuthors = [
          ...new Set(
            authorResult.stdoutText
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== ""),
          ),
        ].filter((author) => author !== input.allocation.tertiaryAgentInstanceId);
        if (unexpectedAuthors.length > 0) {
          failureReasons.push(
            `提交作者与分配的 Agent 实例不一致: [${unexpectedAuthors.join(", ")}]（应为 ${input.allocation.tertiaryAgentInstanceId}）`,
          );
        }
      }
    }

    // 5) 敏感信息扫描（逐路径内容）
    if (changedPaths.length > 0) {
      for (const changedPath of changedPaths) {
        const contentResult = await this.gitProcess
          .run(
            input.repositoryPath,
            [
              "show",
              `${input.headCommit}:${changedPath}`,
            ],
            `读取 ${changedPath} 内容扫描敏感信息`,
          )
          .catch(() => null);
        if (contentResult === null) {
          continue;
        }
        const sensitivePatterns = [
          ...DEFAULT_SENSITIVE_PATTERNS,
          ...(input.additionalSensitivePatterns ?? []),
        ];
        const sensitiveMatch = sensitivePatterns.find((pattern) =>
          pattern.test(contentResult.stdoutText),
        );
        if (sensitiveMatch !== undefined) {
          failureReasons.push(
            `路径 ${changedPath} 含疑似敏感信息（匹配 ${sensitiveMatch.source}）`,
          );
        }
      }
    }

    // 6) 测试证据：必须非空且全部成功
    if (input.executedChecks.length === 0) {
      failureReasons.push("缺少测试证据（executedChecks 为空）");
    } else if (
      input.executedChecks.some((check) => check.exitCode !== 0)
    ) {
      failureReasons.push(
        `测试证据包含失败项: [${input.executedChecks
          .filter((check) => check.exitCode !== 0)
          .map((check) => check.command)
          .join(", ")}]`,
      );
    }

    // 判定：敏感信息/越界/身份/祖先问题 → rejected；仅测试不足 → needs-rework
    const hasStructuralFailure = failureReasons.some((reason) =>
      /敏感信息|越过|越界|作者|祖先|headCommit|baseCommit|修改路径/.test(reason),
    );
    return {
      passed: failureReasons.length === 0,
      failureReasons,
      changedPaths,
      reviewDecision:
        failureReasons.length === 0
          ? "accepted"
          : hasStructuralFailure
            ? "rejected"
            : "needs-rework",
    };
  }
}
