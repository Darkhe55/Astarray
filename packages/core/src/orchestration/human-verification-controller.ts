/**
 * 人工验收推进策略与关闭验收控制（T09A-04 / ADR-0031 §11.3）。
 *
 * - 两态策略设置：Assist 默认 block-until-verified，Devolve 默认
 *   continue-with-deferred-review；自定义模式需显式默认值；Ponder 无运行时切换。
 * - 阻塞等待单次 pn 上限 3 小时（10800 秒）；超时保持等待，绝不自动通过。
 * - 延迟核验必须先原子写入 DEFERRED_HUMAN_VERIFICATION_TASK_V1（来源 system/tool、
 *   优先级层级 ≤1）才可进入 deferred-review-closed，且任何界面/报告不得表述为
 *   用户已验收。
 * - 用户签字绑定上下文图 revision；陈旧签字不可复用。
 * - 事后否决重开节点、标记相关全局决策 disputed 并返回返修任务提案（不执行
 *   任何破坏性 Git/文件回滚）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";
import {
  deferredHumanVerificationTaskSchema,
  type DeferredHumanVerificationTask,
  type HumanVerificationContinuationPolicy,
} from "./context-closure-schemas.js";
import type { LocalContextGraphStore } from "./local-context-graph-store.js";
import type { GlobalDecisionStore } from "./global-decision-store.js";

/** 单次人工验收等待上限（3 小时）。 */
export const MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS = 10_800;

export const HUMAN_VERIFICATION_POLICY_DOCUMENT_SCHEMA_VERSION = 1;

export type HumanVerificationModeKey =
  | "assist"
  | "devolve"
  | "ponder"
  | string;

export const humanVerificationPolicyDocumentSchema = z
  .object({
    schemaVersion: z.literal(HUMAN_VERIFICATION_POLICY_DOCUMENT_SCHEMA_VERSION),
    policyRevision: z.number().int().positive(),
    policiesByMode: z.record(
      z.string(),
      z.enum(["block-until-verified", "continue-with-deferred-review"]),
    ),
    updatedByUserId: z.string().min(1),
    updatedAtIso: z.iso.datetime(),
  })
  .strict();
export type HumanVerificationPolicyDocument = z.infer<
  typeof humanVerificationPolicyDocumentSchema
>;

export interface HumanVerificationPolicyStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

export class HumanVerificationPolicyStore {
  private readonly filePath: string;
  private readonly nowMilliseconds: () => number;
  private readonly storeLock = new AsyncMutex();

  constructor(options: HumanVerificationPolicyStoreOptions) {
    this.filePath = path.join(
      options.baseDirectory,
      "human-verification-policy.json",
    );
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /** Assist/Devolve 出厂默认；Ponder 无运行时策略（返回 null）。 */
  resolveDefaultPolicy(
    modeKey: HumanVerificationModeKey,
  ): HumanVerificationContinuationPolicy | null {
    if (modeKey === "assist") {
      return "block-until-verified";
    }
    if (modeKey === "devolve") {
      return "continue-with-deferred-review";
    }
    return null;
  }

  async getPolicy(input: {
    modeKey: HumanVerificationModeKey;
    customProfileDefaultPolicy?: HumanVerificationContinuationPolicy;
  }): Promise<HumanVerificationContinuationPolicy> {
    if (input.modeKey === "ponder") {
      throw new DomainError(
        "human-verification-policy-invalid",
        "Ponder 不产生关闭写入，不提供人工验收推进策略切换",
      );
    }
    const document = await this.readDocument();
    const explicitPolicy = document?.policiesByMode[input.modeKey];
    if (explicitPolicy !== undefined) {
      return explicitPolicy;
    }
    const defaultPolicy = this.resolveDefaultPolicy(input.modeKey);
    if (defaultPolicy !== null) {
      return defaultPolicy;
    }
    if (input.customProfileDefaultPolicy !== undefined) {
      return input.customProfileDefaultPolicy;
    }
    throw new DomainError(
      "human-verification-policy-invalid",
      "自定义模式必须显式提供默认人工验收策略: " + input.modeKey,
    );
  }

  async setPolicy(input: {
    modeKey: HumanVerificationModeKey;
    policy: HumanVerificationContinuationPolicy;
    expectedPolicyRevision: number;
    updatedByUserId: string;
  }): Promise<HumanVerificationPolicyDocument> {
    if (input.modeKey === "ponder") {
      throw new DomainError(
        "human-verification-policy-invalid",
        "Ponder 不可配置人工验收推进策略",
      );
    }
    return this.storeLock.runExclusive(async () => {
      const current = await this.readDocument();
      const currentRevision = current?.policyRevision ?? 0;
      if (currentRevision !== input.expectedPolicyRevision) {
        throw new DomainError(
          "stale-revision",
          "人工验收策略 revision 不匹配: 现有 " +
            currentRevision +
            "，期望 " +
            input.expectedPolicyRevision,
        );
      }
      const nextDocument: HumanVerificationPolicyDocument = {
        schemaVersion: HUMAN_VERIFICATION_POLICY_DOCUMENT_SCHEMA_VERSION,
        policyRevision: currentRevision + 1,
        policiesByMode: {
          ...(current?.policiesByMode ?? {}),
          [input.modeKey]: input.policy,
        },
        updatedByUserId: input.updatedByUserId,
        updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      };
      const parsed = humanVerificationPolicyDocumentSchema.safeParse(nextDocument);
      if (!parsed.success) {
        throw new DomainError(
          "human-verification-policy-invalid",
          "人工验收策略文档非法: " + parsed.error.message,
        );
      }
      await writeAtomicJson(this.filePath, parsed.data);
      return parsed.data;
    });
  }

  async readDocument(): Promise<HumanVerificationPolicyDocument | null> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      const parsed = humanVerificationPolicyDocumentSchema.safeParse(
        JSON.parse(rawContent),
      );
      if (!parsed.success) {
        throw new DomainError(
          "human-verification-policy-invalid",
          "人工验收策略文档损坏: " + parsed.error.message,
        );
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "journal-corrupted",
        "人工验收策略文档损坏，拒绝读取: " + this.filePath,
      );
    }
  }
}

