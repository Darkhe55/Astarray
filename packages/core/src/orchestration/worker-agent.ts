/**
 * 三级执行 Agent（T08）。
 * 仅执行分配任务；异常/模糊/完成/权限请求均通过反馈工具上报后待机；
 * 不得自主扩大任务或静默放弃。
 */
import { randomUUID } from "node:crypto";

import type {
  AgentRuntime,
  AgentWorkArchiveAttachment,
  AgentWorkArchiveEntry,
  FeedbackMessage,
  FeedbackTransportPort,
  TaskDependencyNode,
  ToolDescriptor,
  ToolPort,
} from "../core/types.js";
import { CompletionControlParser } from "../core/completion-protocol.js";
import {
  extractArtifactPathFromToolCall,
  verifyArtifactExistence,
} from "./artifact-verification.js";
import { DomainError } from "../core/errors.js";
import type { ContextPromptProvider } from "./context-prompt-assembler.js";
import { runToolLoop } from "../runtime/tool-loop.js";
import type { GuidanceSafePointPort } from "../runtime/tool-loop.js";
import type { ToolFailureCounter } from "./failure-counter.js";

export type WorkerOutcome =
  | { outcome: "success"; summary: string; resultLocation: string | null }
  | {
      outcome: "failure";
      toolName: string | null;
      failureReason: string;
      stateSummary: string;
    }
  | {
      outcome: "ambiguous";
      unclearPoints: string[];
      requestedInformation: string;
    }
  | {
      outcome: "permission-ask";
      toolName: string;
      argumentsJson: string;
      explanation: string;
    }
  | { outcome: "cancelled" };

export interface ContextNodeLifecyclePort {
  completeTaskNode(input: {
    ownerAgentInstanceId: string;
    missionId: string;
    taskIdentifier: string;
    taskDescription: string;
    summaryText: string;
    modeKey: string;
  }): Promise<unknown>;
}

export interface WorkerAgentOptions {
  agentInstanceId: string;
  missionId: string;
  task: TaskDependencyNode;
  runtime: AgentRuntime;
  /** T07D-R2-03：暴露给 Provider 的工具子集描述符（默认空 = 不暴露工具）。 */
  availableToolDescriptors?: ToolDescriptor[];
  /** T07D-R2-03：Provider 运行时必须给出本地完成控制事件才允许结案。 */
  requireCompletionEvent?: boolean;
  /**
   * 产物对账的工作区根（缺省 `process.cwd()`）。
   * 用于"本 AGENT 成功写入过的路径必须真实存在才允许结案"（2026-10-02）。
   */
  artifactWorkspaceRootPath?: string;
  /** T09A-R1-01：上下文提示词装配（全局相关选择 + 局部活跃前沿）。 */
  contextPromptProvider?: ContextPromptProvider;
  /** GUIDE-01-04：运行中指导安全点端口（缺省表示该 worker 不接受运行中指导）。 */
  guidanceSafePointPort?: GuidanceSafePointPort;
  /** T09A-R1-03：任务完成后的上下文节点收口（建立/验证/关闭/胶囊/核验任务）。 */
  contextNodeLifecycle?: ContextNodeLifecyclePort | null;
  /** T09A-R1-03：当前模式（人工验收策略来源）。 */
  contextLifecycleModeKey?: string;
  toolPort: ToolPort;
  failureCounter: ToolFailureCounter;
  feedbackTransport: FeedbackTransportPort;
  maxLoopIterations: number;
  /** 权限询问说明生成器（为什么需要该工具）。 */
  buildPermissionExplanation: (toolName: string) => string;
  /** T05A：本 Agent 的独立工作存档（可选，缺失时跳过存档）。 */
  workArchiveStore?: {
    appendEntry(input: {
      missionId: string;
      agentInstanceId: string;
      agentRole: "secondary" | "tertiary";
      entry: Omit<AgentWorkArchiveEntry, "archiveEntryId" | "recordedAtIso">;
    }): Promise<unknown>;
  } | null;
  /** T05A：上级选择性附加的存档上下文列表（按属主，默认不注入完整存档）。 */
  archiveAttachments?: AgentWorkArchiveAttachment[];
  /**
   * 跨运行必需写操作契约（2026-10-02，T07D-R2-04 正向闭环修复）。
   *
   * 任务曾因权限询问被打断、且这些写类工具**至今从未成功**时，由调度侧在
   * 重跑时传入。完成门禁据此要求它们**在本次运行中成功执行**，
   * 否则不得以"本次没请求该工具"为由结案（此前只覆盖单次运行，重跑即可绕过）。
   */
  requiredMutatingToolNames?: readonly string[];
}

