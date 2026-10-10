/**
 * SMART-01-04 包级验收**判定逻辑**的测试（先红后绿，2026-10-10）。
 *
 * 动机（本仓已有教训）：`scripts/lib/t07d-r2-04-acceptance-decision.mjs` 的存在就是因为
 * 内联判定曾导致"零判据通过"。包级验收的判据同样必须是**可测试的不变量**：
 *  - 上限 3 时第 4 条必须 `queued`（不是 admitted、更不是被丢弃）；
 *  - 排队/已派发**不得**被判为成果完成；
 *  - 超期必须 `overdue-not-dispatched` 且 `isTruthfulTimeout=true`；
 *  - 未知幂等键必须**非 0 退出码**；
 *  - 任何必需项缺失（例如根本没跑出 JSON）⇒ **失败**，不得缺省跳过（fail-closed）。
 *
 * 运行：`npm run test:scripts`（node --test）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInstructionPackageChecks } from "./smart01-instruction-package-checks.mjs";

/** 造一份"全部正常"的观测输入；各用例只覆盖需要变形的字段。 */
function buildPassingObservation() {
  return {
    admitResult: {
      exitCode: 0,
      stdoutText: JSON.stringify({
        admissionOutcome: "admitted",
        windowCapacity: 3,
        activeInstructionCount: 1,
        queuedInstructionCount: 0,
      }),
    },
    fourthAdmit: {
      exitCode: 0,
      stdoutText: JSON.stringify({
        admissionOutcome: "queued",
        windowCapacity: 3,
        activeInstructionCount: 3,
        queuedInstructionCount: 1,
      }),
    },
    listResult: {
      exitCode: 0,
      stdoutText: JSON.stringify({
        windowCapacity: 3,
        activeInstructions: [
          { instructionIdentifier: "i-1", state: "dispatched" },
          { instructionIdentifier: "i-2", state: "dispatched" },
          { instructionIdentifier: "i-3", state: "dispatched" },
        ],
        queuedInstructions: [{ instructionIdentifier: "i-4", state: "accepted" }],
        terminalInstructions: [],
      }),
    },
    withinDeadline: {
      exitCode: 0,
      stdoutText: JSON.stringify({
        kind: "dispatched-within-deadline",
        isTruthfulTimeout: false,
        isWorkCompleted: false,
      }),
    },
    overdueDeadline: {
      exitCode: 0,
      stdoutText: JSON.stringify({
        kind: "overdue-not-dispatched",
        isTruthfulTimeout: true,
        isWorkCompleted: false,
      }),
    },
    unknownKey: { exitCode: 1, stdoutText: "" },
  };
}

function findCheck(checks, nameFragment) {
  return checks.find((check) => check.name.includes(nameFragment));
}

function allPassed(checks) {
  return checks.every((check) => check.passed);
}

test("全部正常观测 ⇒ 所有判据通过（基例）", () => {
  const checks = buildInstructionPackageChecks(buildPassingObservation());
  assert.equal(checks.length >= 6, true, "判据数量应覆盖准入/排队/列表/期限/未知键");
  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  assert.deepEqual(failed, [], "基例不应有失败项：" + failed.join("、"));
  assert.equal(allPassed(checks), true);
});

test("第 4 条被 admitted（未排队）⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.fourthAdmit = {
    exitCode: 0,
    stdoutText: JSON.stringify({
      admissionOutcome: "admitted",
      windowCapacity: 3,
      activeInstructionCount: 4,
      queuedInstructionCount: 0,
    }),
  };
  const checks = buildInstructionPackageChecks(observation);
  const fourthCheck = findCheck(checks, "第 4 条");
  assert.equal(fourthCheck?.passed, false, "第 4 条未排队必须判失败");
  assert.equal(allPassed(checks), false);
});

test("上限不是 3（窗口容量被改写）⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.fourthAdmit = {
    exitCode: 0,
    stdoutText: JSON.stringify({
      admissionOutcome: "queued",
      windowCapacity: 5,
      activeInstructionCount: 3,
      queuedInstructionCount: 1,
    }),
  };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "第 4 条")?.passed, false);
});

test("超期但未如实报超时 ⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.overdueDeadline = {
    exitCode: 0,
    stdoutText: JSON.stringify({
      kind: "dispatched-within-deadline",
      isTruthfulTimeout: false,
      isWorkCompleted: false,
    }),
  };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "超过三分钟必须如实报超时")?.passed, false);
  assert.equal(allPassed(checks), false);
});

test("等待澄清/排队被当作成果完成 ⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.overdueDeadline = {
    exitCode: 0,
    stdoutText: JSON.stringify({
      kind: "overdue-not-dispatched",
      isTruthfulTimeout: true,
      isWorkCompleted: true,
    }),
  };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "超过三分钟必须如实报超时")?.passed, false);
});

test("未知幂等键退出码为 0 ⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.unknownKey = { exitCode: 0, stdoutText: "{}" };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "未知")?.passed, false);
  assert.equal(allPassed(checks), false);
});

test("列表输出缺字段或非 JSON ⇒ 必须失败（fail-closed，不得缺省跳过）", () => {
  const observation = buildPassingObservation();
  observation.listResult = { exitCode: 0, stdoutText: "not-json" };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "instruction list --json")?.passed, false);
  assert.equal(allPassed(checks), false);
});

test("窗口内指令数为 0（根本没进窗口）⇒ 必须失败", () => {
  const observation = buildPassingObservation();
  observation.listResult = {
    exitCode: 0,
    stdoutText: JSON.stringify({
      windowCapacity: 3,
      activeInstructions: [],
      queuedInstructions: [],
      terminalInstructions: [],
    }),
  };
  const checks = buildInstructionPackageChecks(observation);
  assert.equal(findCheck(checks, "instruction list --json")?.passed, false);
});

test("全部观测缺失 ⇒ 全部判失败，且不抛错（零判据不得通过）", () => {
  const checks = buildInstructionPackageChecks({});
  assert.equal(checks.length >= 6, true);
  assert.equal(allPassed(checks), false);
  const failed = checks.filter((check) => check.passed);
  assert.deepEqual(failed, [], "零观测时不得有任何通过项");
});
