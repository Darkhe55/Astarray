/**
 * Agent 运行事件流（AgentRuntime.run 的产出）。
 * UI 与 headless CLI 消费同一事件流；领域层不依赖 UI。
 */

export type AgentEvent =
  | {
      kind: "runStarted";
      agentId: string;
      missionId: string | null;
      startedAtIso: string;
    }
  | {
      kind: "textDelta";
      deltaText: string;
    }
  | {
      kind: "toolCallRequested";
      callId: string;
      toolName: string;
      argumentsJson: string;
    }
  | {
      kind: "toolCallFinished";
      callId: string;
      result: "success" | "error";
      outputSummary: string;
      /** 工具执行失败时的稳定错误码（如 permission-ask-pending）。 */
      errorCode?: string;
    }
  | {
      kind: "statusChanged";
      agentId: string;
      previousStatus: "idle" | "busy" | "blocked";
      nextStatus: "idle" | "busy" | "blocked";
    }
  | {
      kind: "runFinished";
      agentId: string;
      reason:
        | "success"
        | "tool-calls"
        | "tool-failure-threshold"
        | "ambiguous"
        | "max-iterations"
        | "cancelled"
        | "error";
      detail: string;
    }
  | {
      kind: "errorOccurred";
      errorCode: string;
      errorMessage: string;
    };
