/**
 * 工匠工作流生命周期控制器（T08D-05 / ADR-0027 §2/§6）。
 *
 * - 工匠一次激活只处理一条"工作流定制"任务链（单链约束）；
 * - 只使用所属次级当前可分发且已存在的基础工具子集：bundle 引用的
 *   工具必须全部已存在且已授权（isToolAvailable），否则拒绝；
 * - 需要新依赖/能力时只能上报缺口（blocked-with-dependency-gap），
 *   不授予安装/注册/权限；
 * - 工匠不能担任自己产物的最终验收 Agent：验收者必须与 bundle 来源
 *   工匠不同，且验收绑定 bundleId/版本/内容哈希，变化即失效。
 */
import { DomainError } from "../core/errors.js";
import { craftsmanWorkflowBundleSchema } from "./craftsman-schemas.js";
import type { z } from "zod";

/** 已有且已授权工具端口（装配方注入现有工具目录/权限目录）。 */
export interface CraftsmanToolAvailabilityPort {
  isToolAvailable(toolId: string): Promise<boolean>;
}

export interface CraftsmanWorkflowLifecycleControllerOptions {
  toolAvailabilityPort: CraftsmanToolAvailabilityPort;
  /** 工匠是否已登记（不可复用身份；非空字符串不是认证）。 */
  isRegisteredCraftsman: (agentInstanceId: string) => Promise<boolean>;
}

export type WorkflowBundleSubmissionResult =
  | { outcome: "accepted"; bundleId: string }
  | {
      outcome: "blocked-with-dependency-gap";
      missingToolReferences: string[];
      reason: string;
    };

export interface WorkflowBundleAcceptanceRecord {
  bundleId: string;
  bundleVersion: number;
  bundleContentHash: string;
  acceptingAgentInstanceId: string;
  verdict: "accepted" | "rejected";
  reason: string;
  createdAtIso: string;
}

export class CraftsmanWorkflowLifecycleController {
  private readonly toolAvailabilityPort: CraftsmanToolAvailabilityPort;
  private readonly isRegisteredCraftsman: (
    agentInstanceId: string,
  ) => Promise<boolean>;
  /** 单链约束：当前活跃的工作流定制任务链（一次一条）。 */
  private activeWorkflowChainId: string | null = null;
  private readonly bundleAcceptances = new Map<
    string,
    WorkflowBundleAcceptanceRecord[]
  >();
  /** bundleId → 来源工匠映射（提交时记录；验收自验拒绝用）。 */
  private readonly bundleSourceAgentsById = new Map<string, string>();

  constructor(options: CraftsmanWorkflowLifecycleControllerOptions) {
    this.toolAvailabilityPort = options.toolAvailabilityPort;
    this.isRegisteredCraftsman = options.isRegisteredCraftsman;
  }

