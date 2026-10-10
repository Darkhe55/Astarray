/**
 * SMART-01-04 反例（2026-10-10）：**指令窗口与三分钟期限必须能从 SDK 入口真实驱动**。
 *
 * 卡内 §6/§7-SMART-01-04 要求：主 Agent 单条用户指令须在 **180 秒**内处理并派发、
 * 不阻塞持续交流；**期限自本地接收起计时，包含智能队列等待**（不能"取出队列时重新计时"掩盖积压）；
 * 超期须**如实报超时**、等待澄清**不得冒充完成**；慢模型/长下级任务**不得阻塞接收新指令**。
 *
 * 现状缺口（本文件在实现前必须失败）：`InstructionWindowStore` 与
 * `evaluateInstructionDeadline` / `buildBackfillPlan` 只是**被 re-export 的独立组件**，
 * `AstarrayApplicationFacade` 上**没有任何**真实消费它们的入口——
 * 因此"第 4 条排队""超期如实报超时""等待澄清不冒充完成"都不能从产品入口取得。
 *
 * 本文件只钉住"窗口 + 期限判定"这一条最窄的闭环；不主张四入口（SDK/CLI/TUI/GUI）与包级验收完成。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS } from "../../../packages/core/src/orchestration/main-agent-deadline-supervisor.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart01-04-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createApplication(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 2,
    failureThreshold: 3,
  });
}

describe("SMART-01-04：指令窗口与三分钟期限经 SDK 入口真实驱动", () => {
  it("① 上限 3：第 4 条必须排队（不丢弃），且快照能区分窗口内与排队", async () => {
    const application = await createApplication();
    try {
      application.createSession({ sessionId: "s1", mode: "assist" });
      const outcomes: string[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const result = await application.acceptUserInstruction({
          sessionId: "s1",
          instructionText: "指令 " + String(index),
          idempotencyKey: "k-" + String(index),
        });
        outcomes.push(result.admissionOutcome);
      }
      expect(outcomes).toEqual(["admitted", "admitted", "admitted", "queued"]);

      const snapshot = await application.queryInstructionWindow({ sessionId: "s1" });
      expect(snapshot.windowCapacity).toBe(3);
      expect(snapshot.activeInstructions).toHaveLength(3);
      expect(snapshot.queuedInstructions.map((record) => record.instructionText)).toEqual([
        "指令 4",
      ]);
    } finally {
      await application.shutdown();
    }
  });

  it("② 期限自**接收**起计，队列等待不得被重新计时掩盖", async () => {
    const application = await createApplication();
    try {
      application.createSession({ sessionId: "s1", mode: "assist" });
      const acceptedAtIso = "2026-10-10T00:00:00.000Z";
      await application.acceptUserInstruction({
        sessionId: "s1",
        instructionText: "排队中的第 4 条",
        idempotencyKey: "k-queued",
        nowIso: acceptedAtIso,
      });
      // 占满窗口（3 条），使上面那条进入排队。
      for (let index = 1; index <= 3; index += 1) {
        await application.acceptUserInstruction({
          sessionId: "s1",
          instructionText: "占位 " + String(index),
          idempotencyKey: "k-fill-" + String(index),
          nowIso: acceptedAtIso,
        });
      }

      // 刚好在期限内（179 秒）→ 不得报超时。
      const withinDeadline = await application.evaluateInstructionHandlingDeadline({
        sessionId: "s1",
        idempotencyKey: "k-queued",
        nowIso: "2026-10-10T00:02:59.000Z",
      });
      expect(withinDeadline.kind).not.toBe("overdue-not-dispatched");
      expect(withinDeadline.isTruthfulTimeout).toBe(false);
      expect(withinDeadline.deadlineMilliseconds).toBe(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS);

      // 超过三分钟（181 秒）→ 必须**如实**报超时，且不得伪报已派发/已完成。
      const overdue = await application.evaluateInstructionHandlingDeadline({
        sessionId: "s1",
        idempotencyKey: "k-queued",
        nowIso: "2026-10-10T00:03:01.000Z",
      });
      expect(overdue.kind).toBe("overdue-not-dispatched");
      expect(overdue.isTruthfulTimeout).toBe(true);
      expect(overdue.isWorkCompleted).toBe(false);
    } finally {
      await application.shutdown();
    }
  });

  it("③ 慢模型/长下级任务不得阻塞接收：仍能接收新指令且如实标注在途", async () => {
    const application = await createApplication();
    try {
      application.createSession({ sessionId: "s1", mode: "assist" });
      await application.acceptUserInstruction({
        sessionId: "s1",
        instructionText: "长任务指令",
        idempotencyKey: "k-long",
        nowIso: "2026-10-10T00:00:00.000Z",
      });
      const evaluation = await application.evaluateInstructionHandlingDeadline({
        sessionId: "s1",
        idempotencyKey: "k-long",
        nowIso: "2026-10-10T00:00:30.000Z",
        hasLongRunningSubordinateTask: true,
      });
      expect(evaluation.canAcceptNewInstruction).toBe(true);
      expect(evaluation.kind).toBe("dispatched-within-deadline");

      // 长下级任务在途时，仍然可以继续接收新指令（不阻塞持续交流）。
      const second = await application.acceptUserInstruction({
        sessionId: "s1",
        instructionText: "后续指令",
        idempotencyKey: "k-second",
      });
      expect(second.admissionOutcome).toBe("admitted");
    } finally {
      await application.shutdown();
    }
  });

  it("④ 等待澄清 =「等待」而非「完成」；权限等待不得被补位绕过（并给出有界补位计划）", async () => {
    const application = await createApplication();
    try {
      application.createSession({ sessionId: "s1", mode: "assist" });
      await application.acceptUserInstruction({
        sessionId: "s1",
        instructionText: "需要澄清的指令",
        idempotencyKey: "k-clarify",
      });
      const awaiting = await application.evaluateInstructionHandlingDeadline({
        sessionId: "s1",
        idempotencyKey: "k-clarify",
        isAwaitingClarification: true,
      });
      expect(awaiting.kind).toBe("awaiting-clarification");
      expect(awaiting.isWorkCompleted).toBe(false);
      expect(awaiting.canAcceptNewInstruction).toBe(false);

      // 权限等待：不得用补位绕过原门禁。
      const gated = await application.evaluateInstructionHandlingDeadline({
        sessionId: "s1",
        idempotencyKey: "k-clarify",
        isAwaitingPermissionDecision: true,
      });
      expect(gated.isGatedByExistingGate).toBe(true);
      expect(gated.canAcceptNewInstruction).toBe(false);
      expect(gated.isWorkCompleted).toBe(false);
    } finally {
      await application.shutdown();
    }
  });

  it("⑤ 未知键必须响亮拒绝，不得伪造一条指令", async () => {
    const application = await createApplication();
    try {
      application.createSession({ sessionId: "s1", mode: "assist" });
      await expect(
        application.evaluateInstructionHandlingDeadline({
          sessionId: "s1",
          idempotencyKey: "k-unknown",
        }),
      ).rejects.toThrow(/未知指令/);
    } finally {
      await application.shutdown();
    }
  });
});
