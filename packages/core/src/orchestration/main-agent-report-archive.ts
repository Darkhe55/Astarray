/**
 * 主 Agent 报告归档与只读读取（T08A / ADR-0022 §汇报只入档）。
 * 次级 Agent 每完成、终止或阻塞一个任务包，都通过独立反馈进程发送带具体
 * agentInstanceId 的结构化汇报。MainAgentReportArchiveIngestor 在本地验证、
 * 确认并写入主 Agent 的报告索引；汇报到达不唤醒主 Agent 模型、不插入当前
 * 模型上下文、不打断用户输入。
 *
 * MainAgentReportReader：主 Agent 只在后续用户对话轮次按问题、任务引用与
 * token 预算只读选择相关摘要或报告。报告索引与原始次级/三级工作存档分离，
 * 保留来源、revision、任务引用与内容哈希。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { sanitizePathSegment } from "./work-archive-store.js";

export interface TertiaryTerminalReport {
  reportId: string;
  missionId: string;
  taskBundleId: string;
  reportingAgentInstanceId: string;
  reportKind: "completed" | "terminated" | "blocked";
  summary: string;
  executedChecks: Array<{ command: string; exitCode: number }>;
  createdAtIso: string;
  /** 规范化序列化内容哈希（防篡改）。 */
  contentHash: string;
}

export interface MainAgentReportIndexEntry {
  reportId: string;
  missionId: string;
  taskBundleId: string;
  reportingAgentInstanceId: string;
  reportKind: TertiaryTerminalReport["reportKind"];
  summaryPreview: string;
  recordedAtIso: string;
  contentHash: string;
}

export interface MainAgentReportArchiveOptions {
  baseDirectory: string;
}

export class MainAgentReportArchiveIngestor {
  private readonly archiveRootDirectory: string;

  constructor(options: MainAgentReportArchiveOptions) {
    this.archiveRootDirectory = path.join(
      options.baseDirectory,
      "main-agent-reports",
    );
  }

  /**
   * 写入报告（来源校验：报告 Agent 必须非空且是具体实例）。
   * 只写索引，不回调主 Agent 模型。
   */
  async ingestReport(report: TertiaryTerminalReport): Promise<void> {
    if (report.reportingAgentInstanceId === "") {
      throw new DomainError(
        "invalid-task-chain",
        "报告来源 agentInstanceId 不能为空",
      );
    }
    const { createHash } = await import("node:crypto");
    // 规范化内容（剔除 contentHash 字段后哈希，读回验证口径一致）
    const canonical = canonicalizeReport(report);
    const contentHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const verifiedReport: TertiaryTerminalReport = {
      ...report,
      contentHash,
    };
    const missionDirectory = path.join(
      this.archiveRootDirectory,
      sanitizePathSegment(report.missionId),
    );
    const reportFilePath = path.join(
      missionDirectory,
      `${sanitizePathSegment(report.reportId)}.json`,
    );
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(
      reportFilePath,
      `${JSON.stringify(verifiedReport, null, 2)}\n`,
      "utf8",
    );
  }

  /** 索引读取（主 Agent 只读选择用）。 */
  async readIndex(missionId: string): Promise<MainAgentReportIndexEntry[]> {
    const missionDirectory = path.join(
      this.archiveRootDirectory,
      sanitizePathSegment(missionId),
    );
    let entries: string[];
    try {
      entries = await fs.readdir(missionDirectory);
    } catch {
      return [];
    }
    const indexEntries: MainAgentReportIndexEntry[] = [];
    for (const entryName of entries.filter((name) => name.endsWith(".json"))) {
      const report = await this.readReport(missionId, entryName.slice(0, -5));
      if (report === null) {
        continue;
      }
      indexEntries.push({
        reportId: report.reportId,
        missionId: report.missionId,
        taskBundleId: report.taskBundleId,
        reportingAgentInstanceId: report.reportingAgentInstanceId,
        reportKind: report.reportKind,
        summaryPreview: report.summary.slice(0, 120),
        recordedAtIso: report.createdAtIso,
        contentHash: report.contentHash,
      });
    }
    return indexEntries.sort((left, right) =>
      left.recordedAtIso.localeCompare(right.recordedAtIso),
    );
  }

  async readReport(
    missionId: string,
    reportId: string,
  ): Promise<TertiaryTerminalReport | null> {
    const reportFilePath = path.join(
      this.archiveRootDirectory,
      sanitizePathSegment(missionId),
      `${sanitizePathSegment(reportId)}.json`,
    );
    try {
      const rawContent = await fs.readFile(reportFilePath, "utf8");
      const report = JSON.parse(rawContent) as TertiaryTerminalReport;
      const { createHash } = await import("node:crypto");
      const expectedHash = `sha256:${createHash("sha256")
        .update(canonicalizeReport(report))
        .digest("hex")}`;
      if (report.contentHash !== expectedHash) {
        throw new DomainError(
          "journal-corrupted",
          `报告内容哈希不匹配: ${reportId}`,
        );
      }
      return report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

/** 报告规范化序列化（剔除 contentHash 字段；ingest 与校验口径一致）。 */
function canonicalizeReport(report: TertiaryTerminalReport): string {
  const { contentHash: _contentHash, ...canonicalFields } = report;
  void _contentHash;
  return JSON.stringify(canonicalFields);
}

export class MainAgentReportReader {
  constructor(
    private readonly ingestor: MainAgentReportArchiveIngestor,
    /** 主 Agent 上下文预算（token）。 */
    private readonly tokenBudgetTokens: number,
  ) {}

  /**
   * 只读选择报告：按任务引用过滤 + token 预算截断。
   * 不改变主 Agent 当前上下文，返回外部资料供当前轮次使用。
   */
  async selectReports(input: {
    missionId: string;
    taskBundleIdFilter: string | null;
    maxReports: number;
  }): Promise<TertiaryTerminalReport[]> {
    const index = await this.ingestor.readIndex(input.missionId);
    const filtered = input.taskBundleIdFilter
      ? index.filter(
          (entry) => entry.taskBundleId === input.taskBundleIdFilter,
        )
      : index;
    const selected: TertiaryTerminalReport[] = [];
    let usedTokens = 0;
    for (const entry of filtered.slice(-input.maxReports)) {
      const report = await this.ingestor.readReport(
        input.missionId,
        entry.reportId,
      );
      if (report === null) {
        continue;
      }
      const estimatedTokens = Math.ceil(JSON.stringify(report).length / 4);
      if (usedTokens + estimatedTokens > this.tokenBudgetTokens) {
        break;
      }
      selected.push(report);
      usedTokens += estimatedTokens;
    }
    return selected;
  }
}
