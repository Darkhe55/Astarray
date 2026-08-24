/**
 * 工作集预算跟踪器（T07E-02 / ADR-0029 §2/§3）。
 *
 * - 规范资源身份计数：相对/绝对路径、大小写、符号链接、联接点、
 *   硬链接、范围切片均归一为同一身份（不重复占槽/不绕过）；
 * - 所有模型可见读取通道接入：正文读取、搜索返回源码片段、Git 内容
 *   视图、归档/拼接/聚合（按 manifest 原文件分别计数；无 manifest
 *   fail-closed）；
 * - 敏感文件在预算判断前直接拒绝，不登记正文或指纹；
 * - 强制治理文档使用独立预算（不挤占 10 个项目文件槽）；
 * - 请求第 11 个不同内容文件时在读前返回 working-set-budget-reached。
 */
import { DomainError } from "../core/errors.js";
import {
  DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION,
  DEFAULT_WORKING_SET_WARNING_THRESHOLD_FILE_COUNT,
} from "./working-set-schemas.js";
import type { SourceManifest } from "./working-set-schemas.js";

/** 规范身份解析端口（装配方注入 realpath/大小写折叠；测试可注入）。 */
export interface CanonicalResourceIdentityPort {
  canonicalize(filePath: string): Promise<string>;
}

/** 敏感路径判定端口（预算判断前调用；命中即拒绝不登记）。 */
export interface SensitivePathDetectionPort {
  isSensitivePath(filePath: string): boolean;
}

export interface WorkingSetBudgetTrackerOptions {
  canonicalIdentityPort: CanonicalResourceIdentityPort;
  sensitivePathPort: SensitivePathDetectionPort;
  maximumDistinctProjectContentFilesPerAgentActivation?: number;
  workingSetWarningThresholdFileCount?: number;
}

export type ContentReadOutcome =
  | { decision: "allowed"; isNewFile: boolean; warningRaised: boolean }
  | { decision: "warned"; warning: string }
  | { decision: "denied"; reason: string };

export class WorkingSetBudgetTracker {
  private readonly canonicalIdentityPort: CanonicalResourceIdentityPort;
  private readonly sensitivePathPort: SensitivePathDetectionPort;
  private readonly maximumDistinctProjectContentFilesPerAgentActivation: number;
  private readonly workingSetWarningThresholdFileCount: number;

  /** Agent → 规范身份 → 是否已入工作集。 */
  private readonly workingSetByIdentity = new Map<string, Set<string>>();
  /** 任务链 → 累计来源集合（重启/handoff 不清零）。 */
  private readonly taskChainCumulativeSources = new Map<string, Set<string>>();
  /** Agent → 治理文档独立计数（不挤占项目槽）。 */
  private readonly governanceDocumentCountByAgent = new Map<string, number>();

  constructor(options: WorkingSetBudgetTrackerOptions) {
    this.canonicalIdentityPort = options.canonicalIdentityPort;
    this.sensitivePathPort = options.sensitivePathPort;
    this.maximumDistinctProjectContentFilesPerAgentActivation =
      options.maximumDistinctProjectContentFilesPerAgentActivation ??
      DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION;
    this.workingSetWarningThresholdFileCount =
      options.workingSetWarningThresholdFileCount ??
      DEFAULT_WORKING_SET_WARNING_THRESHOLD_FILE_COUNT;
  }

  /**
   * Agent 尝试读取一个项目内容文件正文：
   * 敏感 → 预算前拒绝（不登记）；已读 → 重读占原槽（警告已用）；
   * 新文件 → 8 文件提醒 / 10 文件读前拒绝。
   */
  async attemptContentRead(input: {
    agentInstanceId: string;
    taskChainIdentifier: string;
    filePath: string;
  }): Promise<ContentReadOutcome> {
    if (this.sensitivePathPort.isSensitivePath(input.filePath)) {
      throw new DomainError(
        "sensitive-content-read-denied",
        "敏感文件在预算判断前直接拒绝（不登记正文或指纹）",
      );
    }
    const canonicalIdentity = await this.canonicalIdentityPort.canonicalize(
      input.filePath,
    );
    const agentWorkingSet = this.getAgentWorkingSet(input.agentInstanceId);
    if (agentWorkingSet.has(canonicalIdentity)) {
      return { decision: "allowed", isNewFile: false, warningRaised: false };
    }
    if (
      agentWorkingSet.size >=
      this.maximumDistinctProjectContentFilesPerAgentActivation
    ) {
      return {
        decision: "denied",
        reason: `working-set-budget-reached（第 ${this.maximumDistinctProjectContentFilesPerAgentActivation + 1} 个不同内容文件在读前拒绝）`,
      };
    }
    agentWorkingSet.add(canonicalIdentity);
    this.getTaskChainCumulativeSources(input.taskChainIdentifier).add(
      canonicalIdentity,
    );
    if (
      agentWorkingSet.size >= this.workingSetWarningThresholdFileCount &&
      agentWorkingSet.size <
        this.maximumDistinctProjectContentFilesPerAgentActivation
    ) {
      return {
        decision: "warned",
        warning: `工作集已达 ${agentWorkingSet.size} 文件（阈值 ${this.workingSetWarningThresholdFileCount}），提醒调度者检查相关性`,
      };
    }
    return { decision: "allowed", isNewFile: true, warningRaised: false };
  }