export interface HumanVerificationControllerOptions {
  baseDirectory: string;
  graphStore?: LocalContextGraphStore | null;
  globalDecisionStore?: GlobalDecisionStore | null;
  nowMilliseconds?: () => number;
}

export interface AcceptanceWaitState {
  state: "awaiting-user-acceptance";
  deadlineIso: string;
  maximumWaitSeconds: number;
  isTimedOut: boolean;
  shouldAutoApprove: false;
}

export interface RejectionResult {
  reopenedNodeIdentifiers: string[];
  disputedGlobalDecisionIdentifiers: string[];
  reworkTaskProposal: {
    priorityTier: 1;
    sourceKind: "system";
    description: string;
  };
}

export class HumanVerificationController {
  private readonly baseDirectory: string;
  private readonly graphStore: LocalContextGraphStore | null;
  private readonly globalDecisionStore: GlobalDecisionStore | null;
  private readonly nowMilliseconds: () => number;

  constructor(options: HumanVerificationControllerOptions) {
    this.baseDirectory = options.baseDirectory;
    this.graphStore = options.graphStore ?? null;
    this.globalDecisionStore = options.globalDecisionStore ?? null;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  beginAcceptanceWait(input: { startIso: string; requestedWaitSeconds?: number }): AcceptanceWaitState {
    const requestedWaitSeconds = Math.min(
      Math.max(input.requestedWaitSeconds ?? MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS, 1),
      MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS,
    );
    const deadlineMilliseconds =
      Date.parse(input.startIso) + requestedWaitSeconds * 1000;
    return {
      state: "awaiting-user-acceptance",
      deadlineIso: new Date(deadlineMilliseconds).toISOString(),
      maximumWaitSeconds: MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS,
      isTimedOut: false,
      shouldAutoApprove: false,
    };
  }

  evaluateAcceptanceTimeout(input: {
    deadlineIso: string;
    nowIso?: string;
  }): AcceptanceWaitState {
    const nowMilliseconds = input.nowIso !== undefined
      ? Date.parse(input.nowIso)
      : this.nowMilliseconds();
    return {
      state: "awaiting-user-acceptance",
      deadlineIso: input.deadlineIso,
      maximumWaitSeconds: MAXIMUM_HUMAN_ACCEPTANCE_WAIT_SECONDS,
      isTimedOut: nowMilliseconds >= Date.parse(input.deadlineIso),
      shouldAutoApprove: false,
    };
  }

  /** 用户验收签字：必须绑定当前上下文图 revision，陈旧签字拒绝。 */
  async recordUserAcceptance(input: {
    ownerAgentInstanceId: string;
    contextGraphRevision: number;
    currentContextGraphRevision: number;
    nodeIdentifiers: string[];
    summaryHash: string;
    userId: string;
  }): Promise<{ acceptanceIdentifier: string; contextGraphRevision: number }> {
    if (input.contextGraphRevision !== input.currentContextGraphRevision) {
      throw new DomainError(
        "stale-revision",
        "用户签字绑定的上下文图 revision 已过期，禁止复用: " +
          input.contextGraphRevision +
          " != " +
          input.currentContextGraphRevision,
      );
    }
    const acceptanceIdentifier =
      "accept-" +
      input.ownerAgentInstanceId +
      "-" +
      input.contextGraphRevision +
      "-" +
      (this.nowMilliseconds()).toString(36);
    await writeAtomicJson(
      path.join(
        this.baseDirectory,
        "agent-memory",
        sanitizePathSegment(input.ownerAgentInstanceId),
        "acceptances",
        sanitizePathSegment(acceptanceIdentifier) + ".json",
      ),
      {
        acceptanceIdentifier,
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        contextGraphRevision: input.contextGraphRevision,
        nodeIdentifiers: input.nodeIdentifiers,
        summaryHash: input.summaryHash,
        userId: input.userId,
        createdAtIso: new Date(this.nowMilliseconds()).toISOString(),
      },
    );
    return { acceptanceIdentifier, contextGraphRevision: input.contextGraphRevision };
  }

  /** 延迟核验：必须先写补充任务（system/tool 来源、层级 ≤1）才能进入 deferred 状态。 */
  async createDeferredVerificationTask(input: {
    taskIdentifier: string;
    ownerAgentInstanceId: string;
    contextNodeIdentifier: string;
    contextGraphRevision: number;
    closureCapsuleHash: string;
    humanSteps: string;
    priorityTier: number;
    artifactOrCommitReferences?: string[];
    automaticTestReferences?: string[];
    risks?: string[];
  }): Promise<DeferredHumanVerificationTask> {
    if (!(input.priorityTier <= 1)) {
      throw new DomainError(
        "human-verification-policy-invalid",
        "延迟人工核验任务来源为 system/tool，优先级层级必须 ≤1（不能冒充用户层级 0）",
      );
    }
    const task: DeferredHumanVerificationTask = {
      schemaVersion: 1,
      taskIdentifier: input.taskIdentifier,
      contextNodeIdentifier: input.contextNodeIdentifier,
      contextGraphRevision: input.contextGraphRevision,
      closureCapsuleHash: input.closureCapsuleHash,
      artifactOrCommitReferences: input.artifactOrCommitReferences ?? [],
      automaticTestReferences: input.automaticTestReferences ?? [],
      risks: input.risks ?? [],
      humanSteps: input.humanSteps,
      priorityTier: input.priorityTier,
      createdAtIso: new Date(this.nowMilliseconds()).toISOString(),
    };
    const parsed = deferredHumanVerificationTaskSchema.safeParse(task);
    if (!parsed.success) {
      throw new DomainError(
        "human-verification-policy-invalid",
        "延迟人工核验任务非法: " + parsed.error.message,
      );
    }
    await writeAtomicJson(
      path.join(
        this.baseDirectory,
        "agent-memory",
        sanitizePathSegment(input.ownerAgentInstanceId),
        "deferred-verification-tasks",
        sanitizePathSegment(input.taskIdentifier) + ".json",
      ),
      parsed.data,
    );
    return parsed.data;
  }

  /**
   * 事后否决：重开节点（可选经图存储）、把相关全局决策标记 disputed、
   * 返回层级 1 返修任务提案；不执行任何破坏性回滚。
   */
  async recordUserRejection(input: {
    ownerAgentInstanceId: string;
    graphIdentifier: string;
    allNodeIdentifiers: string[];
    relatedGlobalDecisionIdentifiers?: string[];
    reason: string;
  }): Promise<RejectionResult> {
    const reopenedNodeIdentifiers: string[] = [];
    if (this.graphStore !== null) {
      const graph = await this.graphStore.readGraph(
        input.ownerAgentInstanceId,
        input.graphIdentifier,
      );
      if (graph === null) {
        throw new DomainError(
          "context-graph-not-found",
          "上下文图不存在: " + input.graphIdentifier,
        );
      }
      for (const nodeIdentifier of input.allNodeIdentifiers) {
        const currentGraph = await this.graphStore.readGraph(
          input.ownerAgentInstanceId,
          input.graphIdentifier,
        );
        if (currentGraph === null) {
          break;
        }
        await this.graphStore.reopenNode({
          ownerAgentInstanceId: input.ownerAgentInstanceId,
          graphIdentifier: input.graphIdentifier,
          expectedGraphRevision: currentGraph.revision,
          contextNodeIdentifier: nodeIdentifier,
        });
        reopenedNodeIdentifiers.push(nodeIdentifier);
      }
    }
    const disputedGlobalDecisionIdentifiers: string[] = [];
    if (this.globalDecisionStore !== null) {
      for (const decisionIdentifier of input.relatedGlobalDecisionIdentifiers ?? []) {
        await this.globalDecisionStore.appendStatusEvent({
          globalDecisionIdentifier: decisionIdentifier,
          eventType: "status-changed",
          nextStatus: "disputed",
          reason: "事后人工否决: " + input.reason,
        });
        disputedGlobalDecisionIdentifiers.push(decisionIdentifier);
      }
    }
    return {
      reopenedNodeIdentifiers,
      disputedGlobalDecisionIdentifiers,
      reworkTaskProposal: {
        priorityTier: 1,
        sourceKind: "system",
        description: "返修被否决的关闭节点: " + input.reason,
      },
    };
  }
}