/**
 * 会改变本地状态（工作区/备份）的工具：一旦本轮未成功，就不得仅凭文本声明结案
 * （E2E-01-02 缺口 2：完成事件必须与真实工具结果对账）。
 */
const MUTATING_TOOL_NAMES = new Set([
  "createProjectFile",
  "replaceFileContent",
  "writeFileTemporary",
  "backupVault",
  "deleteBackup",
]);

export class WorkerAgent {
  private readonly cancellationController = new AbortController();
  private readonly toolCallsByCallId = new Map<string, string>();
  private lastToolCall: { toolName: string; argumentsJson: string } | null = null;
  private readonly outputTextChunks: string[] = [];
  /** 本轮尚未被同工具成功调用覆盖的写操作失败。 */
  private readonly unresolvedMutatingToolFailures = new Set<string>();
  /**
   * 本 AGENT 通过写类工具调用**成功**写入过的路径（本地确定性事实）。
   * 结案前必须逐条确认仍然存在；缺失即拒绝结案（验收缺失不得结案）。
   */
  private readonly persistedArtifactPaths = new Set<string>();
  /** 本 AGENT 成功执行过的写类工具（用于"必需操作是否真的执行过"的完成门禁）。 */
  private readonly successfullyExecutedMutatingTools = new Set<string>();
  /** 本 AGENT **尝试过**的写类工具（含被门禁拦下、执行失败的调用）。 */
  private readonly attemptedMutatingTools = new Set<string>();

  constructor(private readonly options: WorkerAgentOptions) {}

  cancel(): void {
    this.cancellationController.abort();
  }

  /** T07D-R2-03：本地完成门禁——必须解析出声明本任务的版本化完成事件。 */
  private verifyCompletionControlEvent(): string | null {
    const parser = new CompletionControlParser();
    const parsed = parser.parseTextOutput({
      finalOutputText: this.outputTextChunks.join(""),
      markerGracePeriodLines: 1,
    });
    if (parsed.kind === "blocked") {
      return (
        "模型声明任务阻塞，未满足完成门禁: " + parsed.event.blockReason
      );
    }
    if (parsed.kind !== "completion") {
      return "缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）";
    }
    if (!parsed.event.completedTaskIdentifiers.includes(this.options.task.id)) {
      return "完成事件未声明本任务: " + this.options.task.id;
    }
    // 产物对账（2026-10-02）：本 AGENT 成功写入过的路径 + 完成事件显式声明的产物，
    // 必须真实存在；否则属"验收缺失"，不得结案。
    const declaredArtifacts = parsed.event.declaredArtifacts ?? [];
    const artifactEvidence = verifyArtifactExistence({
      artifactPaths: [...this.persistedArtifactPaths, ...declaredArtifacts],
      workspaceRootPath: this.options.artifactWorkspaceRootPath ?? process.cwd(),
    });
    const failedArtifactGates = artifactEvidence.filter((evidence) => !evidence.passed);
    if (failedArtifactGates.length > 0) {
      return (
        "完成声明与本地产物不一致：以下产物不存在（验收缺失，不得结案）——" +
        failedArtifactGates.map((evidence) => evidence.gateName).join("；")
      );
    }
    /**
     * 必需操作是否真的执行过（2026-10-02 阻断项修复）：
     * **确实尝试过写类工具、但一次都没成功**时不得结案——
     * 否则"工具被门禁拦下却声称完成"会结案 done（真实 CLI 实测缺陷）。
     * 只读任务从不尝试写工具，因此不受此规则影响。
     */
    const hasAttemptedMutatingTool = [...this.attemptedMutatingTools].length > 0;
    if (hasAttemptedMutatingTool && this.successfullyExecutedMutatingTools.size === 0) {
      return (
        "必需操作未成功执行：本次尝试过的写类工具（" +
        [...this.attemptedMutatingTools].join("、") +
        "）从未成功执行（验收缺失，不得以文本声明结案）"
      );
    }
    /**
     * 跨运行必需写操作契约（2026-10-02，T07D-R2-04 正向闭环修复）：
     * 该任务此前曾因权限询问被打断，而这些写类工具**至今从未成功**。
     * 即使本次运行根本没有请求它们（模型可能直接宣称完成），也不得结案——
     * 否则"授权后续跑 → 不再请求工具 → 假 done"会绕过上面的单次运行规则。
     */
    const requiredNotYetSucceeded = (this.options.requiredMutatingToolNames ?? [])
      .filter((toolName) => !this.successfullyExecutedMutatingTools.has(toolName));
    if (requiredNotYetSucceeded.length > 0) {
      return (
        "必需操作未成功执行：本任务此前因权限询问被打断、且以下写类工具至今从未成功（" +
        requiredNotYetSucceeded.join("、") +
        "）（验收缺失，不得以文本声明结案）"
      );
    }
    return null;
  }

