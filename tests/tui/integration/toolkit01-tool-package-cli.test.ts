/**
 * TOOLKIT-01-04 反例（2026-10-10，管理入口片）：工具包版本的**持久化 + CLI 管理入口**。
 *
 * 卡内检查点 04 要求"参数授权设置接线、**升级差异**、**停用/回滚**、取消/崩溃恢复与独立反馈"，
 * 检查点 06 要求"共用 SDK 与 **CLI/TUI/GUI 最小管理入口**"。
 *
 * 实测缺口：上一轮实现的 `ToolPackageVersionController` 是**纯内存**的，
 * 且**没有任何 CLI/管理入口** ⇒ 跨进程（真实 CLI 调用）无法看到锁定/启用/历史状态，
 * "停用阻止新运行"与"回滚"在真实使用路径上不可达。
 *
 * 本片钉住：
 *  - 版本状态必须**持久化**，新进程读回一致（含锁定版本、启用状态、revision、调用历史）；
 *  - **升级差异**必须可展示（行为/依赖/权限差异 + 新增副作用 + 是否需要重新授权）；
 *  - 真实 `dist/cli.js` 子进程能执行 **describe / enable / disable / rollback / status**，
 *    并且 **disable 之后 status 显示未启用、rollback 后显示旧版本**；
 *  - 未重新授权时经 CLI 升级含新增副作用的版本必须**失败且退出码非 0**。
 *
 * 只跑本地临时目录与真实 CLI 子进程；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolPackageVersionStateStore } from "../../../packages/core/src/toolkit/tool-package-version-state-store.js";

const executeFile = promisify(execFile);

let stateDirectory: string;
const cliEntryPath = path.resolve("dist/cli.js");

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit04-cli-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildVersionInput(overrides: Record<string, unknown> = {}) {
  return {
    toolPackageId: "report-formatter",
    version: 1,
    contentHash: "sha256:" + "a".repeat(64),
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none"],
    declaredDependencies: ["vitest>=1"],
    permissionRequirements: ["read-file"],
    ...overrides,
  };
}

async function runCli(argumentsList: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await executeFile(process.execPath, [cliEntryPath, ...argumentsList], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("TOOLKIT-01-04：版本状态持久化", () => {
  it("① 锁定/启用/历史必须跨实例持久化，且 revision 继续递增", async () => {
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    await store.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    const firstEnable = await store.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });

    // 新实例读回一致
    const reopened = new ToolPackageVersionStateStore({ stateDirectory });
    const snapshot = await reopened.readSnapshot();
    expect(snapshot.projectLocks).toHaveLength(1);
    expect(snapshot.projectLocks[0]?.version).toBe(1);
    expect(snapshot.projectLocks[0]?.isEnabled).toBe(true);
    expect(snapshot.projectLocks[0]?.revision).toBe(firstEnable.revision);

    // revision 跨实例继续递增（不是从 0 重来）
    const secondChange = await reopened.disableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
    });
    expect(secondChange.revision).toBeGreaterThan(firstEnable.revision);
  });
});

describe("TOOLKIT-01-04：CLI 管理入口（真实子进程）", () => {
  it("② describe 必须展示升级差异（含新增副作用与是否需重新授权）", async () => {
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        declaredSideEffects: ["none", "file-write"],
        declaredDependencies: ["vitest>=1", "jsdom>=20"],
        permissionRequirements: ["read-file", "write-file"],
      }),
    );

    const result = await runCli([
      "tool-package",
      "describe",
      "report-formatter",
      "--from",
      "1",
      "--to",
      "2",
      "--state-dir",
      stateDirectory,
      "--json",
    ]);
    expect(result.exitCode, "stderr=" + result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      addedSideEffects: string[];
      requiresReauthorization: boolean;
      dependencyDifferences: string[];
      permissionDifferences: string[];
    };
    expect(parsed.addedSideEffects).toEqual(["file-write"]);
    expect(parsed.requiresReauthorization).toBe(true);
    expect(parsed.dependencyDifferences).toContain("jsdom>=20");
    expect(parsed.permissionDifferences).toContain("write-file");
  });

  it("③ enable → disable → rollback → status 全链路经真实 CLI 生效", async () => {
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({ version: 2, contentHash: "sha256:" + "b".repeat(64) }),
    );
    await store.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });

    const enable = await runCli([
      "tool-package", "enable", "report-formatter",
      "--project", "project-alpha", "--tool-version", "1",
      "--state-dir", stateDirectory, "--json",
    ]);
    expect(enable.exitCode, "stderr=" + enable.stderr).toBe(0);

    const statusEnabled = await runCli([
      "tool-package", "status", "report-formatter",
      "--project", "project-alpha", "--state-dir", stateDirectory, "--json",
    ]);
    expect(statusEnabled.exitCode, "stderr=" + statusEnabled.stderr).toBe(0);
    expect(JSON.parse(statusEnabled.stdout.trim()).isEnabled).toBe(true);

    // 停用后：新运行被阻止
    const disable = await runCli([
      "tool-package", "disable", "report-formatter",
      "--project", "project-alpha", "--state-dir", stateDirectory, "--json",
    ]);
    expect(disable.exitCode, "stderr=" + disable.stderr).toBe(0);
    const statusDisabled = await runCli([
      "tool-package", "status", "report-formatter",
      "--project", "project-alpha", "--state-dir", stateDirectory, "--json",
    ]);
    expect(JSON.parse(statusDisabled.stdout.trim()).isEnabled).toBe(false);

    // 重新启用后回滚到 version 1（此处已启用版本 1，先升到 2 再回滚以验证切换）
    const enableTwo = await runCli([
      "tool-package", "upgrade", "report-formatter",
      "--project", "project-alpha", "--tool-version", "2",
      "--state-dir", stateDirectory, "--json",
    ]);
    expect(enableTwo.exitCode, "stderr=" + enableTwo.stderr).toBe(0);
    const rollback = await runCli([
      "tool-package", "rollback", "report-formatter",
      "--project", "project-alpha", "--tool-version", "1",
      "--state-dir", stateDirectory, "--json",
    ]);
    expect(rollback.exitCode, "stderr=" + rollback.stderr).toBe(0);
    const statusAfterRollback = await runCli([
      "tool-package", "status", "report-formatter",
      "--project", "project-alpha", "--state-dir", stateDirectory, "--json",
    ]);
    expect(JSON.parse(statusAfterRollback.stdout.trim()).version).toBe(1);
  });

  it("④ 未重新授权时经 CLI 升级含新增副作用的版本必须失败（退出码非 0）", async () => {
    const store = new ToolPackageVersionStateStore({ stateDirectory });
    await store.registerVersion(buildVersionInput({ version: 1 }));
    await store.registerVersion(
      buildVersionInput({
        version: 2,
        contentHash: "sha256:" + "b".repeat(64),
        declaredSideEffects: ["none", "file-write"],
      }),
    );
    await store.lockProjectToVersion({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
      contentHash: "sha256:" + "a".repeat(64),
    });
    await store.enableForProject({
      projectIdentifier: "project-alpha",
      toolPackageId: "report-formatter",
      version: 1,
    });

    const upgrade = await runCli([
      "tool-package", "upgrade", "report-formatter",
      "--project", "project-alpha", "--tool-version", "2",
      "--state-dir", stateDirectory, "--json",
    ]);
    expect(upgrade.exitCode, "stderr=" + upgrade.stderr).not.toBe(0);
    expect(upgrade.stderr + upgrade.stdout).toMatch(/新增副作用|重新授权/);

    // 带显式重新授权标志则成功
    const reauthorized = await runCli([
      "tool-package", "upgrade", "report-formatter",
      "--project", "project-alpha", "--tool-version", "2",
      "--reauthorized",
      "--state-dir", stateDirectory, "--json",
    ]);
    expect(reauthorized.exitCode, "stderr=" + reauthorized.stderr).toBe(0);
  });
});
