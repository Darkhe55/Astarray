/**
 * 任务链累计预算控制器（T07E-04 / ADR-0029 §2/§4）。
 *
 * - 任务链累计来源清单跨所有 Agent 保存：新建 Agent、模型/Provider 切换、
 *   早停续跑、进程重启与 handoff 不能清零（防止通过无限创建 Agent 隐藏
 *   总读取量）；
 * - 任务链累计文件数有上限（防分裂绕过）；超过时拒绝新来源注册；
 * - 每个 Agent 仍保持自己的 10 文件活动工作集（个体预算相互隔离）；
 * - 任务链累计状态持久化（重启/handoff 后读取保持）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import { DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION } from "./working-set-schemas.js";

/** 任务链累计来源文件数上限（默认 = 10 倍单 Agent 预算；防无限分裂）。 */
export const DEFAULT_MAXIMUM_TASK_CHAIN_CUMULATIVE_SOURCE_FILES =
  DEFAULT_MAXIMUM_DISTINCT_PROJECT_CONTENT_FILES_PER_AGENT_ACTIVATION * 10;

export interface TaskChainCumulativeBudgetOptions {
  /** 任务链累计预算状态目录（<base>/task-chain-budget）。 */
  stateBaseDirectory: string;
  maximumTaskChainCumulativeSourceFiles?: number;
}

export interface TaskChainCumulativeBudgetSnapshot {
  taskChainIdentifier: string;
  cumulativeSourceFileCount: number;
  cumulativeModelVisibleBytes: number;
  cumulativeEstimatedTokenCount: number;
  participatingAgentInstanceIds: string[];
  maximumCumulativeSourceFiles: number;
}

export class TaskChainCumulativeBudgetController {
  private readonly stateRootDirectory: string;
  private readonly maximumTaskChainCumulativeSourceFiles: number;
  /** 任务链 → 累计来源集合（规范身份）。 */
  private readonly cumulativeSourcesByIdentity = new Map<string, Set<string>>();
  /** 任务链 → 参与 Agent 集合。 */
  private readonly participatingAgentsByIdentity = new Map<string, Set<string>>();
  /** 任务链 → 累计字节。 */
  private readonly cumulativeBytesByIdentity = new Map<string, number>();

  constructor(options: TaskChainCumulativeBudgetOptions) {
    this.stateRootDirectory = path.join(
      options.stateBaseDirectory,
      "task-chain-budget",
    );
    this.maximumTaskChainCumulativeSourceFiles =
      options.maximumTaskChainCumulativeSourceFiles ??
      DEFAULT_MAXIMUM_TASK_CHAIN_CUMULATIVE_SOURCE_FILES;
  }

  private stateFilePath(taskChainIdentifier: string): string {
    return path.join(
      this.stateRootDirectory,
      `${sanitizePathSegment(taskChainIdentifier)}.json`,
    );
  }

