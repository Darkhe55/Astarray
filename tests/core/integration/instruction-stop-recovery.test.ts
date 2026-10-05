/**
 * SMART-01-03 行为反例（早停分类 / 漏回执兜底 / 澄清参考）。
 *
 * 卡内验收："早停不注入新工作；无答案保持等待；仅抽取答案；混合信封保留剩余任务；
 * 停止/休息/授权不被绕过"。
 *
 * 本文件在实现之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstructionWindowStore,
} from "../../../packages/core/src/orchestration/instruction-window-store.js";
import {
  classifyModelStop,
  extractClarificationAnswer,
  resolveMissingReceipt,
} from "../../../packages/core/src/orchestration/instruction-stop-recovery.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart03-"));
});

afterEach(async () => {
  try {
    await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

describe("SMART-01-03：模型停止分类", () => {
  it("① 早停：必须分类为 early-stop 且不得注入新指令", () => {
    const classification = classifyModelStop({
      stopReason: "stop",
      hasValidClosingReceipt: false,
      hasIndependentAuthoritativeEvidence: false,
      isWaitingForUserDetails: false,
      producedTextDeltaCount: 2,
      isExplicitUserStop: false,
      isResting: false,
    });
    expect(classification.kind).toBe("early-stop");
    expect(classification.shouldInjectNewInstruction).toBe(false);
    expect(classification.followUpAction).toBe("bounded-follow-up-current-instruction");
  });

  it("② 正常结束且有有效回执：释放槽位并可提交后续指导", () => {
    const classification = classifyModelStop({
      stopReason: "success",
      hasValidClosingReceipt: true,
      hasIndependentAuthoritativeEvidence: false,
      isWaitingForUserDetails: false,
      producedTextDeltaCount: 10,
      isExplicitUserStop: false,
      isResting: false,
    });
    expect(classification.kind).toBe("closed-with-receipt");
    expect(classification.shouldInjectNewInstruction).toBe(true);
  });

  it("③ 漏回执但有独立权威证据：本地补记闭合依据并补位（不得靠 stop 原因推断）", () => {
    const withEvidence = classifyModelStop({
      stopReason: "stop",
      hasValidClosingReceipt: false,
      hasIndependentAuthoritativeEvidence: true,
      isWaitingForUserDetails: false,
      producedTextDeltaCount: 5,
      isExplicitUserStop: false,
      isResting: false,
    });
    expect(withEvidence.kind).toBe("closed-by-local-evidence");
    expect(withEvidence.shouldInjectNewInstruction).toBe(true);
    expect(withEvidence.detail).toContain("独立权威证据");
  });

  it("④ 明确等待用户细节：保持等待，不机械续跑", () => {
    const classification = classifyModelStop({
      stopReason: "ambiguous",
      hasValidClosingReceipt: false,
      hasIndependentAuthoritativeEvidence: false,
      isWaitingForUserDetails: true,
      producedTextDeltaCount: 3,
      isExplicitUserStop: false,
      isResting: false,
    });
    expect(classification.kind).toBe("awaiting-user-details");
    expect(classification.shouldInjectNewInstruction).toBe(false);
    expect(classification.followUpAction).toBe("await-user-clarification");
  });

  it("⑤ 停止/休息/授权不被绕过：显式停止或休息时一律不注入新指令", () => {
    for (const flags of [
      { isExplicitUserStop: true, isResting: false },
      { isExplicitUserStop: false, isResting: true },
    ]) {
      const classification = classifyModelStop({
        stopReason: "success",
        hasValidClosingReceipt: true,
        hasIndependentAuthoritativeEvidence: true,
        isWaitingForUserDetails: false,
        producedTextDeltaCount: 9,
        ...flags,
      });
      expect(classification.shouldInjectNewInstruction).toBe(false);
      expect(classification.isOverrideBlocked).toBe(true);
    }
  });
});

describe("SMART-01-03：澄清参考与混合信封", () => {
  it("⑥ 纯答案：只抽取答案，不产生剩余任务", () => {
    const extraction = extractClarificationAnswer({
      pendingQuestion: "请确认目标目录",
      replyText: ".tmp/live/",
    });
    expect(extraction.answerText).toBe(".tmp/live/");
    expect(extraction.isAnswered).toBe(true);
    expect(extraction.remainingInstructions).toHaveLength(0);
  });

  it("⑦ 无答案：保持等待，不推进", () => {
    const extraction = extractClarificationAnswer({
      pendingQuestion: "请确认目标目录",
      replyText: "",
    });
    expect(extraction.isAnswered).toBe(false);
    expect(extraction.answerText).toBeNull();
    expect(extraction.shouldKeepWaiting).toBe(true);
  });

  it("⑧ 混合信封：抽取答案，且**保留剩余任务**（不得丢弃）", () => {
    const extraction = extractClarificationAnswer({
      pendingQuestion: "请确认目标目录",
      replyText: [
        "答案: .tmp/target/",
        "---",
        "- 生成 README 摘要",
        "- 检查依赖许可证",
      ].join("\n"),
    });
    expect(extraction.isAnswered).toBe(true);
    expect(extraction.answerText).toContain(".tmp/target/");
    expect(extraction.remainingInstructions).toHaveLength(2);
    expect(extraction.remainingInstructions[0]).toContain("生成 README 摘要");
    expect(extraction.remainingInstructions[1]).toContain("检查依赖许可证");
  });

  it("⑨ 混合信封的剩余任务必须能真正进入窗口（与准入/排队联动）", async () => {
    const store = new InstructionWindowStore({ baseDirectory, windowCapacity: 3 });
    await store.admitInstruction({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      sourceKind: "user",
      instructionText: "先确认目录",
      idempotencyKey: "key-1",
    });
    // 置为等待澄清（占槽位）
    await store.submitReceipt({
      instructionIdentifier: "ins-1",
      instructionRevision: 1,
      receiptOutcome: "partially-completed",
      taskIdentifiers: ["T-001"],
      evidenceReferences: ["receipt-1"],
      unresolvedQuestions: ["请确认目标目录"],
    });

    const extraction = extractClarificationAnswer({
      pendingQuestion: "请确认目标目录",
      replyText: "答案: .tmp/target/\n---\n生成 README 摘要",
    });
    expect(extraction.isAnswered).toBe(true);
    expect(extraction.remainingInstructions).toHaveLength(1);

    for (const [index, remaining] of extraction.remainingInstructions.entries()) {
      const admitted = await store.admitInstruction({
        instructionIdentifier: "ins-1-remaining-" + String(index),
        instructionRevision: 1,
        sourceKind: "user",
        instructionText: remaining,
        idempotencyKey: "key-1-remaining-" + String(index),
      });
      expect(["admitted", "queued"]).toContain(admitted.outcome);
    }
    const snapshot = await store.snapshot();
    // 等待澄清的指令仍占槽位；剩余任务进入窗口（总数守恒、未丢弃）
    expect(snapshot.activeInstructions.some((item) => item.state === "awaiting-clarification")).toBe(
      true,
    );
    expect(snapshot.activeInstructions.length + snapshot.queuedInstructions.length).toBe(2);
  });
});

describe("SMART-01-03：漏回执兜底与窗口联动", () => {
  it("⑩ 漏回执且无法确定：保持窗口并优先有界追问当前指令状态", () => {
    const resolution = resolveMissingReceipt({
      classification: classifyModelStop({
        stopReason: "stop",
        hasValidClosingReceipt: false,
        hasIndependentAuthoritativeEvidence: false,
        isWaitingForUserDetails: false,
        producedTextDeltaCount: 1,
        isExplicitUserStop: false,
        isResting: false,
      }),
      remainingFollowUpAttempts: 2,
    });
    expect(resolution.action).toBe("bounded-follow-up");
    expect(resolution.shouldReleaseSlot).toBe(false);
    expect(resolution.shouldInjectNewInstruction).toBe(false);
  });

  it("⑪ 追问次数耗尽：报告阻塞并保留队列，不无限请求模型", () => {
    const resolution = resolveMissingReceipt({
      classification: classifyModelStop({
        stopReason: "stop",
        hasValidClosingReceipt: false,
        hasIndependentAuthoritativeEvidence: false,
        isWaitingForUserDetails: false,
        producedTextDeltaCount: 1,
        isExplicitUserStop: false,
        isResting: false,
      }),
      remainingFollowUpAttempts: 0,
    });
    expect(resolution.action).toBe("report-blocked-keep-window");
    expect(resolution.shouldReleaseSlot).toBe(false);
    expect(resolution.detail).toContain("保留队列");
  });
});
