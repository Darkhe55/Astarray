/**
 * 工具帮助请求协议与响应控制器（T08B / ADR-0024 §标准请求格式、本地响应
 * 与逐级上报）。
 *
 * ToolHelpRequestSchema：校验 ASTARRAY_TOOL_HELP_REQUEST_V1 的
 * usage-help/missing-capability、任务、工具、能力意图、阻塞原因与已知
 * revision；Agent 身份、层级、直属上级、mission、真实 revision 与来源
 * 由 harness 注入，模型字段不能覆盖。
 *
 * ToolDocumentationRecallController 处理顺序：
 * 1. 已分配工具且 revision 有效 → 直接返回 ASTARRAY_TOOL_HELP_RESPONSE_V1
 *    （单工具完整公开用法 + 新回执，不重复整组）；
 * 2. 注册表存在但未分配/权限不足 → known-but-not-usable（不泄露 schema）
 *    + ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1 上报默认上级；
 * 3. 无匹配工具 → missing-tool escalation；
 * 4. 陈旧/重复/revision 不一致 → 幂等返回或要求重建。
 * 帮助响应不授予工具/权限/安装能力；isAuthorizationGranted 恒 false。
 */
import { z } from "zod";

import { DomainError } from "../core/errors.js";
import type { ToolPublicDocumentation } from "./tool-documentation-recall.js";

export const toolHelpRequestSchema = z.object({
  controlEventType: z.literal("ASTARRAY_TOOL_HELP_REQUEST_V1"),
  requestIdentifier: z.string().min(1),
  taskExecutionIdentifier: z.string().min(1),
  requestKind: z.enum(["usage-help", "missing-capability"]),
  toolIdentifier: z.string().nullable(),
  capabilityIntent: z.string().min(1),
  blockingReason: z.enum([
    "forgot-usage",
    "schema-uncertain",
    "response-uncertain",
    "not-in-assigned-tool-set",
    "no-known-match",
  ]),
  knownToolGroupRevision: z.number().int().min(0),
});

export type ToolHelpRequestV1 = z.infer<typeof toolHelpRequestSchema>;

/** 语义校验：usage-help 必须提供已分配工具 ID 且阻塞原因限三类。 */
export function validateToolHelpRequest(request: ToolHelpRequestV1): string | null {
  if (request.requestKind === "usage-help") {
    if (request.toolIdentifier === null) {
      return "usage-help 必须提供当前已分配的 toolIdentifier";
    }
    if (
      !["forgot-usage", "schema-uncertain", "response-uncertain"].includes(
        request.blockingReason,
      )
    ) {
      return `usage-help 的 blockingReason 非法: ${request.blockingReason}`;
    }
  }
  if (request.requestKind === "missing-capability") {
    if (!["not-in-assigned-tool-set", "no-known-match"].includes(request.blockingReason)) {
      return `missing-capability 的 blockingReason 非法: ${request.blockingReason}`;
    }
  }
  return null;
}

export type ToolHelpResponseResolution =
  | "usage-provided"
  | "known-but-not-usable"
  | "escalated-missing-tool"
  | "stale-request"
  | "rejected";

export interface ToolHelpResponseV1 {
  controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1";
  requestIdentifier: string;
  resolution: ToolHelpResponseResolution;
  toolIdentifier: string | null;
  toolDefinitionRevision: number | null;
  /** 仅 usage-provided 携带当前已分配工具的公开用法。 */
  usageDocumentation: ToolPublicDocumentation | null;
  escalationIdentifier: string | null;
  isAuthorizationGranted: false;
}

export interface ToolCapabilityEscalationV1 {
  controlEventType: "ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1";
  escalationId: string;
  canonicalRequestId: string;
  /** harness 注入（模型不能覆盖）。 */
  requesterAgentInstanceId: string;
  defaultSuperiorAgentInstanceId: string;
  taskExecutionIdentifier: string;
  missionId: string;
  capabilityIntent: string;
  toolIdentifier: string | null;
  currentToolGroupRevision: number;
  status: "known-but-not-usable" | "missing-tool";
  blockingReason: string;
  originalSourceAgentInstanceId: string;
  createdAtIso: string;
}

export interface ToolDocumentationRecallControllerOptions {
  /** 注册表（工具 → 公开说明 + 分配状态）。 */
  assignedToolDocumentation: Map<string, ToolPublicDocumentation>;
  /** 当前已分配工具 ID 集合。 */
  assignedToolIdentifiers: Set<string>;
  /** 当前工具组 revision。 */
  currentToolGroupRevision: number;
  /** 幂等去重（request ID → 响应）。 */
  deduplicationStore?: Map<string, ToolHelpResponseV1>;
  /** escalation 上报接收器（默认上级）。 */
  escalationSink?: (escalation: ToolCapabilityEscalationV1) => void;
  /** 已知 request ID 集（陈旧判定；可选）。 */
  seenRequestIdentifiers?: Set<string>;
  /** 防换词循环：同一 agent 的请求预算。 */
  requestBudgetByAgent?: Map<string, number>;
  maxRequestsPerAgent?: number;
}

export class ToolDocumentationRecallController {
  private readonly assignedToolDocumentation: Map<string, ToolPublicDocumentation>;
  private readonly assignedToolIdentifiers: Set<string>;
  private readonly currentToolGroupRevision: number;
  private readonly deduplicationStore: Map<string, ToolHelpResponseV1>;
  private readonly escalationSink: (escalation: ToolCapabilityEscalationV1) => void;
  private readonly seenRequestIdentifiers: Set<string>;
  private readonly requestBudgetByAgent: Map<string, number>;
  private readonly maxRequestsPerAgent: number;

