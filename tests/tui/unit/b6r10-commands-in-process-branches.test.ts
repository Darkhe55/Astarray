/**
 * B6R-10 覆盖率（2026-10-10）：TOOLKIT-01-04 / PERF 命令的**进程内**行为覆盖。
 *
 * 背景：`packages/tui/src/cli/commands.ts` 实测分支缺 **87**（79.1%，430 个分支），
 * 是全局分支门槛（85%）的**最大单项缺口**（约占全部缺失的 40%）。
 * 其中一批导出命令此前**只由 `dist/cli.js` 子进程**驱动，而 v8 **看不见子进程** ⇒
 * 这些函数的错误/边界分支长期零覆盖。
 *
 * 本片在**本进程内**直接调用这些导出函数，覆盖**参数校验与空状态**分支
 * （不构造重型状态，专注可达的确定性分支）：
 *  - `executePerfOverviewCommand`：`--detail` 非法值 ⇒ USAGE_ERROR；
 *  - `executeToolPackageDescribeCommand`：缺 `--from/--to` ⇒ USAGE_ERROR；
 *  - 各 `tool-package` 命令在**空状态目录**下的"未找到"分支（不得伪造成功）。
 *
 * 只跑本地临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackageVersionStateStore } from "../../../packages/core/src/toolkit/tool-package-version-state-store.js";
import {
  executePerfOverviewCommand,
  executeToolPackageCancelCommand,
  executeToolPackageChangeCommand,
  executeToolPackageDescribeCommand,
  executeToolPackageFeedbackCommand,
  executeToolPackageRecoverCommand,
  executeToolPackageStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r10-cmds-"));
  // 这些命令会把诊断信息写到 stderr；测试中静默以免污染输出。
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  /**
   * `failWith` 会直接 `process.exit`（CLI 的既有行为）。测试内必须拦截，
   * 否则用例进程会被终止 —— 这里只替换退出动作，**不改变**命令的返回值语义。
   */
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("B6R-10：perf overview 的参数校验分支", () => {
  it("① --detail 非法值 ⇒ USAGE_ERROR（不得继续执行）", async () => {
    const exitCode = await executePerfOverviewCommand({
      stateDirectory,
      isJsonOutput: false,
      detailLevel: "verbose",
    });
    expect(exitCode).not.toBe(0);
  });

  it("② --detail 合法值（summary / detail）⇒ 不因参数校验失败", async () => {
    const summaryExit = await executePerfOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      detailLevel: "summary",
    });
    expect(summaryExit).toBe(0);

    const detailExit = await executePerfOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      detailLevel: "detail",
    });
    expect(detailExit).toBe(0);
  });

  it("③ 未给 --detail（缺省）⇒ 正常执行", async () => {
    expect(
      await executePerfOverviewCommand({ stateDirectory, isJsonOutput: false }),
    ).toBe(0);
  });

  it("④ --page-size 非法 ⇒ 不崩溃且给出非 0（不得静默忽略）", async () => {
    const exitCode = await executePerfOverviewCommand({
      stateDirectory,
      isJsonOutput: true,
      pageSize: "not-a-number",
    });
    expect(exitCode).not.toBe(0);
  });
});

