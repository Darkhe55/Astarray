/**
 * 反例（"权限门禁拦截 = 确定无副作用"，2026-10-02 正向闭环阻断项）：
 *
 * 语义：工具调用**被权限门禁拦下**（`permission-ask-pending` / 被拒绝）时，
 * 该逻辑操作**未执行、无副作用**，因此：
 *  - 不得把预留结算为"待对账"（否则永久毒化重试）；
 *  - 用户 `allow-once` 之后的重跑必须能够真正执行（产物落盘、任务 done）。
 *
 * 本文件在修复前必须失败。
 */
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScopeAuthorizationGate } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { describeToolOperation } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { ScopeGatedToolPort } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolPort } from "../../../packages/core/src/core/types.js";

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-refusal-"));
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

function buildWritingInnerPort(): ToolPort {
  return {
    execute: async (_toolName, argumentsJson, callId) => {
      const parsed = JSON.parse(argumentsJson) as { filePath: string; content: string };
      const absolutePath = path.join(projectRootPath, parsed.filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, parsed.content, "utf8");
      return { kind: "success", callId, outputText: "已写入", isSideEffectFree: false };
    },
  } as ToolPort;
}

describe("权限门禁拦截 = 确定无副作用（不得毒化重试）", () => {
  it("① 权限询问拦截的调用，其结算不得是 requires-reconciliation", async () => {
    const gate = buildGate();
    const relativePath = "docs/REFUSAL.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# R\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    // 用户先授权（模拟 allow-once 之后的重跑场景）。
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    // 内层端口返回"被权限门禁拦下"的结果（未执行、无副作用）。
    const refusingInnerPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => ({
        kind: "error",
        callId,
        errorCode: "permission-ask-pending",
        errorMessage: "工具需要用户裁决",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      }),
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(refusingInnerPort, gate);
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-refused",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");

    // 关键：拒绝不得毒化该操作——重跑必须仍能取得预留并执行。
    const rerun = await gate.reserveForExecution({
      operation: operation as NonNullable<typeof operation>,
      argumentsJson,
    });
    expect(rerun.status).toBe("reserved");
    expect(rerun.errorCode).not.toBe("operation-settlement-unknown");
  });

  it("② 拦截后重跑：工具必须真正执行并产出文件", async () => {
    const gate = buildGate();
    const relativePath = "docs/RERUN.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# RR\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    const innerPort = buildWritingInnerPort();
    let isFirstCall = true;
    const refusingThenWritingPort: ToolPort = {
      execute: async (toolName, argsJson, callId, signal) => {
        if (isFirstCall) {
          isFirstCall = false;
          return {
            kind: "error",
            callId,
            errorCode: "permission-ask-pending",
            errorMessage: "工具需要用户裁决",
            isIdempotencyConfirmed: true,
            sideEffectStatus: "none",
          };
        }
        return innerPort.execute(toolName, argsJson, callId, signal);
      },
    } as ToolPort;

    const gatedPort = new ScopeGatedToolPort(refusingThenWritingPort, gate);
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-1",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");

    // 重跑（用户已授权）：必须成功落盘。
    const rerun = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    expect(rerun.kind).toBe("success");
    expect(existsSync(path.join(projectRootPath, relativePath))).toBe(true);
  });

});
