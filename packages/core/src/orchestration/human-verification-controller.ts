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
import { CLOSED_CONTEXT_NODE_STATES } from "./local-context-graph-store.js";
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
   * 列出该 owner 已签收的 `<nodeIdentifier>@<contextGraphRevision>` 组合（只读）。
   *
   * **2026-10-10 新增**：`recordUserAcceptance` 不推进节点状态，故"是否已验收"只能由
   * 签收记录回答。条目（节点, revision）已有签收 ⇒ 不再是待追认。
   * 损坏的签收文件**跳过**（不因单个坏文件让整个列表不可用），但读取失败不静默吞异常。
   */
  private async listAcceptedNodeRevisions(
    ownerAgentInstanceId: string,
  ): Promise<Set<string>> {
    const acceptancesDirectoryPath = path.join(
      this.baseDirectory,
      "agent-memory",
      sanitizePathSegment(ownerAgentInstanceId),
      "acceptances",
    );
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(acceptancesDirectoryPath);
    } catch {
      return new Set<string>();
    }
    const acceptedNodeRevisions = new Set<string>();
    for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await fs.readFile(path.join(acceptancesDirectoryPath, fileName), "utf8"),
        );
      } catch {
        continue;
      }
      const record = parsed as {
        contextGraphRevision?: unknown;
        nodeIdentifiers?: unknown;
      };
      if (
        typeof record.contextGraphRevision !== "number" ||
        !Array.isArray(record.nodeIdentifiers)
      ) {
        continue;
      }
      for (const nodeIdentifier of record.nodeIdentifiers) {
        if (typeof nodeIdentifier === "string") {
          acceptedNodeRevisions.add(
            nodeIdentifier + "@" + String(record.contextGraphRevision),
          );
        }
      }
    }
    return acceptedNodeRevisions;
  }

  /**
   * 清除某节点**全部**待追认条目（否决导致节点重开时调用）。
   *
   * 返回被清除的 taskIdentifier 列表，便于调用方/测试断言（不静默）。
   * 逐个删除而非通配：只删该节点名下的条目，不触碰其他节点的待追认。
   */
  private async removeDeferredVerificationTasksForNode(
    ownerAgentInstanceId: string,
    contextNodeIdentifier: string,
  ): Promise<string[]> {
    const removedTaskIdentifiers: string[] = [];
    for (const task of await this.listDeferredVerificationTasks(ownerAgentInstanceId)) {
      if (task.contextNodeIdentifier !== contextNodeIdentifier) {
        continue;
      }
      await fs.rm(
        this.deferredVerificationTaskFilePath(ownerAgentInstanceId, task.taskIdentifier),
        { force: true },
      );
      removedTaskIdentifiers.push(task.taskIdentifier);
    }
    return removedTaskIdentifiers;
  }

  /** 读取单个延迟核验任务（不存在返回 null；损坏 fail-closed）。 */
  async readDeferredVerificationTask(
    ownerAgentInstanceId: string,
    taskIdentifier: string,
  ): Promise<DeferredHumanVerificationTask | null> {
    const filePath = this.deferredVerificationTaskFilePath(
      ownerAgentInstanceId,
      taskIdentifier,
    );
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const parsed = deferredHumanVerificationTaskSchema.safeParse(
      JSON.parse(rawContent),
    );
    if (!parsed.success) {
      throw new DomainError(
        "journal-corrupted",
        "延迟核验任务损坏，拒绝读取: " + taskIdentifier,
      );
    }
    return parsed.data;
  }

  /** 列出该 Agent 的全部延迟核验任务（重启对账/去重依据）。 */
  async listDeferredVerificationTasks(
    ownerAgentInstanceId: string,
  ): Promise<DeferredHumanVerificationTask[]> {
    const directoryPath = this.deferredVerificationTaskDirectoryPath(
      ownerAgentInstanceId,
    );
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(directoryPath);
    } catch {
      return [];
    }
    const tasks: DeferredHumanVerificationTask[] = [];
    /**
     * **2026-10-10 修复（真实用户报告「裁决失败：internal-error」）**：
     * 待追认条目只带 `contextNodeIdentifier`，不带 mission/图标识；而"该条目是否
     * 仍可裁决"取决于其节点**当前是否仍为已关闭态**。列出注定失败的条目，
     * 界面就必然给出一个点了必失败的按钮（实测：否决 ⇒ `context-node-not-closable`
     * ⇒ 路由未映射 ⇒ HTTP 500 `internal-error`）。
     *
     * 故按节点当前状态过滤：**只有节点仍处于已关闭态的条目才算待追认**。
     * 无法在任一图中定位到该节点时同样不列出（fail-closed）。
     */
    /**
     * **2026-10-10 修复（真实用户报告「追认后条目仍在」）**：
     * `recordUserAcceptance` 只写签收记录、**不推进上下文图节点状态**，故节点会一直停在
     * `deferred-review-closed`。若只看节点状态，已签收的条目会继续列出 ⇒ 用户可**重复追认**、
     * 界面也不反映"已验收"（实测：签收文件已落盘，`/verifications` 仍返回该条目）。
     *
     * 故除节点状态外，还要排除**已有签收记录**的（节点, revision）组合。
     */
    const acceptedNodeRevisions = await this.listAcceptedNodeRevisions(ownerAgentInstanceId);
    const pendingReviewNodeIdentifiers = new Set<string>();
    if (this.graphStore !== null) {
      for (const graphIdentifier of await this.graphStore.listGraphIdentifiers(
        ownerAgentInstanceId,
      )) {
        const graph = await this.graphStore.readGraph(
          ownerAgentInstanceId,
          graphIdentifier,
        );
        for (const node of graph?.nodes ?? []) {
          /**
           * **只认 `deferred-review-closed`**（待人工验收）—— 不能用"任一已关闭态"：
           * `accepted-closed` 表示**已验收**，此时条目**必须消失**（否则用户可重复追认、
           * 界面也不反映已验收）。实测：追认成功写入签收后，节点仍停在
           * `deferred-review-closed`（`recordUserAcceptance` 只写签收记录、不推进节点），
           * 若按"任一关闭态"过滤，条目会继续列出。
           */
          if (node.state === "deferred-review-closed") {
            pendingReviewNodeIdentifiers.add(node.contextNodeIdentifier);
          }
        }
      }
    }
    for (const fileName of fileNames
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const task = await this.readDeferredVerificationTask(
        ownerAgentInstanceId,
        fileName.slice(0, -".json".length),
      );
      if (
        task !== null &&
        pendingReviewNodeIdentifiers.has(task.contextNodeIdentifier) &&
        !acceptedNodeRevisions.has(
          task.contextNodeIdentifier + "@" + String(task.contextGraphRevision),
        )
      ) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  private deferredVerificationTaskDirectoryPath(
    ownerAgentInstanceId: string,
  ): string {
    return path.join(
      this.baseDirectory,
      "agent-memory",
      sanitizePathSegment(ownerAgentInstanceId),
      "deferred-verification-tasks",
    );
  }

  private deferredVerificationTaskFilePath(
    ownerAgentInstanceId: string,
    taskIdentifier: string,
  ): string {
    return path.join(
      this.deferredVerificationTaskDirectoryPath(ownerAgentInstanceId),
      sanitizePathSegment(taskIdentifier) + ".json",
    );
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
        const targetNode = currentGraph.nodes.find(
          (node) => node.contextNodeIdentifier === nodeIdentifier,
        );
        /**
         * **2026-10-10 修复（真实用户报告「裁决失败：internal-error」）**：
         * 只有**已关闭**节点可以重新开放。若节点已非关闭态（例如本条目是**修复前**
         * 的旧服务器否决后残留的陈旧条目，节点早已 `reopened`），直接 `reopenNode`
         * 会抛 `context-node-not-closable`，GUI 未映射该码 ⇒ 500 `internal-error`。
         *
         * 语义上该条目已无意义（对应的关闭早已作废）⇒ **不重开、不报错**，
         * 仍记入 `reopenedNodeIdentifiers` 以便下方清除这条陈旧条目；
         * 至于"节点已非关闭态"这一事实，调用方（公共 SDK）另行显式判定并给出
         * 稳定业务错误码，不在本控制器里静默吞掉。
         */
        const isClosed =
          targetNode !== undefined &&
          (CLOSED_CONTEXT_NODE_STATES as readonly string[]).includes(targetNode.state);
        if (isClosed) {
          await this.graphStore.reopenNode({
            ownerAgentInstanceId: input.ownerAgentInstanceId,
            graphIdentifier: input.graphIdentifier,
            expectedGraphRevision: currentGraph.revision,
            contextNodeIdentifier: nodeIdentifier,
          });
        }
        reopenedNodeIdentifiers.push(nodeIdentifier);
      }
    }
    /**
     * **2026-10-10 修复（真实用户人工体验发现）**：节点被重开 ⇒ 图 revision 前进 ⇒
     * 已有的待追认条目**绑定的是旧 revision**，而 `recordUserAcceptance` 要求
     * `contextGraphRevision === currentContextGraphRevision` ⇒ 那条条目**永远追认不了**
     * （用户实测："点否决显示节点重开，条目未消失，再点追认显示裁决失败：stale-revision"）。
     *
     * 语义上，被否决的关闭已经作废，针对它的待追认也就**失效**：这里把它清掉，
     * 让返修后**在新 revision 上重新完成**时再产生新条目。清除是安全的 ——
     * 若不清除，条目会以旧 revision 永久滞留且必然 `stale-revision`（死条目）。
     */
    for (const nodeIdentifier of reopenedNodeIdentifiers) {
      await this.removeDeferredVerificationTasksForNode(
        input.ownerAgentInstanceId,
        nodeIdentifier,
      );
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
