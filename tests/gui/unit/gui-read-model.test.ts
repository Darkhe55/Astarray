/**
 * GUI-01-R-02 单元测试：只读视图模型（事件 -> 任务跟踪 -> 快照）。
 */
import { describe, expect, it } from "vitest";

import {
  applyGuiEventToTracker,
  buildGuiSnapshot,
  createGuiTaskTracker,
} from "../../../packages/gui/src/application/gui-read-model.js";

describe("gui-read-model", () => {
  it("按 taskIdentifier 归并任务并保留最大 revision", () => {
    const tracker = createGuiTaskTracker();
    applyGuiEventToTracker(tracker, {
      eventType: "task-status",
      taskIdentifier: "task-1",
      missionIdentifier: "mission-1",
      status: "accepted",
      revision: 3,
    });
    applyGuiEventToTracker(tracker, {
      eventType: "task-finished",
      taskIdentifier: "task-1",
      status: "completed",
      revision: 9,
    });
    applyGuiEventToTracker(tracker, {
      eventType: "task-status",
      taskIdentifier: "task-1",
      status: "accepted",
      revision: 5,
    });
    const task = tracker.tasksByIdentifier.get("task-1");
    expect(task).toEqual({
      taskIdentifier: "task-1",
      missionIdentifier: "mission-1",
      status: "accepted",
      revision: 9,
    });
    expect([...tracker.missions]).toEqual(["mission-1"]);
  });

  it("忽略未知事件类型与缺少 taskIdentifier 的事件", () => {
    const tracker = createGuiTaskTracker();
    applyGuiEventToTracker(tracker, { eventType: "session-closed" });
    applyGuiEventToTracker(tracker, {
      eventType: "task-status",
      status: "accepted",
      revision: 1,
    });
    expect(tracker.tasksByIdentifier.size).toBe(0);
  });

  it("快照按 taskIdentifier / mission 排序且不含内部字段", () => {
    const tracker = createGuiTaskTracker();
    applyGuiEventToTracker(tracker, {
      eventType: "task-status",
      taskIdentifier: "task-b",
      missionIdentifier: "mission-z",
      status: "accepted",
      revision: 1,
    });
    applyGuiEventToTracker(tracker, {
      eventType: "task-status",
      taskIdentifier: "task-a",
      missionIdentifier: null,
      status: "accepted",
      revision: 1,
    });
    const snapshot = buildGuiSnapshot({
      sessionId: "session-gui-1",
      mode: "assist",
      tracker,
    });
    expect(snapshot).toEqual({
      sessionId: "session-gui-1",
      mode: "assist",
      connectionStatus: "connected",
      tasks: [
        {
          taskIdentifier: "task-a",
          missionIdentifier: null,
          status: "accepted",
          revision: 1,
        },
        {
          taskIdentifier: "task-b",
          missionIdentifier: "mission-z",
          status: "accepted",
          revision: 1,
        },
      ],
      missions: ["mission-z"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("stateDirectory");
  });
});
