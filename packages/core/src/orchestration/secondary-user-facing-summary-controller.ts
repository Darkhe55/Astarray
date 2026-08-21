/**
 * 次级面向用户摘要与主 Agent 细节查询控制器（T08C-03 / ADR-0025 §6）。
 *
 * 次级接收大量三级/四级汇报后，生成版本化 SECONDARY_USER_FACING_SUMMARY_V1
 * 交给主 Agent：只包含目标、进度、主要结果、风险、待用户决定事项与证据引用。
 * 详细日志与个体报告留在次级存档与报告索引。
 *
 * 本控制器保证：
 * - 摘要发布只写主 Agent 只读报告索引，不自动唤醒主 Agent 模型；
 * - 摘要来源必须是已登记次级（不可复用 agentInstanceId）；
 * - 主 Agent 发起的细节查询绑定具体任务/revision；次级未知时明确返回
 *   "unknown"，不得伪造答案；转发保留原始来源。
 */
import type { z } from "zod";

import { DomainError } from "../core/errors.js";
import { secondaryUserFacingSummarySchema } from "./agent-routing-schemas.js";

/** 主 Agent 只读报告索引写入端口（装配方实现为只写索引，不唤醒主 Agent）。 */
export interface MainAgentReportIndexWritePort {
  insertSummaryEntry(input: {
    summaryId: string;
    secondaryAgentInstanceId: string;
    boundTaskIdentifier: string;
    boundTaskRevision: number;
    goal: string;
    currentProgress: string;
    keyResultsSummary: string;
    riskCount: number;
    pendingUserDecisionCount: number;
    createdAtIso: string;
    contentHash: string;
  }): Promise<void>;
}

/** 次级来源认证端口（具体次级是否已登记）。 */
export interface SecondarySourceAuthenticationPort {
  isRegisteredSecondary(agentInstanceId: string): Promise<boolean>;
}

/** 主 Agent → 具体次级的细节查询端口（绑定任务/revision）。 */
export interface SecondaryDetailQueryPort {
  requestDetail(input: {
    taskIdentifier: string;
    taskRevision: number;
  }): Promise<
    | { kind: "detail"; detail: string; evidenceReferences: string[]; revision: number }
    | { kind: "unknown"; reason: string }
  >;
}

export interface SecondaryUserFacingSummaryControllerOptions {
  authenticatedMainAgentInstanceId: string;
  reportIndexPort: MainAgentReportIndexWritePort;
  sourceAuthenticationPort: SecondarySourceAuthenticationPort;
  detailQueryPort: SecondaryDetailQueryPort;
}

export interface PublishUserFacingSummaryInput {
  summary: z.input<typeof secondaryUserFacingSummarySchema>;
}

export class SecondaryUserFacingSummaryController {
  private readonly authenticatedMainAgentInstanceId: string;
  private readonly reportIndexPort: MainAgentReportIndexWritePort;
  private readonly sourceAuthenticationPort: SecondarySourceAuthenticationPort;
  private readonly detailQueryPort: SecondaryDetailQueryPort;

  constructor(options: SecondaryUserFacingSummaryControllerOptions) {
    this.authenticatedMainAgentInstanceId =
      options.authenticatedMainAgentInstanceId;
    this.reportIndexPort = options.reportIndexPort;
    this.sourceAuthenticationPort = options.sourceAuthenticationPort;
    this.detailQueryPort = options.detailQueryPort;
  }

  /**
   * 发布面向用户摘要：校验 schema 与次级来源后只写主 Agent 只读报告索引。
   * 不调用任何模型，不触发主 Agent 上下文注入（仅入索引）。
   */
  async publishUserFacingSummary(
    input: PublishUserFacingSummaryInput,
  ): Promise<void> {
    const parsedSummary = secondaryUserFacingSummarySchema.safeParse(
      input.summary,
    );
    if (!parsedSummary.success) {
      throw new DomainError(
        "invalid-task-chain",
        `次级面向用户摘要非法: ${parsedSummary.error.message}`,
      );
    }
    const summary = parsedSummary.data;
    const isRegistered = await this.sourceAuthenticationPort.isRegisteredSecondary(
      summary.secondaryAgentInstanceId,
    );
    if (!isRegistered) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `摘要来源次级未登记（非空字符串不是认证）: ${summary.secondaryAgentInstanceId}`,
      );
    }
    await this.reportIndexPort.insertSummaryEntry({
      summaryId: summary.summaryId,
      secondaryAgentInstanceId: summary.secondaryAgentInstanceId,
      boundTaskIdentifier: summary.boundTaskIdentifier,
      boundTaskRevision: summary.boundTaskRevision,
      goal: summary.goal,
      currentProgress: summary.currentProgress,
      keyResultsSummary: summary.keyResults
        .map((result) => result.resultSummary)
        .join("；"),
      riskCount: summary.risksAndFailures.length,
      pendingUserDecisionCount: summary.pendingUserDecisions.length,
      createdAtIso: summary.createdAtIso,
      contentHash: `sha256:${summary.summaryId}`, // 占位：装配方可改为真实内容哈希
    });
  }

  /**
   * 主 Agent 发起绑定任务/revision 的细节查询；结果由负责次级返回。
   * 调用方必须是认证主 Agent（只读）；未知时明确返回 unknown，不伪造。
   */
  async querySecondaryDetail(input: {
    callingAgentInstanceId: string;
    taskIdentifier: string;
    taskRevision: number;
  }): Promise<
    | { kind: "detail"; detail: string; evidenceReferences: string[]; revision: number }
    | { kind: "unknown"; reason: string }
  > {
    if (input.callingAgentInstanceId !== this.authenticatedMainAgentInstanceId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "只有认证主 Agent 可发起次级细节查询",
      );
    }
    if (input.taskIdentifier.trim() === "" || input.taskRevision < 1) {
      throw new DomainError(
        "invalid-task-chain",
        "细节查询必须绑定具体任务标识与 revision",
      );
    }
    return this.detailQueryPort.requestDetail({
      taskIdentifier: input.taskIdentifier,
      taskRevision: input.taskRevision,
    });
  }
}
