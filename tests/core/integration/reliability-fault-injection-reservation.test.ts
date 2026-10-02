/**
 * 行为反例（RELIABILITY-01-02 · R5 故障注入：**执行中异常**时点，2026-10-02）：
 *
 * 卡内故障注入矩阵要求覆盖"执行中"时点：崩溃/断连后必须有明确结果与对账路径。
 *
 * 审计发现：`ScopeGatedToolPort.execute` 在 `innerToolPort.execute` **抛出异常**时
 * 不会走到结算分支 → 预留永远停在"在途"，此后同一逻辑操作的重试全部被
 * `operation-already-in-flight` 拒绝（永久毒化，且无对账路径）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScopeAuthorizationGate } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { describeToolOperation } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { ScopeGatedToolPort } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolPort } from "../../../packages/core/src/core/types.js";

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-inject-"));
});

afterEach(async () => {
  try {
    await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

function buildGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      {
        projectIdentifier: "probe-project",
        rootPath: projectRootPath,
        registeredAtIso: "2026-10-02T00:00:00.000Z",
      },
    ],
    getConfiguredDecision: () => "ask",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

describe("故障注入：执行中异常不得永久占用预留（R5）", () => {
  it("① 内层工具抛异常 → 重试必须仍可取得预留（不得 reserved-in-flight 永久占用）", async () => {
    const gate = buildGate();
    const relativePath = "docs/THROW.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# T\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    let callCount = 0;
    const throwingPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => {
        callCount += 1;
        if (callCount === 1) {
          // 模拟"执行中崩溃/断连"：异常向上抛（无结构化结果）。
          throw new Error("执行中崩溃（故障注入）");
        }
        return { kind: "success", callId, outputText: "已写入", isSideEffectFree: false };
      },
    } as ToolPort;

    const gatedPort = new ScopeGatedToolPort(throwingPort, gate);
    // 第一次：异常可以向上抛（调用方按未知结果处理）。
    await expect(
      gatedPort.execute("createProjectFile", argumentsJson, "call-1", new AbortController().signal),
    ).rejects.toThrow();

    /**
     * 第二次（同逻辑操作）：**不得**永久卡在"在途"。
     * 异常意味着结果未知 → 允许两种收敛结果，但都必须是**明确**的：
     *  a) 被判为待对账（`operation-settlement-unknown`）——副作用未知时禁止自动重放；
     *  b) 允许重试（`success`）——仅当实现能证明未执行。
     * 绝不允许再返回 `operation-already-in-flight`（那是永久毒化，且无对账路径）。
     */
    const retry = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    if (retry.kind === "error") {
      expect(retry.errorCode).not.toBe("operation-already-in-flight");
      expect(retry.errorCode).toBe("operation-settlement-unknown");
      return;
    }
    expect(retry.kind).toBe("success");
  });

  it("② 正常返回错误（结果未知）+ 无副作用 → 重试必须可执行（不得卡在在途）", async () => {
    const gate = buildGate();
    const relativePath = "docs/UNKNOWN.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# U\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    let callCount = 0;
    const failingPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            kind: "error",
            callId,
            errorCode: "tool-execution-failed",
            errorMessage: "执行失败（夹具）",
            isIdempotencyConfirmed: false,
            sideEffectStatus: "none",
          };
        }
        return { kind: "success", callId, outputText: "已写入", isSideEffectFree: false };
      },
    } as ToolPort;

    const gatedPort = new ScopeGatedToolPort(failingPort, gate);
    await gatedPort.execute("createProjectFile", argumentsJson, "call-1", new AbortController().signal);
    const retry = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    expect(retry.kind).toBe("success");
  });
});
