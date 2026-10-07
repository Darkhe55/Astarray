/**
 * E2E-01-03 S1：**工具路径**对陈旧写入的实际强制（红 → 绿）。
 *
 * 本文件与 `agent-edit-intent-stale-write.test.ts` 的分工：
 *  - 那个文件钉住守卫模块自身的语义（基线、覆盖规则、patch 保全、个体隔离、持久化）；
 *  - 本文件钉住**产品工具路径真的调用了它**——这正是此前缺的那一环
 *    （`StaleWriteGuard` 曾经只被单测调用，`AgentEditIntent` 没有产品侧生产者）。
 *
 * 同时显式钉住残余边界：**盲覆盖**（未读就写）不受人工基线保护。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentEditIntentGuard } from "../../../packages/core/src/orchestration/agent-edit-intent-guard.js";
import { BackupVault } from "../../../packages/core/src/tools/backup-vault.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let temporaryDirectoryPath: string;
let vault: BackupVault;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-s1-tool-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(temporaryDirectoryPath);
  vault = new BackupVault({ baseDirectory: temporaryDirectory });
  await vault.initialize();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

/** 真实工具执行上下文；`withGuard` 决定是否装配编辑意图守卫。 */
function buildExecutionContext(input: {
  withGuard: boolean;
}): Parameters<typeof executeBuiltinTool>[2] {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath,
    requestingAgentInstanceId: "worker:mission-s1:T-001:1",
    backupServicePort: vault,
    vault,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    taskExecutionId: "task-exec:T-001",
    ...(input.withGuard
      ? { agentEditIntentGuard: new AgentEditIntentGuard({ baseDirectory: temporaryDirectory }) }
      : {}),
  };
}

const targetRelativePath = "a.txt";
/** 工作区目录由 beforeEach 创建，故这里必须按需计算，不能在模块作用域求值。 */
function targetAbsolutePath(): string {
  return path.join(workspaceDirectory, targetRelativePath);
}

describe("E2E-01-03 S1：工具路径拒绝陈旧写入", () => {
  it("① 经 readFile 建立基线后人工修改 → replaceFileContent 被拒，人工字节不变", async () => {
    await fs.writeFile(targetAbsolutePath(), "初始内容\n", "utf8");
    const context = buildExecutionContext({ withGuard: true });

    // Agent 通过产品工具读取 → 记录读时基线。
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: targetRelativePath }),
      context,
    );

    // 人工在"已读、未写"窗口内修改同一文件。
    const humanContent = "人工修改（必须保留）\n";
    await fs.writeFile(targetAbsolutePath(), humanContent, "utf8");

    await expect(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({ filePath: targetRelativePath, content: "Agent 想写的内容\n" }),
        context,
      ),
    ).rejects.toThrow(/stale-human-change/);

    // 人工字节必须逐字节保留。
    await expect(fs.readFile(targetAbsolutePath(), "utf8")).resolves.toBe(humanContent);
  });

  it("② 无人工修改 → replaceFileContent 照常成功（不是无条件拒绝）", async () => {
    await fs.writeFile(targetAbsolutePath(), "初始内容\n", "utf8");
    const context = buildExecutionContext({ withGuard: true });
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: targetRelativePath }),
      context,
    );

    const result = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: targetRelativePath, content: "Agent 内容\n" }),
      context,
    );

    expect(result.isSideEffectFree).toBe(false);
    await expect(fs.readFile(targetAbsolutePath(), "utf8")).resolves.toBe("Agent 内容\n");
  });

  it("③ 未装配守卫 → 退回既有防护（证明拒绝来自本守卫，而非其它门禁）", async () => {
    await fs.writeFile(targetAbsolutePath(), "初始内容\n", "utf8");
    const context = buildExecutionContext({ withGuard: false });
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: targetRelativePath }),
      context,
    );
    await fs.writeFile(targetAbsolutePath(), "人工修改\n", "utf8");

    // 未装配时既有的 TOCTOU 复检在"备份之后"才取基线，因此这里会写入成功。
    const result = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: targetRelativePath, content: "Agent 内容\n" }),
      context,
    );

    expect(result.isSideEffectFree).toBe(false);
    await expect(fs.readFile(targetAbsolutePath(), "utf8")).resolves.toBe("Agent 内容\n");
  });

  it("④ 残余边界：盲覆盖（未读就写）不受人工基线保护——显式钉住，避免误以为已覆盖", async () => {
    await fs.writeFile(targetAbsolutePath(), "初始内容\n", "utf8");
    const context = buildExecutionContext({ withGuard: true });
    await fs.writeFile(targetAbsolutePath(), "人工修改\n", "utf8");

    const result = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: targetRelativePath, content: "Agent 内容\n" }),
      context,
    );

    expect(result.isSideEffectFree).toBe(false);
    await expect(fs.readFile(targetAbsolutePath(), "utf8")).resolves.toBe("Agent 内容\n");
  });

  it("⑤ 同一 Agent 读后连写两次：第二次不得被自己的写入误判为陈旧", async () => {
    await fs.writeFile(targetAbsolutePath(), "初始内容\n", "utf8");
    const context = buildExecutionContext({ withGuard: true });
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: targetRelativePath }),
      context,
    );

    await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: targetRelativePath, content: "第一版\n" }),
      context,
    );
    const secondResult = await executeBuiltinTool(
      "replaceFileContent",
      JSON.stringify({ filePath: targetRelativePath, content: "第二版\n" }),
      context,
    );

    expect(secondResult.isSideEffectFree).toBe(false);
    await expect(fs.readFile(targetAbsolutePath(), "utf8")).resolves.toBe("第二版\n");
  });
});