  /** 搜索返回源码片段：每个返回正文的来源文件占 1 槽。 */
  async registerSearchContentHits(input: {
    agentInstanceId: string;
    taskChainIdentifier: string;
    sourceFilePaths: string[];
  }): Promise<ContentReadOutcome> {
    let latestOutcome: ContentReadOutcome = {
      decision: "allowed",
      isNewFile: false,
      warningRaised: false,
    };
    for (const filePath of input.sourceFilePaths) {
      latestOutcome = await this.attemptContentRead({
        agentInstanceId: input.agentInstanceId,
        taskChainIdentifier: input.taskChainIdentifier,
        filePath,
      });
      if (latestOutcome.decision === "denied") {
        return latestOutcome;
      }
    }
    return latestOutcome;
  }

  /** Git diff/show/blame 返回内容：按来源文件占槽（同 attemptContentRead）。 */
  async registerGitContentView(input: {
    agentInstanceId: string;
    taskChainIdentifier: string;
    contentSourceFilePaths: string[];
  }): Promise<ContentReadOutcome> {
    return this.registerSearchContentHits({
      agentInstanceId: input.agentInstanceId,
      taskChainIdentifier: input.taskChainIdentifier,
      sourceFilePaths: input.contentSourceFilePaths,
    });
  }

  /**
   * 归档/拼接/聚合：按 manifest 原文件分别计数；
   * 无可信来源 manifest → fail-closed（不能把几十个文件压成一个绕过）。
   */
  async registerAggregatedContent(input: {
    agentInstanceId: string;
    taskChainIdentifier: string;
    manifest: SourceManifest | null;
  }): Promise<ContentReadOutcome> {
    if (input.manifest === null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "聚合内容缺少可信来源 manifest，拒绝（fail-closed）",
      );
    }
    return this.registerSearchContentHits({
      agentInstanceId: input.agentInstanceId,
      taskChainIdentifier: input.taskChainIdentifier,
      sourceFilePaths: input.manifest.sourceFileCanonicalIdentities,
    });
  }

  /** 治理文档读取：独立预算（不挤占项目工作文件槽）。 */
  async registerGovernanceDocumentRead(input: {
    agentInstanceId: string;
  }): Promise<void> {
    const currentCount = this.governanceDocumentCountByAgent.get(
      input.agentInstanceId,
    ) ?? 0;
    this.governanceDocumentCountByAgent.set(
      input.agentInstanceId,
      currentCount + 1,
    );
  }

  /** 当前活动工作集文件数。 */
  getWorkingSetFileCount(agentInstanceId: string): number {
    return this.getAgentWorkingSet(agentInstanceId).size;
  }

  /** 任务链累计来源数（重启/handoff 不清零）。 */
  getTaskChainCumulativeSourceCount(taskChainIdentifier: string): number {
    return this.getTaskChainCumulativeSources(taskChainIdentifier).size;
  }

  private getAgentWorkingSet(agentInstanceId: string): Set<string> {
    let workingSet = this.workingSetByIdentity.get(agentInstanceId);
    if (workingSet === undefined) {
      workingSet = new Set();
      this.workingSetByIdentity.set(agentInstanceId, workingSet);
    }
    return workingSet;
  }

  private getTaskChainCumulativeSources(
    taskChainIdentifier: string,
  ): Set<string> {
    let sources = this.taskChainCumulativeSources.get(taskChainIdentifier);
    if (sources === undefined) {
      sources = new Set();
      this.taskChainCumulativeSources.set(taskChainIdentifier, sources);
    }
    return sources;
  }
}