  /**
   * 提交工作流 bundle：
   * 1) schema 校验；2) 来源工匠已登记；3) 单链约束（同一工匠同时只
   *    有一条活跃工作流定制链）；4) 工具约束（全部已存在且已授权；
   *    缺失 → blocked-with-dependency-gap，不授予安装/注册/权限）。
   */
  async submitWorkflowBundle(input: {
    craftsmanAgentInstanceId: string;
    workflowChainId: string;
    bundle: z.input<typeof craftsmanWorkflowBundleSchema>;
  }): Promise<WorkflowBundleSubmissionResult> {
    const isRegistered = await this.isRegisteredCraftsman(
      input.craftsmanAgentInstanceId,
    );
    if (!isRegistered) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `工匠 Agent 未登记（非空字符串不是认证）: ${input.craftsmanAgentInstanceId}`,
      );
    }
    if (
      this.activeWorkflowChainId !== null &&
      this.activeWorkflowChainId !== input.workflowChainId
    ) {
      throw new DomainError(
        "invalid-task-chain",
        `工匠一次激活只处理一条工作流定制任务链（当前活跃: ${this.activeWorkflowChainId}）`,
      );
    }
    const parsedBundle = craftsmanWorkflowBundleSchema.safeParse(input.bundle);
    if (!parsedBundle.success) {
      throw new DomainError(
        "invalid-task-chain",
        `工匠工作流 bundle 非法: ${parsedBundle.error.message}`,
      );
    }
    const bundle = parsedBundle.data;
    if (bundle.sourceAgentInstanceId !== input.craftsmanAgentInstanceId) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `bundle 来源必须等于提交工匠: ${bundle.sourceAgentInstanceId}`,
      );
    }
    // 工具约束：全部已存在且已授权
    const missingToolReferences: string[] = [];
    for (const toolReference of bundle.usedToolReferences) {
      if (!(await this.toolAvailabilityPort.isToolAvailable(toolReference.toolId))) {
        missingToolReferences.push(toolReference.toolId);
      }
    }
    if (missingToolReferences.length > 0) {
      return {
        outcome: "blocked-with-dependency-gap",
        missingToolReferences,
        reason:
          "需要新依赖/能力；工匠只能上报缺口，未获授权不得自行安装或注册新工具",
      };
    }
    this.activeWorkflowChainId = input.workflowChainId;
    this.bundleAcceptances.set(bundle.bundleId, []);
    this.bundleSourceAgentsById.set(bundle.bundleId, input.craftsmanAgentInstanceId);
    return { outcome: "accepted", bundleId: bundle.bundleId };
  }

  /** 释放工作流定制链（任务完成/中断后；单链约束解除）。 */
  releaseWorkflowChain(): void {
    this.activeWorkflowChainId = null;
  }

  /**
   * 记录 bundle 验收：验收者必须与 bundle 来源工匠不同（不能自验），
   * 且绑定 bundleId/版本/内容哈希；变化使旧验收失效。
   */
  async recordBundleAcceptance(input: {
    bundleId: string;
    bundleVersion: number;
    bundleContentHash: string;
    acceptingAgentInstanceId: string;
    verdict: "accepted" | "rejected";
    reason: string;
  }): Promise<WorkflowBundleAcceptanceRecord> {
    const existingAcceptances = this.bundleAcceptances.get(input.bundleId);
    if (existingAcceptances === undefined) {
      throw new DomainError(
        "dependency-not-found",
        `bundle 不存在: ${input.bundleId}`,
      );
    }
    // 验收者与来源工匠不同（作者不能自验）：查 bundle 来源
    const sourceAgent = await this.findBundleSourceAgent(input.bundleId);
    if (sourceAgent === null) {
      throw new DomainError("dependency-not-found", `bundle 来源未知: ${input.bundleId}`);
    }
    if (input.acceptingAgentInstanceId === sourceAgent) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `工匠不能担任自己产物的最终验收 Agent（作者自验被拒）`,
      );
    }
    const record: WorkflowBundleAcceptanceRecord = {
      bundleId: input.bundleId,
      bundleVersion: input.bundleVersion,
      bundleContentHash: input.bundleContentHash,
      acceptingAgentInstanceId: input.acceptingAgentInstanceId,
      verdict: input.verdict,
      reason: input.reason,
      createdAtIso: new Date().toISOString(),
    };
    this.bundleAcceptances.set(input.bundleId, [
      ...existingAcceptances,
      record,
    ]);
    return record;
  }

  /** 某 bundle 是否已获不同 Agent 验收（版本/哈希一致）。 */
  isBundleAccepted(input: {
    bundleId: string;
    bundleVersion: number;
    bundleContentHash: string;
  }): boolean {
    const acceptances = this.bundleAcceptances.get(input.bundleId) ?? [];
    return acceptances.some(
      (record) =>
        record.verdict === "accepted" &&
        record.bundleVersion === input.bundleVersion &&
        record.bundleContentHash === input.bundleContentHash,
    );
  }

  private async findBundleSourceAgent(
    bundleId: string,
  ): Promise<string | null> {
    return this.bundleSourceAgentsById.get(bundleId) ?? null;
  }
}