  async run(): Promise<WorkerOutcome> {
    const { feedbackTransport } = this.options;
    feedbackTransport.setAgentStatus(this.options.agentInstanceId, "busy");
    await this.appendArchiveEntry("assignment", `开始执行任务 ${this.options.task.id}`);
    let finalReason: WorkerOutcome = { outcome: "cancelled" };
    const toolFailureThresholdHit = new Set<string>();

    let systemPrompt = buildWorkerSystemPrompt(
      this.options.task,
      this.options.archiveAttachments ?? [],
    );
    /**
     * 跨运行必需操作契约的**提示侧**（2026-10-02 T07D-R2-04）：
     * 让重跑知道"上次因权限被打断、本次必须真正执行这些工具"，
     * 而不是把重跑当成一次全新任务（此前正是这样导致直接声称完成）。
     */
    const requiredMutatingToolNames = this.options.requiredMutatingToolNames ?? [];
    if (requiredMutatingToolNames.length > 0) {
      systemPrompt +=
        "\n\n【续跑约束】本任务此前因权限询问被打断，以下工具**本次必须真正执行成功**，" +
        "不得仅以文本声明完成：" +
        requiredMutatingToolNames.join("、") +
        "。如仍被拒绝，请如实上报阻塞，不要声称已完成。";
    }
    const contextPromptProvider = this.options.contextPromptProvider;
    if (contextPromptProvider !== undefined) {
      const assembledContext = await contextPromptProvider({
        missionId: this.options.missionId,
        agentInstanceId: this.options.agentInstanceId,
        task: this.options.task,
      });
      if (assembledContext.unsatisfiedNecessaryConditionIdentifiers.length > 0) {
        throw new DomainError(
          "context-mandatory-constraint-missing",
          "缺少必要上下文约束，阻塞而非静默执行: " +
            assembledContext.unsatisfiedNecessaryConditionIdentifiers.join(", "),
        );
      }
      systemPrompt = assembledContext.promptText + "\n\n" + systemPrompt;
    }

    const events = await runToolLoop(
      {
        missionId: this.options.missionId,
        agentId: this.options.agentInstanceId,
        systemPrompt,
        userPrompt: this.options.task.description,
        availableToolDescriptors: this.options.availableToolDescriptors ?? [],
        maxLoopIterations: this.options.maxLoopIterations,
      },
      {
        runtime: this.options.runtime,
        toolPort: this.options.toolPort,
        maxLoopIterations: this.options.maxLoopIterations,
        cancellationSignal: this.cancellationController.signal,
        guidanceSafePointPort: this.options.guidanceSafePointPort,
      },
    );
    for await (const event of events) {
      switch (event.kind) {
        case "textDelta":
          this.outputTextChunks.push(event.deltaText);
          break;
        case "toolCallRequested":
          this.lastToolCall = {
            toolName: event.toolName,
            argumentsJson: event.argumentsJson,
          };
          this.toolCallsByCallId.set(event.callId, event.toolName);
          /**
           * 在**请求时刻**登记"尝试过的写类工具"（2026-10-02 修复）：
           * 被权限门禁拦下的调用不会产生工具结果，若只在结果处登记，
           * 则"从未执行却声称完成"会漏过完成门禁（真实 CLI 实测缺陷）。
           */
          if (MUTATING_TOOL_NAMES.has(event.toolName)) {
            this.attemptedMutatingTools.add(event.toolName);
          }
          break;
        case "toolCallFinished": {
          const toolName =
            this.toolCallsByCallId.get(event.callId) ??
            this.lastToolCall?.toolName ??
            "unknown-tool";
          if (MUTATING_TOOL_NAMES.has(toolName)) {
            this.attemptedMutatingTools.add(toolName);
          }
          if (event.result === "error" && event.errorCode === "permission-ask-pending") {
            finalReason = {
              outcome: "permission-ask",
              toolName,
              argumentsJson: this.lastToolCall?.argumentsJson ?? "{}",
              explanation: this.options.buildPermissionExplanation(toolName),
            };
            continue;
          }
          if (event.result === "error") {
            const thresholdReached = this.options.failureCounter.recordFailure(toolName);
            if (thresholdReached) {
              toolFailureThresholdHit.add(toolName);
            }
            if (MUTATING_TOOL_NAMES.has(toolName)) {
              this.unresolvedMutatingToolFailures.add(toolName);
            }
          } else {
            this.options.failureCounter.recordSuccess(toolName);
            this.unresolvedMutatingToolFailures.delete(toolName);
            if (MUTATING_TOOL_NAMES.has(toolName)) {
              this.successfullyExecutedMutatingTools.add(toolName);
            }
            // 写类工具成功 → 登记其目标路径，供结案前的产物存在性对账。
            const persistedArtifactPath = extractArtifactPathFromToolCall({
              toolName,
              argumentsJson: this.lastToolCall?.argumentsJson ?? "{}",
            });
            if (persistedArtifactPath !== null) {
              this.persistedArtifactPaths.add(persistedArtifactPath);
            }
          }
          break;
        }
        case "runFinished":
          if (finalReason.outcome === "permission-ask") {
            break;
          }
          if (event.reason === "success") {
            const completionGateFailure = this.options.requireCompletionEvent
              ? this.verifyCompletionControlEvent()
              : null;
            const unresolvedMutatingTools = [
              ...this.unresolvedMutatingToolFailures,
            ];
            if (completionGateFailure !== null) {
              finalReason = {
                outcome: "failure",
                toolName: null,
                failureReason: completionGateFailure,
                stateSummary: summarize(this.outputTextChunks),
              };
            } else if (unresolvedMutatingTools.length > 0) {
              // 完成声明与本地工具结果不一致：写操作未成功，禁止以文本结案。
              finalReason = {
                outcome: "failure",
                toolName: unresolvedMutatingTools[0] ?? null,
                failureReason:
                  "完成声明与本地工具结果不一致：" +
                  unresolvedMutatingTools.join("、") +
                  " 未成功（不得以文本声明结案）",
                stateSummary: summarize(this.outputTextChunks),
              };
            } else {
              finalReason = {
                outcome: "success",
                summary: summarize(this.outputTextChunks),
                resultLocation: null,
              };
            }
          } else if (event.reason === "ambiguous") {
            finalReason = {
              outcome: "ambiguous",
              unclearPoints: [event.detail],
              requestedInformation: "请提供任务所需的关键信息",
            };
          } else if (event.reason === "cancelled") {
            finalReason = { outcome: "cancelled" };
          } else if (toolFailureThresholdHit.size > 0) {
            const thresholdToolName = [...toolFailureThresholdHit][0] ?? "unknown-tool";
            finalReason = {
              outcome: "failure",
              toolName: thresholdToolName,
              failureReason: `工具 ${thresholdToolName} 连续失败达到阈值`,
              stateSummary: summarize(this.outputTextChunks),
            };
          } else {
            finalReason = {
              outcome: "failure",
              toolName: null,
              failureReason: event.detail,
              stateSummary: summarize(this.outputTextChunks),
            };
          }
          break;
        default:
          break;
      }
    }
    await this.appendArchiveEntryForOutcome(finalReason);
    if (
      finalReason.outcome === "success" &&
      this.options.contextNodeLifecycle !== undefined &&
      this.options.contextNodeLifecycle !== null
    ) {
      await this.options.contextNodeLifecycle.completeTaskNode({
        ownerAgentInstanceId: this.options.agentInstanceId,
        missionId: this.options.missionId,
        taskIdentifier: this.options.task.id,
        taskDescription: this.options.task.description,
        summaryText: finalReason.summary,
        modeKey: this.options.contextLifecycleModeKey ?? "assist",
      });
    }
    await this.reportOutcome(finalReason);
    feedbackTransport.setAgentStatus(this.options.agentInstanceId, "idle");
    return finalReason;
  }

