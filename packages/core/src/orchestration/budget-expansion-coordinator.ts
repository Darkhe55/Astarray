/**
 * 预算扩展与侦察拆分协调器（T07E-05 / ADR-0029 §5）。
 *
 * - ReadBudgetExpansionGrant 绑定 Agent/任务链/revision/数量/路径/理由/
 *   期限/发布者；任一参数变化 → grant 失效（拒绝扩展）；
 * - 次级 Agent 只能在用户配置允许的扩展范围内批准（maxAdditionalFiles
 *   与允许路径）；用户设置要求人工确认或超本地上限时进入用户裁决；
 * - 扩展不是文件读取权限，也不放宽敏感禁读、Ponder 只读边界或工作区范围；
 * - 大任务拆给多个侦察 Agent（各 ≤10 文件），次级只接收摘要引用
 *   （不直接继承项目全文）；项目文字不能自批扩展（grant 只能由
 *   authenticated-user 或 local-control-plane 签发）。
 */
import { DomainError } from "../core/errors.js";
import {
  DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION,
  readBudgetExpansionGrantSchema,
} from "./working-set-schemas.js";
import type { z } from "zod";

/** 用户配置的扩展边界（次级批准上限）。 */
export interface UserConfiguredExpansionBounds {
  /** 单个 Agent 最多可额外扩展的文件数。 */
  maximumAdditionalFilesPerAgent: number;
  /** 允许扩展的路径模式（前缀匹配）。 */
  allowedPathPrefixes: string[];
  /** 超出边界时是否要求人工确认。 */
  requiresHumanConfirmationBeyondBounds: boolean;
}

export interface BudgetExpansionCoordinatorOptions {
  userConfiguredBounds: UserConfiguredExpansionBounds;
}

export type ExpansionDecision =
  | { decision: "granted"; additionalFileCountAllowed: number }
  | {
      decision: "human-confirmation-required";
      reason: string;
    }
  | { decision: "denied"; reason: string };

export interface ReconnaissanceSplitPlan {
  /** 每个侦察 Agent 的任务分配（各 ≤10 文件）。 */
  reconnaissanceAssignments: Array<{
    reconnaissanceAgentInstanceId: string;
    assignedSourceIdentities: string[];
    /** 摘要引用（PROJECT_CONTEXT_DIGEST_V1；不返回全文）。 */
    digestReferenceIdentifier: string;
  }>;
  /** 次级接收的摘要引用集合（非全文）。 */
  secondaryReceivesDigestReferences: string[];
}

export class BudgetExpansionCoordinator {
  private readonly userConfiguredBounds: UserConfiguredExpansionBounds;

  constructor(options: BudgetExpansionCoordinatorOptions) {
    this.userConfiguredBounds = options.userConfiguredBounds;
  }

  /**
   * 校验扩展 grant 并在用户配置边界内批准：
   * 1) grant schema 合法（绑定要素完整）；
   * 2) grant 未过期；
   * 3) 新增文件数在用户配置边界内（超出 → 人工确认或拒绝）；
   * 4) 允许路径在用户配置的路径边界内。
   * grant 参数/路径/任务/Agent/期限/revision 变化后（新 grant 或过期）
   * 失效。项目文字不能自批扩展（issuedBy 仅认证用户/本地控制面）。
   */
  evaluateExpansionGrant(input: {
    grant: z.input<typeof readBudgetExpansionGrantSchema>;
    nowUnixMilliseconds: number;
  }): ExpansionDecision {
    const parsedGrant = readBudgetExpansionGrantSchema.safeParse(input.grant);
    if (!parsedGrant.success) {
      throw new DomainError(
        "invalid-task-chain",
        `扩展 grant 非法: ${parsedGrant.error.message}`,
      );
    }
    const grant = parsedGrant.data;
    if (new Date(grant.expiresAtIso).getTime() <= input.nowUnixMilliseconds) {
      return { decision: "denied", reason: "扩展 grant 已过期" };
    }
    if (grant.additionalFileCountAllowed > this.userConfiguredBounds.maximumAdditionalFilesPerAgent) {
      if (this.userConfiguredBounds.requiresHumanConfirmationBeyondBounds) {
        return {
          decision: "human-confirmation-required",
          reason: `请求扩展 ${grant.additionalFileCountAllowed} 文件超出用户配置上限 ${this.userConfiguredBounds.maximumAdditionalFilesPerAgent}，需人工确认`,
        };
      }
      return {
        decision: "denied",
        reason: `请求扩展 ${grant.additionalFileCountAllowed} 文件超出用户配置上限 ${this.userConfiguredBounds.maximumAdditionalFilesPerAgent}`,
      };
    }
    const pathWithinBounds = grant.allowedPathsOrPurposes.every((pathOrPurpose) =>
      this.userConfiguredBounds.allowedPathPrefixes.some((prefix) =>
        pathOrPurpose.startsWith(prefix),
      ),
    );
    if (!pathWithinBounds) {
      return {
        decision: "denied",
        reason: "扩展路径超出用户配置的允许范围（扩展不放松工作区边界）",
      };
    }
    return {
      decision: "granted",
      additionalFileCountAllowed: grant.additionalFileCountAllowed,
    };
  }

  /**
   * 大任务侦察拆分：把超预算的来源集合拆给多个侦察 Agent
   * （每个 ≤10 文件）；次级只接收摘要引用（不继承项目全文）。
   */
  splitToReconnaissance(input: {
    sourceIdentities: string[];
    /** 每个侦察 Agent 的文件上限（默认 10）。 */
    filesPerReconnaissanceAgent?: number;
    generateReconnaissanceAgentInstanceId: (index: number) => string;
  }): ReconnaissanceSplitPlan {
    const filesPerAgent =
      input.filesPerReconnaissanceAgent ??
      DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION;
    const assignments: ReconnaissanceSplitPlan["reconnaissanceAssignments"] = [];
    for (let offset = 0; offset < input.sourceIdentities.length; offset += filesPerAgent) {
      const assigned = input.sourceIdentities.slice(offset, offset + filesPerAgent);
      const agentIndex = assignments.length;
      assignments.push({
        reconnaissanceAgentInstanceId:
          input.generateReconnaissanceAgentInstanceId(agentIndex),
        assignedSourceIdentities: assigned,
        digestReferenceIdentifier: `digest-${agentIndex}`,
      });
    }
    return {
      reconnaissanceAssignments: assignments,
      secondaryReceivesDigestReferences: assignments.map(
        (assignment) => assignment.digestReferenceIdentifier,
      ),
    };
  }
}