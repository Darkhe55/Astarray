/**
 * 确定性脚本运行时（T07）。
 * 用于测试：模拟流式输出、工具调用、成功、失败、超时与取消。
 * 每个 run 消耗一个步骤，返回单次迭代事件流。
 */
import type { AgentEvent } from "../core/events.js";
import type {
  AgentRunInput,
  AgentRuntime,
} from "../core/types.js";

export type ScriptedRunStep =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolName: string;
      argumentsJson: string;
      callId: string;
    }
  | {
      type: "finish";
      reason:
        | "success"
        | "tool-calls"
        | "tool-failure-threshold"
        | "ambiguous"
        | "error";
      detail: string;
    };

export class ScriptedRuntime implements AgentRuntime {
  private readonly scriptedSteps: ScriptedRunStep[];
  private stepIndex = 0;

  constructor(scriptedSteps: ScriptedRunStep[]) {
    this.scriptedSteps = [...scriptedSteps];
  }

  getRemainingStepCount(): number {
    return this.scriptedSteps.length - this.stepIndex;
  }

  async *run(
    agentRunInput: AgentRunInput,
    cancellationSignal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (cancellationSignal.aborted) {
      yield {
        kind: "runFinished",
        agentId: agentRunInput.agentId,
        reason: "cancelled",
        detail: "脚本运行被取消",
      };
      return;
    }
    // 一次 run 模拟一次 provider 迭代：连续产出文本/工具调用步骤，
    // 直到（且包含）finish 步骤或脚本耗尽。
    while (this.stepIndex < this.scriptedSteps.length) {
      if (cancellationSignal.aborted) {
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "cancelled",
          detail: "脚本运行被取消",
        };
        return;
      }
      const step = this.scriptedSteps[this.stepIndex];
      if (step === undefined) {
        yield {
          kind: "runFinished",
          agentId: agentRunInput.agentId,
          reason: "error",
          detail: "脚本步骤缺失",
        };
        return;
      }
      this.stepIndex += 1;
      switch (step.type) {
        case "text":
          yield {
            kind: "textDelta",
            deltaText: step.text,
          };
          break;
        case "tool-call":
          yield {
            kind: "toolCallRequested",
            callId: step.callId,
            toolName: step.toolName,
            argumentsJson: step.argumentsJson,
          };
          break;
        case "finish":
          yield {
            kind: "runFinished",
            agentId: agentRunInput.agentId,
            reason: step.reason,
            detail: step.detail,
          };
          return;
      }
    }
    yield {
      kind: "runFinished",
      agentId: agentRunInput.agentId,
      reason: "error",
      detail: "脚本步骤已耗尽",
    };
  }
}
