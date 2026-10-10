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

/**
 * 真实 CLI 装配下的范围门禁形态：项目内写操作由范围裁决直接 `allow`（协同模式本地判定），
 * 随后由**内层权限引擎**决定是否 ask。③ 必须用这个形态才能复现真实时序。
 */
function buildAllowingGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      {
        projectIdentifier: "probe-project",
        rootPath: projectRootPath,
        registeredAtIso: "2026-10-02T00:00:00.000Z",
      },
    ],
    getConfiguredDecision: () => "allow",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

function buildWritingInnerPort(): ToolPort {
  return {
    execute: async (_toolName, argumentsJson, callId) => {
      const parsed = JSON.parse(argumentsJson) as { filePath: string; content: string };
      const absolutePath = path.isAbsolute(parsed.filePath)
        ? parsed.filePath
        : path.join(projectRootPath, parsed.filePath);
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

  /**
   * ③ 2026-10-10 真实 CLI 端到端定位（`cli-anthropic-protocol` ① 的根因）：
   * 装配顺序是 `ScopeGatedToolPort(PolicyWrapper(...))`，即**范围门禁在外、权限裁决在内**。
   * 于是"第一次真实尝试"的时序是：范围门禁先**授权并消费**该操作，随后内层权限引擎判 `ask`、
   * 抛 `permission-ask-pending` ⇒ 工具**从未执行**。
   *
   * 旧行为：`settleReservation(released)` 只恢复"逻辑操作授权快照"（此处本就为空），
   * **范围记录仍停在已消费**，于是用户 `allow-once` 并重新登记后，重跑依然恒得
   * `auth-scope-replay-rejected`（实测 6 连拒 + 任务 blocked；请求序列
   * permission-ask-pending → replay-rejected × N）。
   *
   * 期望语义：无副作用被拒的那次不得烧掉范围授权；用户裁决后的重跑必须真正执行；
   * 成功之后同一逻辑操作再次调用仍必须被拒（重放保护不放宽）。
   */
  it("③ 范围门禁先消费、内层权限引擎再 ask：用户裁决后重跑必须能执行（不得 replay-rejected）", async () => {
    const gate = buildAllowingGate();
    const relativePath = "docs/OUTER-SCOPE-INNER-ASK.md";
    const fileContent = "# OSIA\n";
    // 目标路径用**绝对路径**：真实 CLI 以项目根为 cwd 运行，范围解析基于进程 cwd；
    // 测试进程的 cwd 是仓库根，故须显式给出项目内绝对路径才能落在已登记项目根内。
    const absoluteTargetPath = path.join(projectRootPath, relativePath);
    const argumentsJson = JSON.stringify({ filePath: absoluteTargetPath, content: fileContent });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    // 内层端口 = 权限引擎：第 1 次 ask（未执行、无副作用），之后放行真正写入。
    const writingInnerPort = buildWritingInnerPort();
    let isFirstAttempt = true;
    const askThenWritePort: ToolPort = {
      execute: async (toolName, argsJson, callId, signal) => {
        if (isFirstAttempt) {
          isFirstAttempt = false;
          return {
            kind: "error",
            callId,
            errorCode: "permission-ask-pending",
            errorMessage: "工具 createProjectFile 需要用户裁决",
            isIdempotencyConfirmed: true,
            sideEffectStatus: "none",
          };
        }
        return writingInnerPort.execute(toolName, argsJson, callId, signal);
      },
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(askThenWritePort, gate);

    // 第 1 次尝试：范围门禁授权并消费；内层 ask ⇒ 返回被拒（内层工具未执行）。
    const refused = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-ask",
      new AbortController().signal,
    );
    expect(refused.kind).toBe("error");
    if (refused.kind === "error") {
      expect(refused.errorCode).toBe("permission-ask-pending");
    }

    // 用户 `allow-once` → 重新登记作用域授权（CLI 现有接线：grantUserAuthorization）。
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    // 重跑：必须真正执行并落盘（旧行为在此恒得 auth-scope-replay-rejected）。
    const rerun = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-rerun",
      new AbortController().signal,
    );
    expect(rerun.kind).toBe("success");
    expect(existsSync(path.join(projectRootPath, relativePath))).toBe(true);

    // 重放保护不放宽：同一逻辑操作（同参数）再次调用仍必须被拒。
    const replay = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-replay",
      new AbortController().signal,
    );
    expect(replay.kind).toBe("error");
    if (replay.kind === "error") {
      expect(replay.errorCode).toBe("auth-scope-replay-rejected");
    }
  });

  /**
   * ④ 同③但**不重新登记**：一次错误授权不得被"无副作用被拒"行为扩大为可用授权。
   * 没有用户裁决时，重跑必须仍是 fail-closed 的"等待用户授权"，绝不放行执行。
   */
  it("④ 无用户重新登记时：被拒一次后重跑仍必须 fail-closed（不得放行、不得变 replay-rejected）", async () => {
    const gate = buildGate();
    const relativePath = "docs/NO-REGRANT.md";
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# NR\n" });
    const operation = describeToolOperation("createProjectFile", argumentsJson);
    expect(operation).not.toBeNull();

    const countingInnerPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId) => ({
        kind: "error",
        callId,
        errorCode: "permission-ask-pending",
        errorMessage: "需要用户裁决",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      }),
    } as ToolPort;
    const gatedPort = new ScopeGatedToolPort(countingInnerPort, gate);

    const first = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-1",
      new AbortController().signal,
    );
    expect(first.kind).toBe("error");
    if (first.kind === "error") {
      expect(first.errorCode).toBe("auth-scope-awaiting-user-authorization");
    }
    const second = await gatedPort.execute(
      "createProjectFile",
      argumentsJson,
      "call-2",
      new AbortController().signal,
    );
    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      // 未获用户裁决 → 仍须等待用户授权（既不执行，也不得退化成"已消费的重放"误导文案）。
      expect(second.errorCode).toBe("auth-scope-awaiting-user-authorization");
    }
  });
});
