/**
 * SMART-01-04 缺口补做：慢模型 / 长下级任务 / 重起并发下的"持续接收"反例。
 *
 * 卡内验收："模拟慢模型/长下级任务仍能接收新指令；180 秒内派发或如实超时/待澄清；
 * 关闭回收，UI 状态不冒充成果完成"。
 *
 * 本节验证**持续接收**在真实异步（含人为延迟与并发重起）下不被阻断。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstructionWindowStore,
} from "../../../packages/core/src/orchestration/instruction-window-store.js";
import {
  MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS,
  buildBackfillPlan,
  evaluateInstructionDeadline,
} from "../../../packages/core/src/orchestration/main-agent-deadline-supervisor.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart04-slow-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("SMART-01-04 补做：慢模型与长下级任务下仍能接收新指令", () => {
  it("① 模拟慢模型：首条在途期间后续指令仍被受理（不阻塞接收）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });

    // 第 1 条：模拟"慢模型"在途
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "慢任务",
      idempotencyKey: "key-1",
    });
    const slowTaskPromise = (async () => {
      await delay(120);
      return store.submitReceipt({
        instructionIdentifier: "ins-1",
        instructionRevision: 1,
        receiptOutcome: "completed",
        taskIdentifiers: ["T-001"],
        evidenceReferences: ["receipt-1"],
        unresolvedQuestions: [],
      });
    })();

    // 在途期间继续下发
    const admittedDuringFlight = await store.admitInstruction({
      instructionIdentifier: "ins-2",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "第二条",
      idempotencyKey: "key-2",
    });
    expect(admittedDuringFlight.outcome).toBe("admitted");

    const third = await store.admitInstruction({
      instructionIdentifier: "ins-3",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "第三条",
      idempotencyKey: "key-3",
    });
    expect(third.outcome).toBe("admitted");

    // 第 4 条：窗口已满 → 排队（仍不丢弃）
    const fourth = await store.admitInstruction({
      instructionIdentifier: "ins-4",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "第四条",
      idempotencyKey: "key-4",
    });
    expect(fourth.outcome).toBe("queued");

    await slowTaskPromise;
    const snapshot = await store.snapshot();
    expect(snapshot.terminalInstructions.map((item) => item.instructionIdentifier)).toContain("ins-1");
  });

  it("② 长下级任务在途：接收不被阻断，且期限监督如实报告在途与剩余量", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    await store.admitInstruction({
      instructionIdentifier: "ins-long",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "长下级任务",
      idempotencyKey: "key-long",
    });

    const deadlineEvaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-long",
      acceptedAtIso: new Date(Date.now() - 30_000).toISOString(),
      nowIso: new Date().toISOString(),
      hasLongRunningSubordinateTask: true,
    });
    // 长下级任务在途不得阻断接收
    expect(deadlineEvaluation.canAcceptNewInstruction).toBe(true);
    expect(deadlineEvaluation.deadlineMilliseconds).toBe(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS);
    expect(deadlineEvaluation.isTruthfulTimeout).toBe(false);

    const second = await store.admitInstruction({
      instructionIdentifier: "ins-second",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "长任务在途时下发",
      idempotencyKey: "key-second",
    });
    expect(second.outcome).toBe("admitted");
  });

  it("③ 超期仍在途：如实报超时（不伪报已派发），且 UI 不冒充成果完成", () => {
    const evaluation = evaluateInstructionDeadline({
      instructionIdentifier: "ins-overdue",
      acceptedAtIso: new Date(Date.now() - 200_000).toISOString(),
      nowIso: new Date().toISOString(),
      hasLongRunningSubordinateTask: true,
    });
    expect(evaluation.kind).toBe("overdue-not-dispatched");
    expect(evaluation.isTruthfulTimeout).toBe(true);
    // 超时 ≠ 成果完成
    expect(evaluation.isWorkCompleted).toBe(false);
  });

  it("④ 关闭回收：终态释放槽位后有界补位，且不重复投递在途指令", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 2 });
    for (let index = 1; index <= 3; index += 1) {
      await store.admitInstruction({
        instructionIdentifier: "ins-" + String(index),
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "内容 " + String(index),
        idempotencyKey: "key-" + String(index),
      });
    }
    // 关闭 ins-1 → 释放槽位并补位 ins-3
    const closure = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(closure.outcome).toBe("released-with-backfill");

    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions.map((item) => item.instructionIdentifier).sort()).toEqual([
      "ins-2",
      "ins-3",
    ]);
    expect(snapshot.queuedInstructions).toHaveLength(0);

    // 有界补位计划：ins-2 仍在途 → 跳过，不重复投递
    const plan = buildBackfillPlan({
      availableSlotCount: 1,
      queuedInstructions: [
        { instructionIdentifier: "ins-2", sourceKind: "user", isAlreadyInFlight: true },
        { instructionIdentifier: "ins-9", sourceKind: "user", isAlreadyInFlight: false },
      ],
      isContinuationAllowed: true,
    });
    expect(plan.selected.map((item) => item.instructionIdentifier)).toEqual(["ins-9"]);
    expect(plan.skippedAlreadyInFlight).toBe(1);
  });

  it("⑤ 同一实例并发接收：并发受理不得丢指令、不得重复占位", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    const results = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        store.admitInstruction({
          instructionIdentifier: "ins-c" + String(index),
          instructionRevision: 1,
          sourceKind: "user",
          instructionText: "并发 " + String(index),
          idempotencyKey: "key-c" + String(index),
        }),
      ),
    );
    expect(results.every((result) => result.outcome === "admitted")).toBe(true);

    const observerStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    const snapshot = await observerStore.snapshot();
    const identifiers = snapshot.activeInstructions.map((item) => item.instructionIdentifier);
    expect(identifiers.sort()).toEqual(["ins-c0", "ins-c1", "ins-c2", "ins-c3"]);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it("⑥ 多实例并存于同一状态目录：必须**响亮失败**，不得静默覆盖丢指令", async () => {
    // 建立既有窗口内容（模拟"前一次会话遗留"）
    const seedStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    await seedStore.admitInstruction({
      instructionIdentifier: "ins-seed",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "既有",
      idempotencyKey: "key-seed",
    });

    // 两个实例都先接管既有状态（各自持有内存快照）
    const firstStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    const secondStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    await firstStore.snapshot();
    await secondStore.snapshot();

    // 实例一先提交 → 实例二随后提交时，磁盘已非其"已知状态" → 必须响亮失败
    const firstResult = await firstStore.admitInstruction({
      instructionIdentifier: "ins-r1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "实例一受理",
      idempotencyKey: "key-r1",
    });
    expect(firstResult.outcome).toBe("admitted");

    await expect(
      secondStore.admitInstruction({
        instructionIdentifier: "ins-r2",
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "实例二受理",
        idempotencyKey: "key-r2",
      }),
    ).rejects.toThrow(/并发冲突/);

    // 落盘状态自洽：既有内容不丢、无重复项，且不含被拒绝的 ins-r2
    const observerStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 5 });
    const snapshot = await observerStore.snapshot();
    const identifiers = [
      ...snapshot.activeInstructions,
      ...snapshot.queuedInstructions,
      ...snapshot.terminalInstructions,
    ].map((item) => item.instructionIdentifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers).toContain("ins-seed");
    expect(identifiers).toContain("ins-r1");
    expect(identifiers).not.toContain("ins-r2");
  });
});
