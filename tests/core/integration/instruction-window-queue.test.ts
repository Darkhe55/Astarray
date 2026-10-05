/**
 * SMART-01-02 行为反例（指令窗口持久队列：原子准入 / 回执 / 补位）。
 *
 * 卡内要求与验收："持久队列、原子准入/回执/补位、模式及窗口设置；
 * **上限3时第4条排队**；**重复/乱序回执**、**降上限**、**同键异参**、
 * **并发连发**和**重启无重复投递**"。
 *
 * 契约来源：SMART-01-01 冻结的窗口契约（容量默认 3、六态状态机、回执是候选）。
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstructionWindowStore } from "../../../packages/core/src/orchestration/instruction-window-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-window-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

describe("SMART-01-02：准入与排队", () => {
  it("① 上限 3：前 3 条进入窗口，第 4 条必须排队（不得静默丢弃）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    for (let index = 1; index <= 4; index += 1) {
      const result = await store.admitInstruction({
        instructionIdentifier: "ins-" + String(index),
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "指令 " + String(index),
        idempotencyKey: "key-" + String(index),
      });
      expect(result.outcome).toBe(index <= 3 ? "admitted" : "queued");
    }
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(3);
    expect(snapshot.queuedInstructions).toHaveLength(1);
    expect(snapshot.queuedInstructions[0]?.instructionIdentifier).toBe("ins-4");
  });

  it("② 同键异参：必须拒绝，不得覆盖既有指令", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "原始内容",
      idempotencyKey: "shared-key",
    });
    const conflict = await store.admitInstruction({
      instructionIdentifier: "ins-2",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "不同内容",
      idempotencyKey: "shared-key",
    });
    expect(conflict.outcome).toBe("idempotency-conflict");
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(1);
    expect(snapshot.activeInstructions[0]?.instructionIdentifier).toBe("ins-1");
  });

  it("③ 同键同参：幂等复用，不重复占位", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "同一内容",
      idempotencyKey: "same-key",
    });
    const duplicate = await store.admitInstruction({
      instructionIdentifier: "ins-1-dup",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "同一内容",
      idempotencyKey: "same-key",
    });
    expect(duplicate.outcome).toBe("duplicate-idempotent");
    expect((await store.snapshot()).activeInstructions).toHaveLength(1);
  });

  it("④ 并发连发：原子准入不得超容（容量 3 时并发 10 条只能进 3 条）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        store.admitInstruction({
          instructionIdentifier: "burst-" + String(index),
          instructionRevision: 1,
          sourceKind: "user",
          instructionText: "并发 " + String(index),
          idempotencyKey: "burst-key-" + String(index),
        }),
      ),
    );
    const admittedCount = results.filter((result) => result.outcome === "admitted").length;
    const queuedCount = results.filter((result) => result.outcome === "queued").length;
    expect(admittedCount).toBe(3);
    expect(queuedCount).toBe(7);
    expect((await store.snapshot()).activeInstructions).toHaveLength(3);
  });

  it("⑤ 重启：新实例读同一目录，不得重复投递已在窗口或已终态的指令", async () => {
    const firstStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await firstStore.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "重启前",
      idempotencyKey: "restart-key",
    });

    const secondStore = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    const resubmitted = await secondStore.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "重启前",
      idempotencyKey: "restart-key",
    });
    expect(resubmitted.outcome).toBe("duplicate-idempotent");
    expect((await secondStore.snapshot()).activeInstructions).toHaveLength(1);
  });
});

describe("SMART-01-02：回执校验与补位", () => {
  it("⑥ 回执是候选：revision 不匹配必须拒绝，不得释放槽位", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 1 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 2,
      sourceKind: "user",
      instructionText: "内容",
      idempotencyKey: "key-1",
    });
    const rejected = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(rejected.outcome).toBe("stale-revision-rejected");
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(1);
  });

  it("⑦ 缺少任务关联的回执不得释放槽位（回执只是候选）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 1 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "内容",
      idempotencyKey: "key-1",
    });
    const missingLink = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: [],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(missingLink.outcome).toBe("missing-task-link-rejected");
    expect((await store.snapshot()).activeInstructions).toHaveLength(1);
  });

  it("⑧ 终态后补位：1 条完成即从队列补入 1 条", async () => {
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
    expect((await store.snapshot()).activeInstructions).toHaveLength(2);
    expect((await store.snapshot()).queuedInstructions).toHaveLength(1);

    const completion = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(completion.outcome).toBe("released-with-backfill");
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions.map((item) => item.instructionIdentifier).sort()).toEqual([
      "ins-2",
      "ins-3",
    ]);
    expect(snapshot.queuedInstructions).toHaveLength(0);
  });

  it("⑨ 重复/乱序回执：同一指令第二次回执必须幂等忽略，不得再补位", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 1 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "内容",
      idempotencyKey: "key-1",
    });
    const first = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(first.outcome).toBe("released-no-backfill");

    const duplicate = await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: [],
    });
    expect(duplicate.outcome).toBe("duplicate-receipt-ignored");
  });

  it("⑩ 降低上限：窗口内超出新上限的指令回到队列，且不丢失", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    for (let index = 1; index <= 3; index += 1) {
      await store.admitInstruction({
        instructionIdentifier: "ins-" + String(index),
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: "内容 " + String(index),
        idempotencyKey: "key-" + String(index),
      });
    }
    await store.setWindowCapacity(1);
    const snapshot = await store.snapshot();
    expect(snapshot.activeInstructions).toHaveLength(1);
    expect(snapshot.queuedInstructions).toHaveLength(2);
    // 不丢失：总数守恒
    expect(snapshot.activeInstructions.length + snapshot.queuedInstructions.length).toBe(3);
  });
});