  private async appendArchiveEntry(
    entryType: AgentWorkArchiveEntry["entryType"],
    summary: string,
    artifactReferences: string[] = [],
  ): Promise<void> {
    const store = this.options.workArchiveStore;
    if (store === null || store === undefined) {
      return;
    }
    await store.appendEntry({
      missionId: this.options.missionId,
      agentInstanceId: this.options.agentInstanceId,
      agentRole: "tertiary",
      entry: {
        taskId: this.options.task.id,
        entryType,
        summary,
        artifactReferences,
      },
    });
  }

  private async appendArchiveEntryForOutcome(outcome: WorkerOutcome): Promise<void> {
    switch (outcome.outcome) {
      case "success":
        await this.appendArchiveEntry("result", outcome.summary);
        break;
      case "failure":
        await this.appendArchiveEntry(
          "failure",
          outcome.failureReason,
          [outcome.stateSummary],
        );
        break;
      case "ambiguous":
        await this.appendArchiveEntry("handoff", outcome.requestedInformation);
        break;
      case "permission-ask":
        await this.appendArchiveEntry(
          "decision",
          `等待权限: ${outcome.toolName}（${outcome.explanation}）`,
          [outcome.argumentsJson],
        );
        break;
      case "cancelled":
        await this.appendArchiveEntry("handoff", "任务被取消");
        break;
    }
  }