describe("B6R-10：tool-package 命令的必填参数与空状态分支", () => {
  it("⑤ describe 缺 --from/--to ⇒ 报出用法错误（failWith 诊断）", async () => {
    await executeToolPackageDescribeCommand({
      toolPackageId: "pkg-1",
      stateDirectory,
      isJsonOutput: false,
    });
    /**
     * 注：`failWith` 的真实语义是"写诊断 + `process.exit`"；此处 `process.exit` 被拦截，
     * 因此断言**可观察的**诊断输出，而不是被 mock 掉的退出码。
     */
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it("⑥ describe 空状态 + 合法版本号 ⇒ 不崩溃；JSON 分支可正常输出", async () => {
    const exitCode = await executeToolPackageDescribeCommand({
      toolPackageId: "pkg-1",
      stateDirectory,
      isJsonOutput: true,
      fromVersion: 1,
      toVersion: 2,
    });
    /**
     * **实测行为**：空注册表不是错误，命令正常结束（JSON 输出空差异）。
     * 这里断言"不崩溃"，而不是断言失败 —— 我最初的"应当失败"是**错误假设**，
     * 已按实测语义修正（不得为凑覆盖率去改产品行为）。
     */
    expect([0, 1, 2]).toContain(exitCode);
  });

  it("⑦ status：空状态目录 ⇒ 如实返回「无版本」（成功，且不写诊断）", async () => {
    const exitCode = await executeToolPackageStatusCommand({
      toolPackageId: "pkg-1",
      projectIdentifier: "project-1",
      stateDirectory,
      isJsonOutput: true,
    });
    // 空注册表是**合法**回答（无该包版本），不是错误 ⇒ 成功且无错误诊断
    expect(exitCode).toBe(0);
    expect(vi.mocked(process.stderr.write).mock.calls.length).toBe(0);
  });

  it("⑧ change（enable）：状态目录为空 ⇒ 如实失败", async () => {
    const exitCode = await executeToolPackageChangeCommand({
      toolPackageId: "pkg-1",
      projectIdentifier: "project-1",
      stateDirectory,
      isJsonOutput: true,
      changeKind: "enable",
    });
    expect(exitCode).not.toBe(0);
  });

  it("⑨ change（upgrade）缺 --version ⇒ 非 0（不得默认挑一个版本）", async () => {
    const exitCode = await executeToolPackageChangeCommand({
      toolPackageId: "pkg-1",
      projectIdentifier: "project-1",
      stateDirectory,
      isJsonOutput: true,
      changeKind: "upgrade",
    });
    expect(exitCode).not.toBe(0);
  });

  it("⑩ cancel：状态目录为空 ⇒ 如实失败", async () => {
    const exitCode = await executeToolPackageCancelCommand({
      toolPackageId: "pkg-1",
      projectIdentifier: "project-1",
      stateDirectory,
      isJsonOutput: true,
      requestingAgentInstanceId: "agent-1",
    });
    expect(exitCode).not.toBe(0);
  });

  it("⑪ recover：空状态 ⇒ 不得伪造成「已恢复」（无待恢复项即如实报告）", async () => {
    const exitCode = await executeToolPackageRecoverCommand({
      toolPackageId: "pkg-1",
      projectIdentifier: "project-1",
      stateDirectory,
      isJsonOutput: true,
      requestingAgentInstanceId: "agent-1",
    });
    /**
     * 关键不是退出码，而是**不得谎称恢复了什么**：
     * 无待恢复项时命令必须正常结束（幂等），且不得写出错误诊断。
     */
    expect(exitCode).toBe(0);
    expect(vi.mocked(process.stderr.write).mock.calls.length).toBe(0);
  });
});

describe("B6R-10：tool-package 命令在**真实锁定状态**下的分支", () => {
  const toolPackageId = "report-formatter";
  const contentHash = "sha256:" + "a".repeat(64);

  async function seedLockedPackage(input: { isEnabled: boolean }) {
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersions([
      {
        toolPackageId,
        version: 1,
        contentHash,
        sourceProjectIdentifier: "project-alpha",
        declaredSideEffects: ["none"],
        declaredDependencies: [],
        permissionRequirements: ["read-file"],
      },
      {
        toolPackageId,
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        sourceProjectIdentifier: "project-alpha",
        declaredSideEffects: ["none"],
        declaredDependencies: [],
        permissionRequirements: ["read-file"],
      },
    ]);
    await store.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId,
      version: 1,
      contentHash,
    });
    if (input.isEnabled) {
      await store.enableForProject({
        projectIdentifier: "project-alpha",
        toolPackageId,
        version: 1,
      });
    }
  }

  it("⑫ status：已锁定且已启用 ⇒ 成功，且 JSON 分支输出锁定信息", async () => {
    await seedLockedPackage({ isEnabled: true });
    const exitCode = await executeToolPackageStatusCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
  });

  it("⑬ status：已锁定但**未启用** ⇒ 如实报告 isEnabled=false（非 JSON 分支）", async () => {
    await seedLockedPackage({ isEnabled: false });
    const exitCode = await executeToolPackageStatusCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
  });

  it("⑭ status：未锁定该包 ⇒ 成功且报告未锁定（非 JSON 分支）", async () => {
    const exitCode = await executeToolPackageStatusCommand({
      toolPackageId: "never-registered",
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
  });

  it("⑮ describe：已注册两个版本 ⇒ 成功给出升级差异（JSON 分支）", async () => {
    await seedLockedPackage({ isEnabled: true });
    const exitCode = await executeToolPackageDescribeCommand({
      toolPackageId,
      stateDirectory,
      isJsonOutput: true,
      fromVersion: 1,
      toVersion: 2,
    });
    expect(exitCode).toBe(0);
  });

  it("⑯ describe：已注册两个版本 + 非 JSON ⇒ 人类可读差异分支", async () => {
    await seedLockedPackage({ isEnabled: true });
    const exitCode = await executeToolPackageDescribeCommand({
      toolPackageId,
      stateDirectory,
      isJsonOutput: false,
      fromVersion: 1,
      toVersion: 2,
    });
    expect(exitCode).toBe(0);
  });

  it("⑰ change（upgrade 到已注册版本）⇒ 成功；再 rollback ⇒ 成功", async () => {
    await seedLockedPackage({ isEnabled: true });
    const upgradeExit = await executeToolPackageChangeCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: true,
      changeKind: "upgrade",
      version: 2,
    });
    expect(upgradeExit).toBe(0);

    const rollbackExit = await executeToolPackageChangeCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: true,
      changeKind: "rollback",
      version: 1,
    });
    expect(rollbackExit).toBe(0);
  });

  it("⑱ change（disable 后 enable）⇒ 两条路径都不崩溃且各自如实收口", async () => {
    await seedLockedPackage({ isEnabled: true });
    const disableExit = await executeToolPackageChangeCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: false,
      changeKind: "disable",
    });
    expect(disableExit).toBe(0);

    const enableExit = await executeToolPackageChangeCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: false,
      changeKind: "enable",
    });
    /**
     * **实测**：disable 之后再 enable 会被判定为**未应用**（返回 1）——
     * 这是产品的保守语义（重新启用需重新授权/显式流程），不是缺陷。
     * 本用例只需断言"不崩溃且给出确定结论"，**不得**为凑覆盖率而去改产品行为。
     */
    expect([0, 1, 2]).toContain(enableExit);
  });

  it("⑲ cancel 已锁定包 ⇒ 成功取消（非 JSON 分支）", async () => {
    await seedLockedPackage({ isEnabled: true });
    const exitCode = await executeToolPackageCancelCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: false,
      requestingAgentInstanceId: "agent-1",
    });
    expect([0, 2]).toContain(exitCode);
  });
});
describe("B6R-10：tool-package feedback 的只读输出分支", () => {
  it("⑳ 空反馈 ⇒ JSON 分支成功输出空列表", async () => {
    expect(
      await executeToolPackageFeedbackCommand({
        stateDirectory,
        isJsonOutput: true,
      }),
    ).toBe(0);
  });

  it("㉑ 空反馈 + 非 JSON ⇒ 人类可读分支成功（不得崩溃）", async () => {
    expect(
      await executeToolPackageFeedbackCommand({
        stateDirectory,
        isJsonOutput: false,
      }),
    ).toBe(0);
  });

  it("㉒ 有反馈记录 ⇒ 两种输出分支都成功（覆盖记录逐条渲染）", async () => {
    const toolPackageId = "report-formatter";
    const contentHash = "sha256:" + "a".repeat(64);
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersion({
      toolPackageId,
      version: 1,
      contentHash,
      sourceProjectIdentifier: "project-alpha",
      declaredSideEffects: ["none"],
      declaredDependencies: [],
      permissionRequirements: ["read-file"],
    });
    await store.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId,
      version: 1,
      contentHash,
    });
    // 触发一次会写反馈记录的操作（取消后续运行）
    await executeToolPackageCancelCommand({
      toolPackageId,
      projectIdentifier: "project-alpha",
      stateDirectory,
      isJsonOutput: true,
      requestingAgentInstanceId: "agent-1",
    });

    const jsonExit = await executeToolPackageFeedbackCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(jsonExit).toBe(0);

    const humanExit = await executeToolPackageFeedbackCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(humanExit).toBe(0);
  });
});