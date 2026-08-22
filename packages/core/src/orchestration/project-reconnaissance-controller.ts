/**
 * 项目侦察控制器（T08C-04 / ADR-0025 §3）。
 *
 * 次级创建/复用一个具体的 project-reconnaissance 三级 Agent，只分配只读
 * 任务链与最小读取工具子集；侦察 Agent 生成带来源/revision/hash 的
 * PROJECT_CONTEXT_DIGEST_V1。敏感内容禁读、反自指和读取活锁保护对侦察
 * 同样生效（本控制器在 digest 落盘前校验文件引用不涉敏感路径）。
 */
import { DomainError } from "../core/errors.js";
import {
  projectContextDigestSchema,
  projectReconnaissanceTaskSchema,
} from "./agent-routing-schemas.js";
import type { ProjectReconnaissanceDigestStore } from "./project-reconnaissance-digest-store.js";
import type { z } from "zod";

/** 只读类工具类别（侦察 Agent 最小读取子集上限；不允许写入/执行/网络/备份）。 */
const READ_ONLY_TOOL_CATEGORIES = new Set([
  "project-read",
  "project-search",
  "project-status",
]);

/** 敏感路径匹配端口（装配方注入 SensitiveContentAccessPolicy.matchSensitivePathName）。 */
export interface SensitivePathMatchPort {
  matchSensitivePathName(filePath: string): string | null;
}

/** 侦察 Agent 来源认证端口（具体侦察 Agent 是否由本次级创建/已登记）。 */
export interface ReconnaissanceSourceAuthenticationPort {
  isRegisteredReconnaissance(agentInstanceId: string): Promise<boolean>;
}

export interface ProjectReconnaissanceControllerOptions {
  digestStore: ProjectReconnaissanceDigestStore;
  sensitivePathMatchPort: SensitivePathMatchPort;
  sourceAuthenticationPort: ReconnaissanceSourceAuthenticationPort;
}

export class ProjectReconnaissanceController {
  private readonly digestStore: ProjectReconnaissanceDigestStore;
  private readonly sensitivePathMatchPort: SensitivePathMatchPort;
  private readonly sourceAuthenticationPort: ReconnaissanceSourceAuthenticationPort;

  constructor(options: ProjectReconnaissanceControllerOptions) {
    this.digestStore = options.digestStore;
    this.sensitivePathMatchPort = options.sensitivePathMatchPort;
    this.sourceAuthenticationPort = options.sourceAuthenticationPort;
  }

  /**
   * 创建侦察任务：校验 schema，确认工具子集只读（不含写/执行/网络/备份），
   * 否则拒绝。本方法不执行任何读取。
   */
  async createReconnaissanceTask(input: {
    task: z.input<typeof projectReconnaissanceTaskSchema>;
  }): Promise<z.infer<typeof projectReconnaissanceTaskSchema>> {
    const parsedTask = projectReconnaissanceTaskSchema.safeParse(input.task);
    if (!parsedTask.success) {
      throw new DomainError(
        "invalid-task-chain",
        `侦察任务声明非法: ${parsedTask.error.message}`,
      );
    }
    const task = parsedTask.data;
    const nonReadOnlyTool = task.allowedReadToolNames.find(
      (toolName) => !READ_ONLY_TOOL_CATEGORIES.has(toolName),
    );
    if (nonReadOnlyTool !== undefined) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `侦察 Agent 只能获得只读读取工具，拒绝非只读工具: ${nonReadOnlyTool}`,
      );
    }
    return task;
  }

  /**
   * 记录侦察摘要：校验 schema、来源侦察 Agent 已登记、token 预算非负、
   * 文件引用路径不涉敏感内容；写存储并标记同扫描范围旧摘要为 stale。
   */
  async recordDigest(input: {
    digest: z.input<typeof projectContextDigestSchema>;
  }): Promise<void> {
    const parsedDigest = projectContextDigestSchema.safeParse(input.digest);
    if (!parsedDigest.success) {
      throw new DomainError(
        "invalid-task-chain",
        `侦察摘要非法: ${parsedDigest.error.message}`,
      );
    }
    const digest = parsedDigest.data;
    const isRegistered = await this.sourceAuthenticationPort.isRegisteredReconnaissance(
      digest.reconnaissanceAgentInstanceId,
    );
    if (!isRegistered) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `侦察 Agent 未登记（非空字符串不是认证）: ${digest.reconnaissanceAgentInstanceId}`,
      );
    }
    for (const reference of digest.relevantFileReferences) {
      const matchedCategory =
        this.sensitivePathMatchPort.matchSensitivePathName(reference.filePath);
      if (matchedCategory !== null) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `侦察摘要引用敏感路径（类别: ${matchedCategory}），拒绝: ${reference.filePath}`,
        );
      }
    }
    // 同扫描范围旧摘要标记 stale（增量复查而非重新注入全部历史）
    const existingDigests = await this.digestStore.listDigests();
    for (const existing of existingDigests) {
      if (
        existing.digestId !== digest.digestId &&
        existing.scanningScope === digest.scanningScope &&
        !existing.isStale
      ) {
        await this.digestStore.markStale(existing.digestId);
      }
    }
    await this.digestStore.saveDigest(digest);
  }

  /**
   * 项目指纹变化后请求增量复查：把指定摘要标记 stale 并返回新摘要
   * 应覆盖的增量范围（不重新注入全部历史）。
   */
  async requestIncrementalRefresh(input: {
    digestId: string;
  }): Promise<{ digestId: string; isStale: true; refreshHint: string }> {
    const marked = await this.digestStore.markStale(input.digestId);
    if (!marked) {
      throw new DomainError(
        "dependency-not-found",
        `侦察摘要不存在: ${input.digestId}`,
      );
    }
    return {
      digestId: input.digestId,
      isStale: true,
      refreshHint: "仅刷新指纹变化路径，不重新注入全部历史",
    };
  }
}