  /** 注册任务链来源（跨 Agent 累计；上限拒绝；重启后读取持久化保持）。 */
  async registerTaskChainSource(input: {
    taskChainIdentifier: string;
    agentInstanceId: string;
    canonicalSourceIdentity: string;
    contentBytes: number;
    estimatedTokenCount: number;
  }): Promise<{ cumulativeSourceFileCount: number; isBudgetExceeded: boolean }> {
    await this.loadStateIfNeeded(input.taskChainIdentifier);
    const sources = this.getCumulativeSources(input.taskChainIdentifier);
    if (
      sources.size >= this.maximumTaskChainCumulativeSourceFiles &&
      !sources.has(input.canonicalSourceIdentity)
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `任务链累计来源文件数已达上限 ${this.maximumTaskChainCumulativeSourceFiles}（防止通过无限创建 Agent 隐藏总读取量）`,
      );
    }
    sources.add(input.canonicalSourceIdentity);
    this.getParticipatingAgents(input.taskChainIdentifier).add(input.agentInstanceId);
    this.cumulativeBytesByIdentity.set(
      input.taskChainIdentifier,
      (this.cumulativeBytesByIdentity.get(input.taskChainIdentifier) ?? 0) +
        input.contentBytes,
    );
    await this.persistState(input.taskChainIdentifier);
    return {
      cumulativeSourceFileCount: sources.size,
      isBudgetExceeded: sources.size >= this.maximumTaskChainCumulativeSourceFiles,
    };
  }

  /** 读取任务链累计预算快照（重启/handoff 后保持一致）。 */
  async getBudgetSnapshot(
    taskChainIdentifier: string,
  ): Promise<TaskChainCumulativeBudgetSnapshot | null> {
    await this.loadStateIfNeeded(taskChainIdentifier);
    const sources = this.cumulativeSourcesByIdentity.get(taskChainIdentifier);
    if (sources === undefined) {
      return null;
    }
    const cumulativeBytes =
      this.cumulativeBytesByIdentity.get(taskChainIdentifier) ?? 0;
    return {
      taskChainIdentifier,
      cumulativeSourceFileCount: sources.size,
      cumulativeModelVisibleBytes: cumulativeBytes,
      cumulativeEstimatedTokenCount: Math.ceil(cumulativeBytes / 4),
      participatingAgentInstanceIds: [
        ...(this.participatingAgentsByIdentity.get(taskChainIdentifier) ?? []),
      ],
      maximumCumulativeSourceFiles: this.maximumTaskChainCumulativeSourceFiles,
    };
  }

  /** 重启/handoff：新实例读取持久化状态（不清零）。 */
  async loadStateIfNeeded(taskChainIdentifier: string): Promise<void> {
    if (this.cumulativeSourcesByIdentity.has(taskChainIdentifier)) {
      return;
    }
    try {
      const rawContent = await fs.readFile(
        this.stateFilePath(taskChainIdentifier),
        "utf8",
      );
      const parsed = JSON.parse(rawContent) as {
        sources: string[];
        agentInstanceIds: string[];
        cumulativeBytes: number;
      };
      this.cumulativeSourcesByIdentity.set(
        taskChainIdentifier,
        new Set(parsed.sources),
      );
      this.participatingAgentsByIdentity.set(
        taskChainIdentifier,
        new Set(parsed.agentInstanceIds),
      );
      this.cumulativeBytesByIdentity.set(
        taskChainIdentifier,
        parsed.cumulativeBytes,
      );
    } catch {
      // 首次使用：无持久化状态
    }
  }

  private async persistState(taskChainIdentifier: string): Promise<void> {
    await fs.mkdir(this.stateRootDirectory, { recursive: true });
    const sources = this.cumulativeSourcesByIdentity.get(taskChainIdentifier);
    const agentInstanceIds = this.participatingAgentsByIdentity.get(
      taskChainIdentifier,
    );
    if (sources === undefined || agentInstanceIds === undefined) {
      return;
    }
    await fs.writeFile(
      this.stateFilePath(taskChainIdentifier),
      `${JSON.stringify(
        {
          sources: [...sources],
          agentInstanceIds: [...agentInstanceIds],
          cumulativeBytes:
            this.cumulativeBytesByIdentity.get(taskChainIdentifier) ?? 0,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  private getCumulativeSources(taskChainIdentifier: string): Set<string> {
    let sources = this.cumulativeSourcesByIdentity.get(taskChainIdentifier);
    if (sources === undefined) {
      sources = new Set();
      this.cumulativeSourcesByIdentity.set(taskChainIdentifier, sources);
    }
    return sources;
  }

  private getParticipatingAgents(taskChainIdentifier: string): Set<string> {
    let agents = this.participatingAgentsByIdentity.get(taskChainIdentifier);
    if (agents === undefined) {
      agents = new Set();
      this.participatingAgentsByIdentity.set(taskChainIdentifier, agents);
    }
    return agents;
  }
}