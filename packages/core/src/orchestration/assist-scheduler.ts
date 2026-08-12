/**
 * Assist 次级调度 Agent（T08）。
 * 拥有自己的 mailbox（recipientId = scheduler:<missionId>）：
 * 接收主 Agent 的裁决指令与三级 Agent 的汇报，处理无法裁决时转回用户。
 */
import type { FeedbackMessage, FeedbackTransportPort } from "../core/types.js";
import { MissionOrchestrator } from "./mission-orchestrator.js";
import type { MissionOrchestratorOptions } from "./mission-orchestrator.js";

export interface SchedulerInstruction {
  action: "unblock" | "retry" | "cancel" | "reassign";
  taskId: string;
  assignedAgentId?: string;
}

export type AssistSchedulerOptions = Omit<
  MissionOrchestratorOptions,
  "onMissionFinished" | "onUserEscalation"
> & {
  feedbackTransport: FeedbackTransportPort;
  /** 主 Agent 侧注册：接收调度层上报（mission 完成 / 需要用户裁决）。 */
  onReportToMain?: (message: FeedbackMessage) => void | Promise<void>;
};

export class AssistScheduler extends MissionOrchestrator {
  private readonly feedbackTransport: FeedbackTransportPort;

  constructor(private readonly assistOptions: AssistSchedulerOptions) {
    super({
      ...assistOptions,
      onMissionFinished: (status) => {
        return assistOptions.onReportToMain?.(
          buildSystemInstruction(
            assistOptions.missionId,
            `任务完成状态: ${status}`,
            `mission-finished:${assistOptions.missionId}:${status}`,
          ),
        );
      },
      onUserEscalation: (message) => {
        void assistOptions.onReportToMain?.(
          buildSystemInstruction(
            assistOptions.missionId,
            message,
            `escalation:${assistOptions.missionId}:${Date.now()}`,
          ),
        );
      },
      feedbackTransportFactory: async () => assistOptions.feedbackTransport,
    });
    this.feedbackTransport = assistOptions.feedbackTransport;
    assistOptions.feedbackTransport.onMessage((message) => {
      if (
        message.recipientId === `scheduler:${assistOptions.missionId}` &&
        message.payload.kind === "instruction"
      ) {
        this.handleInstruction(message.payload.instructionText);
      }
    });
  }

  /** 解析主 Agent 下发的指令。无法解析时转回用户。 */
  handleInstruction(instructionText: string): void {
    const parsed = parseSchedulerInstruction(instructionText);
    if (parsed === null) {
      this.reportEscalation(`指令无法解析: ${instructionText}`);
      return;
    }
    switch (parsed.action) {
      case "unblock":
        void this.unblockTask(parsed.taskId);
        break;
      case "retry":
      case "reassign":
        void this.reassignTask(parsed.taskId);
        break;
      case "cancel":
        void this.cancelTask(parsed.taskId);
        break;
    }
  }

  getFeedbackTransport(): FeedbackTransportPort {
    return this.feedbackTransport;
  }

  private reportEscalation(message: string): void {
    void this.assistOptions.onReportToMain?.(
      buildSystemInstruction(
        this.assistOptions.missionId,
        message,
        `escalation:${this.assistOptions.missionId}:${Date.now()}`,
      ),
    );
  }
}

export function parseSchedulerInstruction(
  instructionText: string,
): SchedulerInstruction | null {
  try {
    const parsed = JSON.parse(instructionText) as Partial<SchedulerInstruction>;
    if (
      typeof parsed.action !== "string" ||
      !["unblock", "retry", "cancel", "reassign"].includes(parsed.action) ||
      typeof parsed.taskId !== "string" ||
      parsed.taskId.length === 0
    ) {
      return null;
    }
    return {
      action: parsed.action as SchedulerInstruction["action"],
      taskId: parsed.taskId,
      assignedAgentId: parsed.assignedAgentId,
    };
  } catch {
    return null;
  }
}

export function buildSystemInstruction(
  missionId: string,
  instructionText: string,
  idempotencyKey: string,
): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: {
      sourceType: "system",
      sourceIdentifier: missionId,
      componentName: "assist-scheduler",
    },
    recipientId: `main:${missionId}`,
    priority: "instruction",
    createdAtIso: new Date().toISOString(),
    idempotencyKey,
    payload: { kind: "instruction", instructionText },
  };
}
