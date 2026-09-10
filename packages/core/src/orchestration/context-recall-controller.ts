/**
 * 分级上下文回访控制（T09A-05 / ADR-0031 §11.4）。
 *
 * 请求 ASTARRAY_CONTEXT_RECALL_REQUEST_V1 的 agentInstanceId 由 harness 注入；
 * 返回顺序固定：节点索引 → 关闭胶囊 → 选定证据 → 有界完整片段。
 * - 无范围的"恢复全部历史"请求拒绝（schema + 必须带原因码/所需信息/token 预算）；
 * - 同一调用源对未变化 revision 的短时间重复请求返回既有回执与剩余等待时间；
 * - 每次任务执行的回访次数有界（活锁保护）；敏感内容 fail-closed 丢弃整个结果；
 * - 每一级只整体返回不截断；预算不足时停止并报告剩余预算与下一级可用性；
 * - 胶囊/片段按具体 agentInstanceId 隔离，不返回其他 Agent 的内容。
 */
import type { DomainErrorCode } from "../core/errors.js";
import { DomainError } from "../core/errors.js";
import {
  contextRecallRequestSchema,
  type ContextClosureCapsule,
  type ContextRecallRequest,
} from "./context-closure-schemas.js";
import type { ContextClosureCapsuleStore } from "./context-closure-capsule-store.js";

export const DEFAULT_RECALL_COOLDOWN_MILLISECONDS = 30_000;
export const DEFAULT_MAXIMUM_RECALLS_PER_TASK_EXECUTION = 3;
export const CONTEXT_RECALL_TOKEN_ESTIMATE_DIVISOR = 4;

export const CONTEXT_RECALL_TIERS = [
  "node-index",
  "closure-capsule",
  "selected-evidence",
  "bounded-full-fragment",
] as const;
export type ContextRecallTier = (typeof CONTEXT_RECALL_TIERS)[number];

export interface ContextRecallNodeIndex {
  contextNodeIdentifier: string;
  nodeRevision: number;
  missionId: string | null;
  state: string | null;
}

export interface ContextRecallControllerOptions {
  capsuleStore: ContextClosureCapsuleStore;
  nowMilliseconds?: () => number;
  recallCooldownMilliseconds?: number;
  maximumRecallsPerTaskExecution?: number;
  /** 本地敏感内容判定（DLP/名称策略）；命中即丢弃整个回访结果。 */
  containsSensitiveContent?: (text: string) => boolean;
  nodeIndexProvider?: (
    ownerAgentInstanceId: string,
    contextNodeIdentifier: string,
    nodeRevision: number,
  ) => Promise<Omit<ContextRecallNodeIndex, "contextNodeIdentifier" | "nodeRevision"> | null>;
  /** 有界完整片段提供者（不返回原文时为 null）。 */
  fullFragmentProvider?: (
    ownerAgentInstanceId: string,
    contextNodeIdentifier: string,
    nodeRevision: number,
  ) => Promise<string | null>;
}

export type ContextRecallResult =
  | { status: "refused"; errorCode: DomainErrorCode; reason: string }
  | { status: "not-found" }
  | {
      status: "repeat-receipt";
      retryAfterMilliseconds: number;
      previouslyReturnedTier: ContextRecallTier | null;
    }
  | {
      status: "ok";
      tier: ContextRecallTier;
      nodeIndex: ContextRecallNodeIndex;
      capsule: ContextClosureCapsule | null;
      selectedEvidence: string[];
      boundedFullFragment: string | null;
      estimatedTokenCount: number;
      remainingTokenCount: number;
      budgetExhausted: boolean;
      nextTierAvailable: ContextRecallTier | null;
    };

interface RecallLedgerEntry {
  returnedAtMilliseconds: number;
  tier: ContextRecallTier;
}

export class ContextRecallController {
  private readonly capsuleStore: ContextClosureCapsuleStore;
  private readonly nowMilliseconds: () => number;
  private readonly recallCooldownMilliseconds: number;
  private readonly maximumRecallsPerTaskExecution: number;
  private readonly containsSensitiveContent: (text: string) => boolean;
  private readonly nodeIndexProvider: NonNullable<
    ContextRecallControllerOptions["nodeIndexProvider"]
  >;
  private readonly fullFragmentProvider: NonNullable<
    ContextRecallControllerOptions["fullFragmentProvider"]
  >;
  private readonly recallCountByTaskExecution = new Map<string, number>();
  private readonly ledgerByCallerAndNode = new Map<string, RecallLedgerEntry>();

