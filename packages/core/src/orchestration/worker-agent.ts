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
  ToolPort,
} from "../core/types.js";
import { runToolLoop } from "../runtime/tool-loop.js";
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

export interface WorkerAgentOptions {
  agentInstanceId: string;
  missionId: string;
  task: TaskDependencyNode;
  runtime: AgentRuntime;
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
}

export class WorkerAgent {
  private readonly cancellationController = new AbortController();
  private readonly toolCallsByCallId = new Map<string, string>();
  private lastToolCall: { toolName: string; argumentsJson: string } | null = null;
  private readonly outputTextChunks: string[] = [];

  constructor(private readonly options: WorkerAgentOptions) {}

  cancel(): void {
    this.cancellationController.abort();
  }

  async run(): Promise<WorkerOutcome> {
    const { feedbackTransport } = this.options;
    feedbackTransport.setAgentStatus(this.options.agentInstanceId, "busy");
    await this.appendArchiveEntry("assignment", `开始执行任务 ${this.options.task.id}`);
    let finalReason: WorkerOutcome = { outcome: "cancelled" };
    const toolFailureThresholdHit = new Set<string>();

    const events = await runToolLoop(
      {
        missionId: this.options.missionId,
        agentId: this.options.agentInstanceId,
        systemPrompt: buildWorkerSystemPrompt(
          this.options.task,
          this.options.archiveAttachments ?? [],
        ),
        userPrompt: this.options.task.description,
        availableToolDescriptors: [],
        maxLoopIterations: this.options.maxLoopIterations,
      },
      {
        runtime: this.options.runtime,
        toolPort: this.options.toolPort,
        maxLoopIterations: this.options.maxLoopIterations,
        cancellationSignal: this.cancellationController.signal,
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
          break;
        case "toolCallFinished": {
          const toolName =
            this.toolCallsByCallId.get(event.callId) ??
            this.lastToolCall?.toolName ??
            "unknown-tool";
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
          } else {
            this.options.failureCounter.recordSuccess(toolName);
          }
          break;
        }
        case "runFinished":
          if (finalReason.outcome === "permission-ask") {
            break;
          }
          if (event.reason === "success") {
            finalReason = {
              outcome: "success",
              summary: summarize(this.outputTextChunks),
              resultLocation: null,
            };
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
  return kind;
}

function summarize(outputTextChunks: string[]): string {
  const joined = outputTextChunks.join("").trim();
  return joined.length === 0 ? "（无文本输出）" : joined.slice(0, 300);
}
