/**
 * RELIABILITY-01-02 反例（2026-10-10）：**故障注入矩阵**必须可核对、如实、且覆盖完整。
 *
 * 卡内 §"故障注入矩阵"要求把注入时点与覆盖维度落成矩阵，并
 * "**禁止用过窄真实计时窗口证明正确**"；检查点 01/02 要求"每项标**已证实/失败/未验证**"。
 *
 * 现状缺口：矩阵此前是**散文表格**（`RELIABILITY_01_01_AUDIT_MATRIX_2026-10-02.md` §6），
 * **无法执行核对**：既不能自动发现"引用了不存在的测试"，也不能发现"覆盖维度缺失"。
 *
 * 本片钉住的语义：
 *  - `confirmed` / `fixed` **必须**给出**真实存在**的证据引用；
 *  - **未验证**条目**不得**提供证据引用（不得拿别的测试冒充已证实）；
 *  - 卡内点名的覆盖维度**缺一即矩阵不完整**；
 *  - **未验证条目必须被如实列出**（不能被"全部通过"的假象掩盖）。
 *
 * 只跑纯函数 + 只读存在性检查，无 I/O 写入、不联网。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  FAULT_INJECTION_MATRIX,
  auditFaultInjectionMatrix,
  type FaultInjectionEntry,
} from "../../../packages/core/src/toolkit/fault-injection-matrix.js";

const repositoryRoot = process.cwd();

describe("RELIABILITY-01：故障注入矩阵（如实、可核对）", () => {
  it("① 真实矩阵：所有证据引用必须存在，且未验证条目不得带证据", () => {
    const outcome = auditFaultInjectionMatrix({
      entries: FAULT_INJECTION_MATRIX,
      repositoryRoot,
    });
    const rejected = outcome.entries.filter((entry) => !entry.isAccepted);
    expect(
      rejected.map((entry) => entry.entryIdentifier + ":" + String(entry.reason)),
    ).toEqual([]);
  });

  it("② 卡内点名的覆盖维度必须齐备", () => {
    const outcome = auditFaultInjectionMatrix({
      entries: FAULT_INJECTION_MATRIX,
      repositoryRoot,
    });
    expect(outcome.missingCoverageDimensions).toEqual([]);
    expect(outcome.isCoverageComplete).toBe(true);
  });

  it("③ 未验证条目必须被**如实列出**（不得被'全部通过'掩盖）", () => {
    const outcome = auditFaultInjectionMatrix({
      entries: FAULT_INJECTION_MATRIX,
      repositoryRoot,
    });
    // 本仓当前确实还有未验证时点 ⇒ 必须出现，且矩阵的 isAccepted 不得掩盖它们
    expect(outcome.unverifiedEntryIdentifiers.length).toBeGreaterThan(0);
    for (const identifier of outcome.unverifiedEntryIdentifiers) {
      const entry = outcome.entries.find((candidate) => candidate.entryIdentifier === identifier);
      expect(entry?.verdict).toMatch(/not-verified|gap/);
      // 未验证条目不得带证据引用
      expect(entry?.evidenceFilePaths ?? []).toEqual([]);
    }
  });

  it("④ 声称已证实但**引用不存在的文件** ⇒ 拒绝", () => {
    const fabricated: FaultInjectionEntry[] = [
      {
        entryIdentifier: "fabricated-evidence",
        timing: "inflight",
        dimension: "same-key-concurrency",
        representativeOperation: "虚构",
        verdict: "confirmed",
        summary: "声称已证实",
        evidenceFilePaths: ["tests/does-not-exist-at-all.test.ts"],
      },
    ];
    const outcome = auditFaultInjectionMatrix({ entries: fabricated, repositoryRoot });
    expect(outcome.entries[0]?.isAccepted).toBe(false);
    expect(String(outcome.entries[0]?.reason)).toMatch(/不存在|可核对/);
  });

  it("⑤ 声称已证实但**不给证据** ⇒ 拒绝（不得空口宣称）", () => {
    const withoutEvidence: FaultInjectionEntry[] = [
      {
        entryIdentifier: "no-evidence",
        timing: "inflight",
        dimension: "same-key-concurrency",
        representativeOperation: "虚构",
        verdict: "fixed",
        summary: "声称已修",
      },
    ];
    const outcome = auditFaultInjectionMatrix({ entries: withoutEvidence, repositoryRoot });
    expect(outcome.entries[0]?.isAccepted).toBe(false);
    expect(String(outcome.entries[0]?.reason)).toMatch(/未提供证据/);
  });

  it("⑥ 未验证条目却**提供证据** ⇒ 拒绝（不得拿别的测试冒充）", () => {
    const contradictory: FaultInjectionEntry[] = [
      {
        entryIdentifier: "unverified-with-evidence",
        timing: "before-dispatch",
        dimension: "parent-process-exit",
        representativeOperation: "虚构",
        verdict: "not-verified",
        summary: "未验证",
        evidenceFilePaths: ["tests/core/unit/feedback-client.test.ts"],
      },
    ];
    const outcome = auditFaultInjectionMatrix({ entries: contradictory, repositoryRoot });
    expect(outcome.entries[0]?.isAccepted).toBe(false);
    expect(String(outcome.entries[0]?.reason)).toMatch(/冒充|未覆盖/);
  });

  it("⑦ 覆盖维度缺失 ⇒ 矩阵不完整且给出缺失项", () => {
    const partial: FaultInjectionEntry[] = [
      {
        entryIdentifier: "only-one",
        timing: "inflight",
        dimension: "same-key-concurrency",
        representativeOperation: "虚构",
        verdict: "not-verified",
        summary: "未验证",
      },
    ];
    const outcome = auditFaultInjectionMatrix({ entries: partial, repositoryRoot });
    expect(outcome.isCoverageComplete).toBe(false);
    expect(outcome.missingCoverageDimensions).toContain("disk-full");
    expect(outcome.missingCoverageDimensions).toContain("zero-budget");
    expect(outcome.isAccepted).toBe(false);
  });

  it("⑧ 矩阵必须记录'子进程超时'的**跨平台限制**（不得宣称全平台已验证）", () => {
    const childProcessTimeoutEntry = FAULT_INJECTION_MATRIX.find(
      (entry) => entry.dimension === "child-process-timeout",
    );
    expect(childProcessTimeoutEntry).toBeDefined();
    expect(String(childProcessTimeoutEntry?.limitation)).toMatch(/POSIX|未验证/);
  });
});

describe("RELIABILITY-01：矩阵证据引用的**仓库相对路径**必须规范", () => {
  it("⑨ 证据引用不得是绝对路径（否则换机器即失效）", () => {
    for (const entry of FAULT_INJECTION_MATRIX) {
      for (const evidencePath of entry.evidenceFilePaths ?? []) {
        expect(path.isAbsolute(evidencePath)).toBe(false);
        expect(evidencePath.startsWith("tests/")).toBe(true);
      }
    }
  });
});