  constructor(options: ContextRecallControllerOptions) {
    this.capsuleStore = options.capsuleStore;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.recallCooldownMilliseconds =
      options.recallCooldownMilliseconds ?? DEFAULT_RECALL_COOLDOWN_MILLISECONDS;
    this.maximumRecallsPerTaskExecution =
      options.maximumRecallsPerTaskExecution ?? DEFAULT_MAXIMUM_RECALLS_PER_TASK_EXECUTION;
    this.containsSensitiveContent =
      options.containsSensitiveContent ?? defaultContainsSensitiveContent;
    this.nodeIndexProvider = options.nodeIndexProvider ?? (async () => null);
    this.fullFragmentProvider = options.fullFragmentProvider ?? (async () => null);
  }

  async recall(input: {
    callerAgentInstanceId: string;
    request: unknown;
    nowMilliseconds?: number;
  }): Promise<ContextRecallResult> {
    if (input.callerAgentInstanceId.length === 0) {
      throw new DomainError("context-recall-invalid", "调用者身份缺失（由 harness 注入）");
    }
    const parsedRequest = contextRecallRequestSchema.safeParse(input.request);
    if (!parsedRequest.success) {
      throw new DomainError(
        "context-recall-invalid",
        "回访请求非法（必须绑定节点/revision/原因码/所需信息/最大 token）: " +
          parsedRequest.error.message,
      );
    }
    const request: ContextRecallRequest = parsedRequest.data;
    const nowMilliseconds = input.nowMilliseconds ?? this.nowMilliseconds();

    const consumedRecalls = this.recallCountByTaskExecution.get(request.taskExecutionId) ?? 0;
    if (consumedRecalls >= this.maximumRecallsPerTaskExecution) {
      return {
        status: "refused",
        errorCode: "livelock-guard-triggered",
        reason: "同一任务执行的回访次数已达上限（活锁保护）",
      };
    }

    const ledgerKey =
      input.callerAgentInstanceId +
      "/" +
      request.contextNodeIdentifier +
      "/" +
      String(request.nodeRevision);
    const existingLedgerEntry = this.ledgerByCallerAndNode.get(ledgerKey);
    if (
      existingLedgerEntry !== undefined &&
      nowMilliseconds - existingLedgerEntry.returnedAtMilliseconds < this.recallCooldownMilliseconds
    ) {
      return {
        status: "repeat-receipt",
        retryAfterMilliseconds:
          existingLedgerEntry.returnedAtMilliseconds +
          this.recallCooldownMilliseconds -
          nowMilliseconds,
        previouslyReturnedTier: existingLedgerEntry.tier,
      };
    }

    const capsule = await this.capsuleStore.readCapsule(
      input.callerAgentInstanceId,
      "capsule-" + request.contextNodeIdentifier + "-" + String(request.nodeRevision),
    );
    const indexMetadata = await this.nodeIndexProvider(
      input.callerAgentInstanceId,
      request.contextNodeIdentifier,
      request.nodeRevision,
    );
    if (capsule === null && indexMetadata === null) {
      return { status: "not-found" };
    }
    const nodeIndex: ContextRecallNodeIndex = {
      contextNodeIdentifier: request.contextNodeIdentifier,
      nodeRevision: request.nodeRevision,
      missionId: capsule?.missionId ?? indexMetadata?.missionId ?? null,
      state: indexMetadata?.state ?? capsule?.verificationState ?? null,
    };

    const selectedEvidence = capsule === null
      ? []
      : [
          ...capsule.artifactOrCommitReferences,
          ...capsule.testEvidenceReferences,
          ...capsule.unresolvedItems,
        ];

    const candidateTexts = [
      request.requiredInformation,
      capsule?.finalDecisionSummary ?? "",
      capsule?.inputSummary ?? "",
      capsule?.outputSummary ?? "",
      ...selectedEvidence,
    ];
    if (candidateTexts.some((candidate) => this.containsSensitiveContent(candidate))) {
      return {
        status: "refused",
        errorCode: "sensitive-content-read-denied",
        reason: "回访结果命中本地敏感内容策略，整个结果被丢弃",
      };
    }

    let remainingTokenCount = request.maximumTokenCount;
    let tier: ContextRecallTier = "node-index";
    let includedCapsule: ContextClosureCapsule | null = null;
    let includedEvidence: string[] = [];
    let boundedFullFragment: string | null = null;
    let budgetExhausted = false;

    remainingTokenCount -= estimateRecallTokenCount(JSON.stringify(nodeIndex));
    if (remainingTokenCount < 0) {
      budgetExhausted = true;
      return this.finishRecallResult({
        request,
        tier,
        nodeIndex,
        capsule: null,
        selectedEvidence: [],
        boundedFullFragment: null,
        remainingTokenCount: Math.max(0, remainingTokenCount),
        budgetExhausted,
        nextTierAvailable: "closure-capsule",
        nowMilliseconds,
        ledgerKey,
        input,
      });
    }

    if (capsule !== null) {
      const capsuleTokens = estimateRecallTokenCount(JSON.stringify(capsule));
      if (capsuleTokens <= remainingTokenCount) {
        includedCapsule = capsule;
        tier = "closure-capsule";
        remainingTokenCount -= capsuleTokens;
      } else {
        budgetExhausted = true;
        return this.finishRecallResult({
          request,
          tier,
          nodeIndex,
          capsule: null,
          selectedEvidence: [],
          boundedFullFragment: null,
          remainingTokenCount,
          budgetExhausted,
          nextTierAvailable: "closure-capsule",
          nowMilliseconds,
          ledgerKey,
          input,
        });
      }
    }

    if (selectedEvidence.length > 0) {
      const evidenceTokens = estimateRecallTokenCount(JSON.stringify(selectedEvidence));
      if (evidenceTokens <= remainingTokenCount) {
        includedEvidence = selectedEvidence;
        tier = "selected-evidence";
        remainingTokenCount -= evidenceTokens;
      } else {
        budgetExhausted = true;
        return this.finishRecallResult({
          request,
          tier,
          nodeIndex,
          capsule: includedCapsule,
          selectedEvidence: [],
          boundedFullFragment: null,
          remainingTokenCount,
          budgetExhausted,
          nextTierAvailable: "selected-evidence",
          nowMilliseconds,
          ledgerKey,
          input,
        });
      }
    }

    const fullFragment = await this.fullFragmentProvider(
      input.callerAgentInstanceId,
      request.contextNodeIdentifier,
      request.nodeRevision,
    );
    if (fullFragment !== null) {
      const fragmentTokens = estimateRecallTokenCount(fullFragment);
      if (fragmentTokens <= remainingTokenCount) {
        boundedFullFragment = fullFragment;
        tier = "bounded-full-fragment";
        remainingTokenCount -= fragmentTokens;
      } else {
        budgetExhausted = true;
        return this.finishRecallResult({
          request,
          tier,
          nodeIndex,
          capsule: includedCapsule,
          selectedEvidence: includedEvidence,
          boundedFullFragment: null,
          remainingTokenCount,
          budgetExhausted,
          nextTierAvailable: "bounded-full-fragment",
          nowMilliseconds,
          ledgerKey,
          input,
        });
      }
    }

    return this.finishRecallResult({
      request,
      tier,
      nodeIndex,
      capsule: includedCapsule,
      selectedEvidence: includedEvidence,
      boundedFullFragment,
      remainingTokenCount,
      budgetExhausted,
      nextTierAvailable: null,
      nowMilliseconds,
      ledgerKey,
      input,
    });
  }