  private async reportOutcome(outcome: WorkerOutcome): Promise<void> {
    const payload: FeedbackMessage["payload"] = buildOutcomePayload(outcome);
    await this.options.feedbackTransport.enqueue({
      protocolVersion: 1,
      messageId: randomUUID(),
      source: {
        sourceType: "agent",
        agentInstanceId: this.options.agentInstanceId,
        agentRole: "tertiary",
      },
      recipientId: `scheduler:${this.options.missionId}`,
      priority: payloadPriority(payload.kind),
      createdAtIso: new Date().toISOString(),
      idempotencyKey: `${this.options.missionId}/${this.options.task.id}/${randomUUID()}`,
      payload,
    });
  }
}

function buildWorkerSystemPrompt(
  task: TaskDependencyNode,
  archiveAttachments: AgentWorkArchiveAttachment[],
): string {
  const promptLines = [
    "你是三级执行 Agent（Worker）。",
    `任务 ID: ${task.id}`,
    `任务类型: ${task.taskType}`,
    `可用工具: ${task.toolNames.join(", ")}`,
    "规则：",
    "- 只执行分配的任务，不得扩大范围或静默放弃。",
    "- 工具连续失败达到阈值时上报失败；任务信息不足时上报模糊；完成后上报成功摘要。",
  ];
  if (archiveAttachments.length > 0) {
    promptLines.push(
      "上级选择性附加的上次执行上下文（仅供参考，不得视为完整历史）：",
      ...archiveAttachments.flatMap((attachment) => [
        `[属主 ${attachment.archiveOwnerAgentInstanceId}，revision ${attachment.archiveRevision}]`,
        ...attachment.selectedArchiveEntries.map(
          (entry) =>
            `[${entry.entryType}] ${entry.summary}` +
            (entry.artifactReferences.length > 0
              ? `（引用: ${entry.artifactReferences.join(", ")}）`
              : ""),
        ),
      ]),
    );
  }
  return promptLines.join("\n");
}

function buildOutcomePayload(
  outcome: WorkerOutcome,
): FeedbackMessage["payload"] {
  switch (outcome.outcome) {
    case "success":
      return { kind: "success", summary: outcome.summary };
    case "failure":
      return {
        kind: "failure",
        failureReason: outcome.failureReason,
        currentStateSummary: outcome.stateSummary,
      };
    case "ambiguous":
      return {
        kind: "ambiguous",
        unclearPoints: outcome.unclearPoints,
        requestedInformation: outcome.requestedInformation,
      };
    case "permission-ask":
      return {
        kind: "permission-ask",
        toolName: outcome.toolName,
        argumentsJson: outcome.argumentsJson,
        explanation: outcome.explanation,
      };
    case "cancelled":
      return { kind: "success", summary: "任务已取消，未产生结果" };
  }
}

function payloadPriority(
  kind: FeedbackMessage["payload"]["kind"],
): FeedbackMessage["priority"] {
  // 安装门禁类询问走 instruction 优先级（T06E）
  if (
    kind === "existing-resource-inquiry" ||
    kind === "assist-installation-request"
  ) {
    return "instruction";
  }
  return kind;
}

function summarize(outputTextChunks: string[]): string {
  const joined = outputTextChunks.join("").trim();
  return joined.length === 0 ? "（无文本输出）" : joined.slice(0, 300);
}