/**
 * Devolve 调度（T08）。
 * 主 Agent 直接承担调度职责：复用同一任务链、反馈进程、Worker 与工具策略边界；
 * 指令由主 Agent 直接调用方法（不经反馈信箱）。
 */
import { MissionOrchestrator } from "./mission-orchestrator.js";
import type { MissionOrchestratorOptions } from "./mission-orchestrator.js";

export type DevolveSchedulerOptions = Omit<
  MissionOrchestratorOptions,
  "onMissionFinished" | "onUserEscalation"
> & {
  onMissionFinished: (status: "done" | "cancelled") => void;
  onUserEscalation: (message: string) => void;
};

export class DevolveScheduler extends MissionOrchestrator {
  constructor(options: DevolveSchedulerOptions) {
    super({
      ...options,
      feedbackTransportFactory: options.feedbackTransportFactory,
    });
  }

  /** Devolve 下主 Agent 直接裁决任务。 */
  decideUnblock(taskId: string): Promise<void> {
    return this.unblockTask(taskId);
  }

  decideReassign(taskId: string): Promise<void> {
    return this.reassignTask(taskId);
  }

  decideCancel(taskId: string): Promise<void> {
    return this.cancelTask(taskId);
  }
}