  private finishRecallResult(input: {
    request: ContextRecallRequest;
    tier: ContextRecallTier;
    nodeIndex: ContextRecallNodeIndex;
    capsule: ContextClosureCapsule | null;
    selectedEvidence: string[];
    boundedFullFragment: string | null;
    remainingTokenCount: number;
    budgetExhausted: boolean;
    nextTierAvailable: ContextRecallTier | null;
    nowMilliseconds: number;
    ledgerKey: string;
    input: { callerAgentInstanceId: string; request: unknown };
  }): ContextRecallResult {
    const estimatedTokenCount = input.request.maximumTokenCount - input.remainingTokenCount;
    this.ledgerByCallerAndNode.set(input.ledgerKey, {
      returnedAtMilliseconds: input.nowMilliseconds,
      tier: input.tier,
    });
    this.recallCountByTaskExecution.set(
      input.request.taskExecutionId,
      (this.recallCountByTaskExecution.get(input.request.taskExecutionId) ?? 0) + 1,
    );
    return {
      status: "ok",
      tier: input.tier,
      nodeIndex: input.nodeIndex,
      capsule: input.capsule,
      selectedEvidence: input.selectedEvidence,
      boundedFullFragment: input.boundedFullFragment,
      estimatedTokenCount,
      remainingTokenCount: input.remainingTokenCount,
      budgetExhausted: input.budgetExhausted,
      nextTierAvailable: input.nextTierAvailable,
    };
  }
}

export function estimateRecallTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / CONTEXT_RECALL_TOKEN_ESTIMATE_DIVISOR));
}

function defaultContainsSensitiveContent(text: string): boolean {
  return /(api[_-]?key\s*[:=]|secret\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY|\.env\b)/i.test(text);
}
