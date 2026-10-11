/**
 * MERGE-01-03 反例（2026-10-10）：**连续输入 / 部分失败 / 取消 / 重启**端到端。
 *
 * 卡内 §1.1 明文：
 *  - "多项可共用一次读取/检索，但**每个子结果映射回原 ID**；
 *    **部分失败只影响对应节点**。**取消一项不得取消其他项**，
 *    执行后不能通过拆组合并重放副作用"；
 *  - "原始用户指令**追加保存**"。
 * 检查点 03 要求："在已接通 SMART 路径上验证**连续输入、部分失败/取消/重启**"。
 *
 * 现状缺口（本轮实测）：
 *  ① 合并控制器**完全没有持久化** ⇒ 进程重启后**组与原指令全丢**，
 *    与卡内"原始用户指令**追加保存**"不符，连续输入也无法跨重启延续；
 *  ② 没有"**部分失败只影响对应节点**"的结算语义；
 *  ③ 没有"**取消一项不得取消其他项**"的隔离语义；
 *  ④ 建组后再到达的指令**可能被悄悄并入**既有组（资格集合是建组时的快照）。
 *
 * 本片钉住的语义：
 *  - 组与原指令**可跨重启恢复**（含资格集合快照）；
 *  - **部分失败只结算对应节点**，同组其他节点不受影响；
 *  - **取消一项**不影响同组其他项，且不改变它们的结算；
 *  - 建组后**晚到**的指令**不得**被并入既有组（须新建组或另走流程）。
 *
 * 只跑本地临时目录与真实子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInstructionMergeController,
  type InstructionMergeCandidate,
  type OriginalInstructionRecord,
} from "../../../packages/core/src/toolkit/instruction-merge-mapping.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-merge03-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildInstruction(instructionIdentifier: string): OriginalInstructionRecord {
  return {
    instructionIdentifier,
    instructionText: "指令 " + instructionIdentifier,
    sourceKind: "user",
    sourceActorIdentifier: "user-1",
    revision: 1,
    priorityTier: 0,
    cancellationRightHolderIdentifier: "user-1",
    acceptanceCriteria: ["完成"],
    isCompleted: false,
  };
}

function buildCandidate(instructionIdentifier: string): InstructionMergeCandidate {
  return {
    instructionIdentifier,
    revision: 1,
    instructionText: "指令 " + instructionIdentifier,
    projectIdentifier: "project-alpha",
    taskAuthorityIdentifier: "authority-1",
    permissionScopeIdentifier: "scope-1",
    goalIdentifier: "goal-1",
    priorityTier: 0,
    supersedesInstructionIdentifiers: [],
    dependencyNodeIdentifiers: [],
    completedDependencyNodeIdentifiers: [],
    isSemanticallyConflicting: false,
    isGoalAmbiguous: false,
    requiresIndependentAuthorization: false,
    hasSideEffectInFlight: false,
  };
}

function buildController() {
  return createInstructionMergeController({
    isMergeEnabled: true,
    windowCapacity: 8,
    stateDirectory,
  });
}

describe("MERGE-01-03：部分失败只影响对应节点", () => {
  it("① 一个节点失败不影响同组其他节点，且失败节点可单独如实回报", () => {
    const controller = buildController();
    for (const identifier of ["ins-1", "ins-2", "ins-3"]) {
      controller.appendInstruction(buildInstruction(identifier));
    }
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2", "ins-3"].map(buildCandidate),
    });

    const settlement = controller.settleGroupMember({
      groupIdentifier: "group-1",
      instructionIdentifier: "ins-2",
      outcome: "failed",
      reason: "该节点读取失败",
    });
    expect(settlement.isSettled).toBe(true);

    const members = controller.describeGroupMemberSettlements({
      groupIdentifier: "group-1",
    });
    const failedMember = members.find(
      (member) => member.instructionIdentifier === "ins-2",
    );
    expect(failedMember?.outcome).toBe("failed");
    // 其他节点**不受影响**（仍是 pending）
    for (const identifier of ["ins-1", "ins-3"]) {
      const other = members.find((member) => member.instructionIdentifier === identifier);
      expect(other?.outcome, identifier + " 不应受 ins-2 失败影响").toBe("pending");
    }
    // 失败**不得**关掉原指令（卡内"组完成不自动关闭全部原指令"）
    expect(controller.isInstructionCompleted("ins-2")).toBe(false);
  });
});

describe("MERGE-01-03：取消一项不得取消其他项", () => {
  it("② 取消 ins-2 后，ins-1/ins-3 的结算保持原样", () => {
    const controller = buildController();
    for (const identifier of ["ins-1", "ins-2", "ins-3"]) {
      controller.appendInstruction(buildInstruction(identifier));
    }
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2", "ins-3"].map(buildCandidate),
    });
    // 先让 ins-1 成功，确保取消 ins-2 后可核对 ins-1 **保持成功**
    controller.settleGroupMember({
      groupIdentifier: "group-1",
      instructionIdentifier: "ins-1",
      outcome: "succeeded",
      reason: null,
    });

    const cancellation = controller.cancelGroupMember({
      groupIdentifier: "group-1",
      instructionIdentifier: "ins-2",
      cancelledByAgentInstanceId: "user-1",
      reason: "用户撤回该条",
    });
    expect(cancellation.isCancelled).toBe(true);

    const members = controller.describeGroupMemberSettlements({
      groupIdentifier: "group-1",
    });
    expect(members.find((member) => member.instructionIdentifier === "ins-1")?.outcome).toBe(
      "succeeded",
    );
    expect(members.find((member) => member.instructionIdentifier === "ins-2")?.outcome).toBe(
      "cancelled",
    );
    expect(members.find((member) => member.instructionIdentifier === "ins-3")?.outcome).toBe(
      "pending",
    );
  });

  it("③ 非取消权持有者不得取消（保留取消权语义）", () => {
    const controller = buildController();
    for (const identifier of ["ins-1", "ins-2"]) {
      controller.appendInstruction(buildInstruction(identifier));
    }
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2"].map(buildCandidate),
    });
    const outcome = controller.cancelGroupMember({
      groupIdentifier: "group-1",
      instructionIdentifier: "ins-1",
      cancelledByAgentInstanceId: "some-other-agent",
      reason: "越权取消",
    });
    expect(outcome.isCancelled).toBe(false);
    expect(String(outcome.reason)).toMatch(/取消权|无权|持有者/);
  });
});

describe("MERGE-01-03：连续输入与晚到指令", () => {
  it("④ 建组后**晚到**的指令不得被并入既有组（须新建组）", () => {
    const controller = buildController();
    for (const identifier of ["ins-1", "ins-2"]) {
      controller.appendInstruction(buildInstruction(identifier));
    }
    controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2"].map(buildCandidate),
    });

    // 晚到指令：引用既有组 + 新增者，必须被拒（否则等于悄悄扩大已定组）
    const lateArrival = controller.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2", "ins-3"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2", "ins-3"].map(buildCandidate),
    });
    expect(lateArrival.isCreated).toBe(false);
    // 既有组保持不变
    expect(
      controller.describeGroupMapping({ groupIdentifier: "group-1" }).map(
        (mapping) => mapping.instructionIdentifier,
      ),
    ).toEqual(["ins-1", "ins-2"]);
  });
});

describe("MERGE-01-03：重启", () => {
  it("⑤ 组、原指令与**成员结算**必须跨重启恢复（追加保存）", async () => {
    const firstController = buildController();
    for (const identifier of ["ins-1", "ins-2"]) {
      firstController.appendInstruction(buildInstruction(identifier));
    }
    firstController.createExecutionGroup({
      groupIdentifier: "group-1",
      referencedInstructionIdentifiers: ["ins-1", "ins-2"],
      createdByAgentInstanceId: "agent-1",
      mergeCandidates: ["ins-1", "ins-2"].map(buildCandidate),
    });
    firstController.settleGroupMember({
      groupIdentifier: "group-1",
      instructionIdentifier: "ins-1",
      outcome: "succeeded",
      reason: null,
    });
    const persistOutcome = await firstController.persistToDisk();
    expect(persistOutcome.isPersisted).toBe(true);

    // 全新控制器（不共享内存），仅凭磁盘恢复
    const restoredController = buildController();
    const restoreOutcome = await restoredController.restoreFromDisk();
    expect(restoreOutcome.isRestored).toBe(true);

    const mapping = restoredController.describeGroupMapping({ groupIdentifier: "group-1" });
    expect(mapping.map((entry) => entry.instructionIdentifier)).toEqual(["ins-1", "ins-2"]);
    // 原文逐字保留
    expect(mapping[0]?.instructionText).toBe("指令 ins-1");
    // **成员结算**也要恢复（否则重启后会重复执行已成功节点）
    const members = restoredController.describeGroupMemberSettlements({
      groupIdentifier: "group-1",
    });
    expect(members.find((member) => member.instructionIdentifier === "ins-1")?.outcome).toBe(
      "succeeded",
    );
    expect(members.find((member) => member.instructionIdentifier === "ins-2")?.outcome).toBe(
      "pending",
    );
  });

  it("⑥ 真实跨进程重启：子进程建组结算后退出，父进程重开必须恢复", async () => {
    const scriptDirectory = path.resolve(".tmp", "merge03-restart");
    await fs.mkdir(scriptDirectory, { recursive: true });
    const scriptPath = path.join(scriptDirectory, "merge-then-exit.mjs");
    await fs.writeFile(
      scriptPath,
      `
import { createInstructionMergeController } from __SDK_MODULE_URL__;
const stateDirectory = process.argv[2];
const controller = createInstructionMergeController({
  isMergeEnabled: true,
  windowCapacity: 8,
  stateDirectory,
});
const buildInstruction = (id) => ({
  instructionIdentifier: id, instructionText: "指令 " + id, sourceKind: "user",
  sourceActorIdentifier: "user-1", revision: 1, priorityTier: 0,
  cancellationRightHolderIdentifier: "user-1", acceptanceCriteria: ["完成"], isCompleted: false,
});
const buildCandidate = (id) => ({
  instructionIdentifier: id, revision: 1, instructionText: "指令 " + id,
  projectIdentifier: "project-alpha", taskAuthorityIdentifier: "authority-1",
  permissionScopeIdentifier: "scope-1", goalIdentifier: "goal-1", priorityTier: 0,
  supersedesInstructionIdentifiers: [], dependencyNodeIdentifiers: [],
  completedDependencyNodeIdentifiers: [], isSemanticallyConflicting: false,
  isGoalAmbiguous: false, requiresIndependentAuthorization: false, hasSideEffectInFlight: false,
});
controller.appendInstruction(buildInstruction("child-1"));
controller.appendInstruction(buildInstruction("child-2"));
const created = controller.createExecutionGroup({
  groupIdentifier: "group-child",
  referencedInstructionIdentifiers: ["child-1", "child-2"],
  createdByAgentInstanceId: "agent-child",
  mergeCandidates: [buildCandidate("child-1"), buildCandidate("child-2")],
});
controller.settleGroupMember({
  groupIdentifier: "group-child",
  instructionIdentifier: "child-1",
  outcome: "succeeded",
  reason: null,
});
const persisted = await controller.persistToDisk();
process.stdout.write(created.isCreated && persisted.isPersisted ? "OK\\n" : "FAILED\\n");
process.exit(0);
`.replace(
        "__SDK_MODULE_URL__",
        JSON.stringify(pathToFileURL(path.resolve("dist/public-sdk.js")).href),
      ),
      "utf8",
    );

    const childExitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [scriptPath, stateDirectory], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      });
      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
      child.on("close", (code) => {
        expect(stdoutBuffer).toContain("OK");
        resolve(code ?? 1);
      });
    });
    expect(childExitCode).toBe(0);

    const parentController = buildController();
    const restoreOutcome = await parentController.restoreFromDisk();
    expect(restoreOutcome.isRestored).toBe(true);
    expect(
      parentController
        .describeGroupMapping({ groupIdentifier: "group-child" })
        .map((entry) => entry.instructionIdentifier),
    ).toEqual(["child-1", "child-2"]);
    expect(
      parentController
        .describeGroupMemberSettlements({ groupIdentifier: "group-child" })
        .find((member) => member.instructionIdentifier === "child-1")?.outcome,
    ).toBe("succeeded");
  });
});
