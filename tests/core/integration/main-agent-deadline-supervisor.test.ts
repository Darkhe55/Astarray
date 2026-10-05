/**
 * SMART-01-04 行为反例（期限监督 / 有界补位 / 状态不冒充成果）。
 *
 * 卡内验收："模拟慢模型/长下级任务仍能接收新指令；180 秒内派发或如实超时/待澄清；
 * 关闭回收，UI 状态不冒充成果完成"。
 *
 * 本文件在实现之前必须失败。
 */
import { describe, expect, it } from "vitest";

import {
  MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
  buildBackfillPlan,
  evaluateInstructionDeadline,
} from "../../../packages/core/src/orchestration/main-agent-deadline-supervisor.js";

describe("SMART-01-04：三分钟期限监督", () => {
  it("① 期限内已完成派发：如实报告 timely", () => {
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-1",
      acceptedAtIso: "2026-10-02T00:00:00.000Z",
      nowIso: "2026-10-02T00:01:00.000Z",
    });
    expect(evaluation.kind).toBe("dispatched-within-deadline");
    expect(evaluation.isTruthfulTimeout).toBe(false);
    expect(evaluation.deadlineMilliseconds).toBe(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS);
  });

  it("② 超期未派发：必须如实报超时，不得伪报已派发", () => {
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-1",
      acceptedAtIso: "2026-10-02T00:00:00.000Z",
      nowIso: "2026-10-02T00:05:00.000Z",
      dispatchedAtIso: null,
    });
    expect(evaluation.kind).toBe("overdue-not-dispatched");
    expect(evaluation.isTruthfulTimeout).toBe(true);
    expect(evaluation.remainingMilliseconds).toBe(0);
    expect(evaluation.detail).toContain("如实");
  });

  it("③ 等待澄清：即使超期也不得伪报已派发，且保持「等待」而非「完成」", () => {
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-1",
      acceptedAtIso: "2026-10-02T00:00:00.000Z",
      nowIso: "2026-10-02T00:05:00.000Z",
      isAwaitingClarification: true,
    });
    expect(evaluation.kind).toBe("awaiting-clarification");
    expect(evaluation.isTruthfulTimeout).toBe(false);
    expect(evaluation.detail).toContain("等待");
    expect(evaluation.isWorkCompleted).toBe(false);
  });

  it("④ 慢模型/长下级任务：不得因在途而拒绝接收新指令", () => {
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-1",
      acceptedAtIso: "2026-10-02T00:00:00.000Z",
      nowIso: "2026-10-02T00:00:30.000Z",
      hasLongRunningSubordinateTask: true,
    });
    expect(evaluation.canAcceptNewInstruction).toBe(true);
  });

  it("⑤ 权限等待/休息/显式停止：不得用补位绕过原门禁", () => {
    for (const flag of [
      { isAwaitingPermissionDecision: true },
      { isResting: true },
      { isExplicitUserStop: true },
    ]) {
      const evaluation = evaluateInstructionDeadline({
        instructionIdentifier: "ins-1",
        acceptedAtIso: "2026-10-02T00:00:00.000Z",
        nowIso: "2026-10-02T00:01:00.000Z",
        ...flag,
      });
      expect(evaluation.canAcceptNewInstruction).toBe(false);
      expect(evaluation.isGatedByExistingGate).toBe(true);
    }
  });

  it("⑥ 期限常量必须是 180000 毫秒（三分钟）", () => {
    expect(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS).toBe(180_000);
  });
});

describe("SMART-01-04：有界补位（不灌队列、不重复、不伪造）", () => {
  it("⑦ 只补可用槽位数量的指令，不一次灌入整个队列", () => {
    const plan = buildBackfillPlan({
      availableSlotCount: 2,
      queuedInstructions: [
        { instructionIdentifier: "q-1", sourceKind: "user", isAlreadyInFlight: false },
        { instructionIdentifier: "q-2", sourceKind: "user", isAlreadyInFlight: false },
        { instructionIdentifier: "q-3", sourceKind: "user", isAlreadyInFlight: false },
        { instructionIdentifier: "q-4", sourceKind: "user", isAlreadyInFlight: false },
      ],
      isContinuationAllowed: true,
    });
    expect(plan.selected.map((item) => item.instructionIdentifier)).toEqual(["q-1", "q-2"]);
    expect(plan.deferredCount).toBe(2);
  });

  it("⑧ 已在途指令不得重复投递", () => {
    const plan = buildBackfillPlan({
      availableSlotCount: 3,
      queuedInstructions: [
        { instructionIdentifier: "q-1", sourceKind: "user", isAlreadyInFlight: true },
        { instructionIdentifier: "q-2", sourceKind: "agent", isAlreadyInFlight: false },
      ],
      isContinuationAllowed: true,
    });
    expect(plan.selected.map((item) => item.instructionIdentifier)).toEqual(["q-2"]);
    expect(plan.skippedAlreadyInFlight).toBe(1);
  });

  it("⑨ 未获允许继续（门禁/休息/停止/预算耗尽）时不得补位", () => {
    const plan = buildBackfillPlan({
      availableSlotCount: 3,
      queuedInstructions: [
        { instructionIdentifier: "q-1", sourceKind: "user", isAlreadyInFlight: false },
      ],
      isContinuationAllowed: false,
    });
    expect(plan.selected).toHaveLength(0);
    expect(plan.detail).toContain("未获允许");
  });

  it("⑩ 每次补位必须记录原始来源与自动投递原因，且标注不伪造新用户消息", () => {
    const plan = buildBackfillPlan({
      availableSlotCount: 1,
      queuedInstructions: [
        { instructionIdentifier: "q-1", sourceKind: "agent", isAlreadyInFlight: false },
      ],
      isContinuationAllowed: true,
      backfillReason: "指令完成后释放槽位",
    });
    expect(plan.selected).toHaveLength(1);
    const item = plan.selected[0];
    expect(item?.sourceKind).toBe("agent");
    expect(item?.backfillReason).toBe("指令完成后释放槽位");
    expect(item?.isSyntheticUserMessage).toBe(false);
  });
});