  constructor(options: ToolDocumentationRecallControllerOptions) {
    this.assignedToolDocumentation = options.assignedToolDocumentation;
    this.assignedToolIdentifiers = options.assignedToolIdentifiers;
    this.currentToolGroupRevision = options.currentToolGroupRevision;
    this.deduplicationStore = options.deduplicationStore ?? new Map();
    this.escalationSink = options.escalationSink ?? (() => {});
    this.seenRequestIdentifiers = options.seenRequestIdentifiers ?? new Set();
    this.requestBudgetByAgent = options.requestBudgetByAgent ?? new Map();
    this.maxRequestsPerAgent = options.maxRequestsPerAgent ?? 20;
  }

  /**
   * 处理帮助请求（harness 注入身份）。返回响应；任何路径都不授予能力。
   */
  handleRequest(input: {
    request: ToolHelpRequestV1;
    requesterAgentInstanceId: string;
    defaultSuperiorAgentInstanceId: string;
    missionId: string;
  }): ToolHelpResponseV1 {
    // 语义校验
    const semanticError = validateToolHelpRequest(input.request);
    if (semanticError !== null) {
      return {
        controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1",
        requestIdentifier: input.request.requestIdentifier,
        resolution: "rejected",
        toolIdentifier: input.request.toolIdentifier,
        toolDefinitionRevision: null,
        usageDocumentation: null,
        escalationIdentifier: null,
        isAuthorizationGranted: false,
      };
    }
    // 换词循环预算
    const usedBudget = this.requestBudgetByAgent.get(input.requesterAgentInstanceId) ?? 0;
    if (usedBudget >= this.maxRequestsPerAgent) {
      return {
        controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1",
        requestIdentifier: input.request.requestIdentifier,
        resolution: "rejected",
        toolIdentifier: null,
        toolDefinitionRevision: null,
        usageDocumentation: null,
        escalationIdentifier: null,
        isAuthorizationGranted: false,
      };
    }
    this.requestBudgetByAgent.set(input.requesterAgentInstanceId, usedBudget + 1);
    // 幂等去重
    const cached = this.deduplicationStore.get(input.request.requestIdentifier);
    if (cached !== undefined) {
      return { ...cached };
    }
    // 陈旧 revision（模型声明的 revision 落后于当前）
    if (input.request.knownToolGroupRevision < this.currentToolGroupRevision) {
      const staleResponse: ToolHelpResponseV1 = {
        controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1",
        requestIdentifier: input.request.requestIdentifier,
        resolution: "stale-request",
        toolIdentifier: null,
        toolDefinitionRevision: this.currentToolGroupRevision,
        usageDocumentation: null,
        escalationIdentifier: null,
        isAuthorizationGranted: false,
      };
      this.deduplicationStore.set(input.request.requestIdentifier, staleResponse);
      return staleResponse;
    }
    // 1) 已分配工具 → 直接返回单工具用法
    if (
      input.request.requestKind === "usage-help" &&
      input.request.toolIdentifier !== null &&
      this.assignedToolIdentifiers.has(input.request.toolIdentifier)
    ) {
      const documentation = this.assignedToolDocumentation.get(
        input.request.toolIdentifier,
      );
      if (documentation === undefined) {
        throw new DomainError(
          "invalid-task-chain",
          `已分配工具缺少说明: ${input.request.toolIdentifier}`,
        );
      }
      const usageResponse: ToolHelpResponseV1 = {
        controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1",
        requestIdentifier: input.request.requestIdentifier,
        resolution: "usage-provided",
        toolIdentifier: input.request.toolIdentifier,
        toolDefinitionRevision: this.currentToolGroupRevision,
        usageDocumentation: documentation,
        escalationIdentifier: null,
        isAuthorizationGranted: false,
      };
      this.deduplicationStore.set(input.request.requestIdentifier, usageResponse);
      return usageResponse;
    }
    // 2/3) 未分配或缺失 → escalation（known-but-not-usable / missing-tool）
    const status: "known-but-not-usable" | "missing-tool" =
      input.request.requestKind === "missing-capability"
        ? "missing-tool"
        : "known-but-not-usable";
    const escalation: ToolCapabilityEscalationV1 = {
      controlEventType: "ASTARRAY_TOOL_CAPABILITY_ESCALATION_V1",
      escalationId: `escalation-${randomEscalationId()}`,
      canonicalRequestId: input.request.requestIdentifier,
      requesterAgentInstanceId: input.requesterAgentInstanceId,
      defaultSuperiorAgentInstanceId: input.defaultSuperiorAgentInstanceId,
      taskExecutionIdentifier: input.request.taskExecutionIdentifier,
      missionId: input.missionId,
      capabilityIntent: input.request.capabilityIntent,
      toolIdentifier: input.request.toolIdentifier,
      currentToolGroupRevision: this.currentToolGroupRevision,
      status,
      blockingReason: input.request.blockingReason,
      originalSourceAgentInstanceId: input.requesterAgentInstanceId,
      createdAtIso: new Date().toISOString(),
    };
    this.escalationSink(escalation);
    const escalatedResponse: ToolHelpResponseV1 = {
      controlEventType: "ASTARRAY_TOOL_HELP_RESPONSE_V1",
      requestIdentifier: input.request.requestIdentifier,
      resolution:
        status === "missing-tool" ? "escalated-missing-tool" : "known-but-not-usable",
      toolIdentifier: input.request.toolIdentifier,
      toolDefinitionRevision: null,
      usageDocumentation: null,
      escalationIdentifier: escalation.escalationId,
      isAuthorizationGranted: false,
    };
    this.deduplicationStore.set(input.request.requestIdentifier, escalatedResponse);
    return escalatedResponse;
  }
}

function randomEscalationId(): string {
  return Math.random().toString(36).slice(2, 12);
}
