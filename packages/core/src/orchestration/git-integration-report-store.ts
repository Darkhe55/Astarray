/**
 * Git 集成报告存储（T05B / ADR-0012 §可追溯记录）。
 * 保存结构化分流、审查、拒绝、冲突、测试与合并记录，并与次级 Agent
 * 工作存档关联（missionId + integratingAgentInstanceId）。
 * 路径：<baseDirectory>/missions/<missionId>/git-integration/reports/<integrationSessionId>.json
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { gitIntegrationReportSchema } from "../core/schemas.js";
import type { GitIntegrationReport } from "../core/types.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";

export interface GitIntegrationReportStoreOptions {
  baseDirectory: string;
}

export class GitIntegrationReportStore {
  private readonly reportsRootDirectory: string;

  constructor(options: GitIntegrationReportStoreOptions) {
    this.reportsRootDirectory = path.join(
      options.baseDirectory,
      "git-integration",
    );
  }

  async saveReport(report: GitIntegrationReport): Promise<void> {
    const parsed = gitIntegrationReportSchema.safeParse(report);
    if (!parsed.success) {
      throw new DomainError(
        "invalid-task-chain",
        `集成报告非法: ${parsed.error.message}`,
      );
    }
    const reportDirectory = path.join(
      this.reportsRootDirectory,
      sanitizePathSegment(report.missionId),
      "reports",
    );
    const reportFilePath = path.join(
      reportDirectory,
      `${sanitizePathSegment(report.integratingAgentInstanceId)}.json`,
    );
    await writeAtomicJson(reportFilePath, parsed.data);
  }

  async readReport(
    missionId: string,
    integratingAgentInstanceId: string,
  ): Promise<GitIntegrationReport | null> {
    const reportFilePath = path.join(
      this.reportsRootDirectory,
      sanitizePathSegment(missionId),
      "reports",
      `${sanitizePathSegment(integratingAgentInstanceId)}.json`,
    );
    let rawContent: string;
    try {
      const { readFile } = await import("node:fs/promises");
      rawContent = await readFile(reportFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch {
      throw new DomainError(
        "journal-corrupted",
        `集成报告非法: ${missionId}/${integratingAgentInstanceId}`,
      );
    }
    const parsed = gitIntegrationReportSchema.safeParse(parsedContent);
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        `集成报告非法: ${missionId}/${integratingAgentInstanceId}（${parsed.error.message}）`,
      );
    }
    return parsed.data;
  }
}
