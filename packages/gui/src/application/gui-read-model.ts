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
  /**
   * SMART-01-04：指令窗口的只读视图（容量 / 计数 / 逐条标签）。
   *
   * `isWorkCompleted` 只对 `completed` 为真：卡内硬要求"UI 状态不冒充成果完成"，
   * 因此 `dispatched`（已派发）、`awaiting-clarification`（等待澄清）与排队一律为 false。
   * **始终存在**（未提供窗口时为空窗口），保证快照形状唯一、不伪造指令。
   */
  instructions: GuiInstructionWindowView;
}

export interface GuiInstructionView {
  instructionIdentifier: string;
  instructionText: string;
  state: string;
  admittedAtIso: string;
  /** 可渲染状态标签。 */
  stateLabel: string;
  /** 是否处于排队区（与窗口内可分辨）。 */
  isQueued: boolean;
  /** 是否可视为"工作成果完成"（只有 `completed` 为 true）。 */
  isWorkCompleted: boolean;
}

export interface GuiInstructionWindowView {
  capacity: number;
  activeCount: number;
  queuedCount: number;
  rows: GuiInstructionView[];
}

/** 指令状态 → 展示标签（与 TUI 同一口径；`dispatched` 只表示"已派发"）。 */
function guiInstructionStateLabel(state: string): string {
  switch (state) {
    case "dispatched":
      return "已派发";
    case "accepted":
      return "排队";
    case "awaiting-clarification":
      return "等待澄清";
    case "partially-completed":
      return "部分完成";
    case "completed":
      return "成果完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    case "rejected":
      return "拒绝";
    default:
      return state;
  }
}

/** 把指令窗口快照映射为 GUI 只读视图（纯函数；不做任何 I/O）。 */
export function buildGuiInstructionWindowView(input: {
  windowCapacity: number;
  activeInstructions: Array<{
    instructionIdentifier: string;
    instructionText: string;
    state: string;
    admittedAtIso: string;
  }>;
  queuedInstructions: Array<{
    instructionIdentifier: string;
    instructionText: string;
    state: string;
    admittedAtIso: string;
  }>;
}): GuiInstructionWindowView {
  const rows: GuiInstructionView[] = [
    ...input.activeInstructions.map((record) => ({
      ...record,
      stateLabel: guiInstructionStateLabel(record.state),
      isQueued: false,
      isWorkCompleted: record.state === "completed",
    })),
    ...input.queuedInstructions.map((record) => ({
      ...record,
      // 排队区一律显示"排队"，不沿用可能过期的内部状态。
      stateLabel: "排队",
      isQueued: true,
      isWorkCompleted: false,
    })),
  ];
  return {
    capacity: input.windowCapacity,
    activeCount: input.activeInstructions.length,
    queuedCount: input.queuedInstructions.length,
    rows,
  };
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
  /** SMART-01-04：指令窗口快照（缺省为空窗口；不伪造指令）。 */
  instructionWindow?: {
    windowCapacity: number;
    activeInstructions: Parameters<typeof buildGuiInstructionWindowView>[0]["activeInstructions"];
    queuedInstructions: Parameters<typeof buildGuiInstructionWindowView>[0]["queuedInstructions"];
  };
}): GuiSnapshot {
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    connectionStatus: "connected",
    tasks: [...input.tracker.tasksByIdentifier.values()].sort((left, right) =>
      left.taskIdentifier.localeCompare(right.taskIdentifier),
    ),
    missions: [...input.tracker.missions].sort(),
    instructions:
      input.instructionWindow === undefined
        ? { capacity: 0, activeCount: 0, queuedCount: 0, rows: [] }
        : buildGuiInstructionWindowView(input.instructionWindow),
  };
}
