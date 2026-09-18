/**
 * GUIDE 增量（用户文档 §6）：追加/修订/新建任务的变更意图反例。
 */
import { describe, expect, it } from "vitest";

import {
  GuidanceChangeIntentController,
  type GuidanceChangeRequest,
} from "../../../packages/core/src/runtime-guidance/guidance-change-intent.js";

const NOW = "2026-09-17T00:00:00.000Z";

function createController(): GuidanceChangeIntentController {
  return new GuidanceChangeIntentController({ nowIso: () => NOW });
}

function changeRequest(
  overrides: Partial<GuidanceChangeRequest> = {},
): GuidanceChangeRequest {
  return {
    guidanceIdentifier: "guide-change-1",
    guidanceRevision: 1,
    changeIntent: "append",
    targetTaskIdentifier: "task-1",
    newTaskIdentifier: null,
    instructionText: "追加一条验收要求",
    requestedTaskSequenceRevision: 1,
    derivedTaskPriorityTier: 1,
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    ...overrides,
  };
}

describe("GUIDE 增量 变更意图契约", () => {
  it("未明确变更类型 → 澄清，不静默替换旧目标且不改 revision", () => {
    const controller = createController();
    const decision = controller.applyChange(
      changeRequest({ changeIntent: null }),
    );
    expect(decision.status).toBe("needs-clarification");
    expect(decision.clarificationQuestion).toBeTruthy();
    expect(decision.newTaskSequenceRevision).toBeNull();
    expect(controller.readTaskRevision("task-1")).toBe(1);
    expect(controller.readHistory("task-1")).toEqual([]);
  }, 30_000);

  it("追加：revision 单调 +1、历史保留、且不使既有证据失效", () => {
    const controller = createController();
    const first = controller.applyChange(changeRequest());
    expect(first.status).toBe("accepted");
    expect(first.newTaskSequenceRevision).toBe(2);
    expect(first.invalidatedArtifactIdentifiers).toEqual([]);
    expect(first.invalidatedAcceptanceEntryIdentifiers).toEqual([]);

    const second = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-2",
        requestedTaskSequenceRevision: 2,
        instructionText: "再追加一条",
      }),
    );
    expect(second.newTaskSequenceRevision).toBe(3);
    expect(second.historyEntryCount).toBe(2);
    expect(controller.readHistory("task-1").map((entry) => entry.changeIntent)).toEqual([
      "append",
      "append",
    ]);
  }, 30_000);

  it("修订未指明受影响证据 → 澄清；指明后仅这些证据失效并保留历史", () => {
    const controller = createController();
    const unclear = controller.applyChange(
      changeRequest({ changeIntent: "revise" }),
    );
    expect(unclear.status).toBe("needs-clarification");
    expect(controller.readTaskRevision("task-1")).toBe(1);

    const revise = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-1b",
        changeIntent: "revise",
        invalidatedArtifactIdentifiers: ["artifact-1"],
        invalidatedAcceptanceEntryIdentifiers: ["entry-2"],
      }),
    );
    expect(revise.status).toBe("accepted");
    expect(revise.newTaskSequenceRevision).toBe(2);
    expect(revise.invalidatedArtifactIdentifiers).toEqual(["artifact-1"]);
    expect(revise.invalidatedAcceptanceEntryIdentifiers).toEqual(["entry-2"]);
    expect(controller.readHistory("task-1")).toHaveLength(1);
  }, 30_000);

  it("旧完成声明在 revision 变化后失效", () => {
    const controller = createController();
    expect(
      controller.isCompletionDeclarationStillValid({
        taskIdentifier: "task-1",
        declaredTaskSequenceRevision: 1,
      }),
    ).toBe(true);
    controller.applyChange(changeRequest());
    expect(
      controller.isCompletionDeclarationStillValid({
        taskIdentifier: "task-1",
        declaredTaskSequenceRevision: 1,
      }),
    ).toBe(false);
    expect(
      controller.isCompletionDeclarationStillValid({
        taskIdentifier: "task-1",
        declaredTaskSequenceRevision: 2,
      }),
    ).toBe(true);
  }, 30_000);

  it("新建任务：用户可层级 0；Agent/工具来源层级 0 被拒；重复标识被拒", () => {
    const controller = createController();
    controller.registerExistingTask("task-existing");
    const userNewTask = controller.applyChange(
      changeRequest({
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: "task-unrelated",
        derivedTaskPriorityTier: 0,
      }),
    );
    expect(userNewTask.status).toBe("accepted");

    const agentNewTask = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-3",
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: "task-agent",
        derivedTaskPriorityTier: 0,
        sourceKind: "file-task-observation",
      }),
    );
    expect(agentNewTask.status).toBe("rejected");
    expect(agentNewTask.reasons.join(" ")).toContain(
      "priority-tier-elevation-rejected",
    );

    const duplicate = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-4",
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: "task-existing",
      }),
    );
    expect(duplicate.status).toBe("rejected");
    expect(duplicate.reasons.join(" ")).toContain("duplicate-task-identifier");
  }, 30_000);

  it("并发变更：观察 revision 落后 → 拒绝且不改状态", () => {
    const controller = createController();
    controller.applyChange(changeRequest());
    const stale = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-5",
        requestedTaskSequenceRevision: 1,
      }),
    );
    expect(stale.status).toBe("rejected");
    expect(stale.reasons.join(" ")).toContain("stale-task-sequence-revision");
    expect(controller.readTaskRevision("task-1")).toBe(2);
  }, 30_000);

  it("重复指导（同标识同 revision）幂等去重，不重复提升 revision", () => {
    const controller = createController();
    const first = controller.applyChange(changeRequest());
    expect(first.isDuplicateDelivery).toBe(false);
    const replay = controller.applyChange(changeRequest());
    expect(replay.isDuplicateDelivery).toBe(true);
    expect(replay.status).toBe("accepted");
    expect(controller.readTaskRevision("task-1")).toBe(2);
    expect(controller.readHistory("task-1")).toHaveLength(1);
  }, 30_000);

  it("撤销旧要求：修订使旧验收条目失效并保留历史指导", () => {
    const controller = createController();
    controller.applyChange(changeRequest());
    const revoke = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-6",
        requestedTaskSequenceRevision: 2,
        changeIntent: "revise",
        instructionText: "撤销旧要求 A",
        invalidatedAcceptanceEntryIdentifiers: ["entry-A"],
      }),
    );
    expect(revoke.status).toBe("accepted");
    const history = controller.readHistory("task-1");
    expect(history).toHaveLength(2);
    expect(history[1]?.invalidatedAcceptanceEntryIdentifiers).toEqual(["entry-A"]);
    expect(history[0]?.instructionText).toBe("追加一条验收要求");
  }, 30_000);
});
describe("GUIDE 增量 边界与持久化", () => {
  it("append/revise 缺少目标任务 → 拒绝", () => {
    const controller = createController();
    const decision = controller.applyChange(
      changeRequest({ targetTaskIdentifier: null }),
    );
    expect(decision.status).toBe("rejected");
    expect(decision.reasons.join(" ")).toContain("missing-target-task");
  }, 30_000);

  it("新建任务缺少标识 / Agent 越权层级 → 拒绝", () => {
    const controller = new GuidanceChangeIntentController({
      nowIso: () => NOW,
      maximumAgentDerivedPriorityTier: 2,
    });
    const missingIdentifier = controller.applyChange(
      changeRequest({
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: null,
      }),
    );
    expect(missingIdentifier.status).toBe("rejected");
    expect(missingIdentifier.reasons.join(" ")).toContain(
      "missing-new-task-identifier",
    );

    const withinLimit = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-7",
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: "task-agent-2",
        derivedTaskPriorityTier: 2,
        sourceKind: "registered-local-tool",
      }),
    );
    expect(withinLimit.status).toBe("accepted");

    const overLimit = controller.applyChange(
      changeRequest({
        guidanceIdentifier: "guide-change-8",
        changeIntent: "new-task",
        targetTaskIdentifier: null,
        newTaskIdentifier: "task-agent-3",
        derivedTaskPriorityTier: 3,
        sourceKind: "registered-local-tool",
      }),
    );
    expect(overLimit.status).toBe("rejected");
  }, 30_000);

  it("快照/恢复往返保留 revision、历史与去重；版本不符时不恢复", () => {
    const controller = createController();
    controller.applyChange(changeRequest());
    const restored = createController();
    restored.hydrate(controller.snapshot());
    expect(restored.readTaskRevision("task-1")).toBe(2);
    expect(restored.readHistory("task-1")).toHaveLength(1);
    const replay = restored.applyChange(changeRequest());
    expect(replay.isDuplicateDelivery).toBe(true);

    const incompatible = createController();
    incompatible.hydrate({
      schemaVersion: 2,
      taskSequenceRevisionByTaskIdentifier: { "task-1": 9 },
      historyByTaskIdentifier: {},
      decisionByDeliveryKey: {},
      knownTaskIdentifiers: [],
    } as unknown as Parameters<typeof incompatible.hydrate>[0]);
    expect(incompatible.readTaskRevision("task-1")).toBe(1);
    expect(incompatible.readHistory("task-1")).toEqual([]);
  }, 30_000);

  it("未知任务历史为空，且 guidanceRevision 参与去重键", () => {
    const controller = createController();
    expect(controller.readHistory("task-unknown")).toEqual([]);
    const first = controller.applyChange(changeRequest());
    expect(first.status).toBe("accepted");
    const differentRevision = controller.applyChange(
      changeRequest({ guidanceRevision: 2 }),
    );
    // 同标识但 revision 不同 → 不视为重复投递（仍按观察 revision 校验）
    expect(differentRevision.isDuplicateDelivery).toBe(false);
  }, 30_000);
});
