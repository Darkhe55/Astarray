/**
 * TOOLKIT-01-04 反例（2026-10-10，收官片）：**取消 / 崩溃恢复管理入口**与**独立反馈**。
 *
 * 卡内 §7/§8 要求：
 *  - "运行时**有界依赖深度/执行预算、取消与回执**"；
 *  - "**启用/停用/锁定变更按 revision 原子提交**。停用阻止新运行，**在途调用按安全点
 *    取消/收敛，不能删掉运行中的文件造成结果未知**"；
 *  - 检查点 04："**取消/崩溃恢复**与**独立反馈**"。
 *
 * 上一轮已有 `recordPendingVersionSwitch` / `recoverFromInterruptedSwitch` 两个底层方法，
 * 但**没有管理入口**：跨进程（真实 CLI）既看不到"半提交"现场，也无法触发恢复；
 * 也**没有独立反馈**记录（谁在何时对哪个包做了什么、结果如何）。
 *
 * 本片钉住的语义：
 *  - 半提交的切换意图必须**持久化**，重启后仍可见（跨进程可恢复）；
 *  - 恢复必须收敛到**上一个可信版本**，且**绝不留下"已启用但哈希不符"**；
 *  - 恢复本身要产生**可核对记录**（做了什么、从哪个版本到哪个版本）；
 *  - **取消**必须阻止新运行，但**在途调用不得被删除**，须按安全点收敛；
 *  - **独立反馈**必须携带来源（具体 `agentInstanceId`）、revision、动作与结果，
 *    且**不得含秘密**。
 *
 * 只跑本地临时目录与真实 CLI 子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ToolPackageOperationFeedbackStore,
  cancelProjectToolPackage,
  recoverInterruptedVersionSwitch,
} from "../../../packages/core/src/toolkit/tool-package-operation-control.js";
import { ToolPackageVersionStateStore } from "../../../packages/core/src/toolkit/tool-package-version-state-store.js";

const executeFile = promisify(execFile);
const cliEntryPath = path.resolve("dist/cli.js");

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit-ctl-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function hash(character: string): string {
  return "sha256:" + character.repeat(64);
}

async function seedEnabledPackage(): Promise<void> {
  const store = new ToolPackageVersionStateStore({ stateDirectory });
  await store.registerVersion({
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none"],
    declaredDependencies: [],
    permissionRequirements: [],
  });
  await store.registerVersion({
    toolPackageId: "report-formatter",
    version: 2,
    contentHash: hash("b"),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none", "file-write"],
    declaredDependencies: [],
    permissionRequirements: [],
  });
  await store.lockProjectToVersion({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: hash("a"),
  });
  await store.enableForProject({
    projectIdentifier: "project-alpha",
    toolPackageId: "report-formatter",
    version: 1,
  });
}

async function runCli(argumentsList: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await executeFile(process.execPath, [cliEntryPath, ...argumentsList], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("TOOLKIT-01-04：取消（阻止新运行，不删除在途）", () => {
  it("① 取消后新运行被阻止，但在途调用**仍在**且可按安全点收敛", async () => {
    await seedEnabledPackage();
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    const controller = await store.loadController();
    controller.recordInFlightCall({
      runIdentifier: "run-inflight-1",
      stepIdentifier: "step-1",
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      argumentHash: hash("c"),
    });
    await store.saveController(controller);

    const cancellation = await cancelProjectToolPackage({
      stateDirectory,
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      reason: "用户要求停止后续运行",
      requestingAgentInstanceId: "agent-operator",
    });
    expect(cancellation.isCancelled).toBe(true);

    // 新运行被阻止
    const reopened = new ToolPackageVersionStateStore({ stateDirectory });
    const afterCancel = await reopened.loadController();
    expect(
      afterCancel.resolveVersionForExecution({
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
      }),
    ).toBeNull();
    // 在途调用**不得被删除**
    expect(
      afterCancel.listInFlightCalls({ projectIdentifier: "project-alpha" }),
    ).toHaveLength(1);
    // 可按安全点收敛
    expect(afterCancel.convergeInFlightCall({ runIdentifier: "run-inflight-1" }).isConverged).toBe(
      true,
    );
    await reopened.saveController(afterCancel);
    const finalStore = new ToolPackageVersionStateStore({ stateDirectory });
    expect(
      (await finalStore.loadController()).listInFlightCalls({
        projectIdentifier: "project-alpha",
      }),
    ).toHaveLength(0);
  });
});

describe("TOOLKIT-01-04：崩溃恢复（半提交收敛到可信版本）", () => {
  it("② 半提交意图必须持久化，新进程可恢复且收敛到**上一个可信版本**", async () => {
    await seedEnabledPackage();
    // 模拟崩溃前落盘的"半提交"意图（目标哈希与实际不符）
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    const controller = await store.loadController();
    controller.recordPendingVersionSwitch({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      intendedVersion: 2,
      intendedContentHash: hash("7"),
    });
    await store.saveController(controller);

    const recovery = await recoverInterruptedVersionSwitch({
      stateDirectory,
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      requestingAgentInstanceId: "agent-operator",
    });
    expect(recovery.isRecovered).toBe(true);
    expect(recovery.activeVersion).toBe(1);

    // 关键不变量：绝不留下"已启用但哈希不符"
    const reopened = new ToolPackageVersionStateStore({ stateDirectory });
    const resolved = (await reopened.loadController()).resolveVersionForExecution({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    expect(resolved?.version).toBe(1);
    expect(resolved?.contentHash).toBe(hash("a"));
    // 半提交意图必须已被消费（不得反复恢复）
    expect((await reopened.readSnapshot()).pendingSwitches).toHaveLength(0);
  });
});

describe("TOOLKIT-01-04：独立反馈记录", () => {
  it("③ 反馈必须含来源 agentInstanceId、动作、revision 与结果，且不得含秘密", async () => {
    await seedEnabledPackage();
    const feedbackStore = new ToolPackageOperationFeedbackStore({ stateDirectory });
    await cancelProjectToolPackage({
      stateDirectory,
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      reason: "用户要求停止",
      requestingAgentInstanceId: "agent-operator",
    });
    const records = await feedbackStore.listRecords();
    expect(records.length).toBeGreaterThan(0);
    const record = records.at(-1);
    expect(record?.requestingAgentInstanceId).toBe("agent-operator");
    expect(record?.operationKind).toBe("cancel");
    expect(typeof record?.revision).toBe("number");
    expect(record?.outcome).toBe("applied");

    // 不得记录秘密
    await expect(
      feedbackStore.appendRecord({
        operationKind: "recover",
        projectIdentifier: "project-alpha",
        toolPackageId: "report-formatter",
        requestingAgentInstanceId: "agent-operator",
        revision: 1,
        outcome: "applied",
        detail: "sk-live-abcdefghijklmnop",
      }),
    ).rejects.toThrowError(/秘密|凭据|不得记录/);
  });
});

describe("TOOLKIT-01-04：CLI 管理入口（取消 / 恢复与独立反馈）", () => {
  it("④ 真实 CLI 能取消、能恢复，并可按 JSON 读取独立反馈", async () => {
    await seedEnabledPackage();
    const cancelResult = await runCli([
      "tool-package", "cancel", "report-formatter",
      "--project", "project-alpha",
      "--state-dir", stateDirectory,
      "--json",
    ]);
    expect(cancelResult.exitCode, "stderr=" + cancelResult.stderr).toBe(0);

    const statusAfterCancel = await runCli([
      "tool-package", "status", "report-formatter",
      "--project", "project-alpha", "--state-dir", stateDirectory, "--json",
    ]);
    expect(statusAfterCancel.exitCode, "stderr=" + statusAfterCancel.stderr).toBe(0);
    expect(JSON.parse(statusAfterCancel.stdout.trim()).isEnabled).toBe(false);

    const recoverResult = await runCli([
      "tool-package", "recover", "report-formatter",
      "--project", "project-alpha",
      "--state-dir", stateDirectory,
      "--json",
    ]);
    expect(recoverResult.exitCode, "stderr=" + recoverResult.stderr).toBe(0);

    const feedbackResult = await runCli([
      "tool-package", "feedback",
      "--state-dir", stateDirectory,
      "--json",
    ]);
    expect(feedbackResult.exitCode, "stderr=" + feedbackResult.stderr).toBe(0);
    const feedbackPayload = JSON.parse(feedbackResult.stdout.trim()) as {
      records: Array<{ operationKind: string; requestingAgentInstanceId: string }>;
    };
    expect(feedbackPayload.records.length).toBeGreaterThanOrEqual(2);
    expect(feedbackPayload.records.map((record) => record.operationKind)).toContain("cancel");
    expect(feedbackPayload.records.map((record) => record.operationKind)).toContain("recover");
  });
});
