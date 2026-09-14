/**
 * GUI 只读视图模型（GUI-01-R-02）。
 *
 * 只消费公共应用服务与公开事件；不复制核心状态机。
 * 输出为脱敏 JSON（无凭据、无内部路径、无 .env）。
 */
import type { AgentMode } from "../../../core/src/core/types.js";

export interface GuiTaskView {
  taskIdentifier: string;
  missionIdentifier: string | null;
  status: string;
  revision: number;
}

export interface GuiSnapshot {
  sessionId: string;
  mode: AgentMode;
  connectionStatus: "connected";
  tasks: GuiTaskView[];
  missions: string[];
}

export interface GuiTaskTrackerView {
  tasksByIdentifier: Map<string, GuiTaskView>;
  missions: Set<string>;
}

export function createGuiTaskTracker(): GuiTaskTrackerView {
  return { tasksByIdentifier: new Map(), missions: new Set() };
}

export function applyGuiEventToTracker(
  tracker: GuiTaskTrackerView,
  event: {
    eventType: string;
    taskIdentifier?: string;
    status?: string;
    missionIdentifier?: string | null;
    revision?: number;
  },
): void {
  if (event.eventType === "task-status" || event.eventType === "task-finished") {
    const taskIdentifier = event.taskIdentifier;
    if (typeof taskIdentifier !== "string") {
      return;
    }
    const previous = tracker.tasksByIdentifier.get(taskIdentifier);
    tracker.tasksByIdentifier.set(taskIdentifier, {
      taskIdentifier,
      missionIdentifier: event.missionIdentifier ?? previous?.missionIdentifier ?? null,
      status: event.status ?? previous?.status ?? "accepted",
      revision: Math.max(previous?.revision ?? 0, event.revision ?? 0),
    });
    const missionIdentifier =
      event.missionIdentifier ?? previous?.missionIdentifier ?? null;
    if (missionIdentifier !== null) {
      tracker.missions.add(missionIdentifier);
    }
  }
}

export function buildGuiSnapshot(input: {
  sessionId: string;
  mode: AgentMode;
  tracker: GuiTaskTrackerView;
}): GuiSnapshot {
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    connectionStatus: "connected",
    tasks: [...input.tracker.tasksByIdentifier.values()].sort((left, right) =>
      left.taskIdentifier.localeCompare(right.taskIdentifier),
    ),
    missions: [...input.tracker.missions].sort(),
  };
}
