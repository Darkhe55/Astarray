/**
 * 反例（作用域一次性授权必须在 allow-once 时**重新登记**）：
 * 工具被范围门禁拦下（`auth-scope-awaiting-user-authorization`）时，该操作指纹
 * 在下一次执行尝试中会被**消费**；用户 allow-once 后重跑同一操作即命中
 * `auth-scope-replay-rejected`（"该授权已被消费"），**内层工具从不执行**，
 * 任务只能停在 blocked（实测见 docs/reports/WRITE_PATH_BLOCKER_ROOT_CAUSE_2026-10-01.md）。
 *
 * 本文件在实现前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ScopeAuthorizationGate,
  ScopeGatedToolPort,
  describeToolOperation,
} from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

const CREATE_FILE_ARGUMENTS = JSON.stringify({
  filePath: "tasks/PROBE-001.md",
  content: "# 作用域授权探针\n",
});

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-scope-regrant-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5 });
});

function buildGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      { projectIdentifier: "probe-project", rootPath: projectRoot, registeredAtIso: "2026-10-01T00:00:00.000Z" },
    ],
    // 与生产同源（application-runtime）：assist 下写操作配置为 ask。
    getConfiguredDecision: () => "ask",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

function buildCountingInnerPort(counter: { count: number }): ToolPort {
  return {
    execute: async (toolName, _argumentsJson, callId): Promise<ToolCallResult> => {
      counter.count += 1;
      return {
        kind: "success",
        callId,
        outputText: `${toolName} 已执行`,
        isSideEffectFree: false,
      };
    },
  };
}

describe("作用域一次性授权的重新登记", () => {
  it("无授权 → 等待用户裁决且内层不执行", async () => {
    const gate = buildGate();
    const counter = { count: 0 };
    const gatedPort = new ScopeGatedToolPort(buildCountingInnerPort(counter), gate);

    const outcome = await gatedPort.execute(
      "createProjectFile",
      CREATE_FILE_ARGUMENTS,
      "call-1",
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.errorCode).toBe("auth-scope-awaiting-user-authorization");
    }
    expect(counter.count).toBe(0);
  });

  it("复现实测序列：被拒一次的授权已消费 → 重跑命中 replay-rejected（内层不执行）", async () => {
    const gate = buildGate();
    const counter = { count: 0 };
    const gatedPort = new ScopeGatedToolPort(buildCountingInnerPort(counter), gate);
    const operation = describeToolOperation("createProjectFile", CREATE_FILE_ARGUMENTS);
    expect(operation).not.toBeNull();

    // 用户授权（consumedAtIso=null），但**那次尝试**已把授权消费掉。
    await gate.grantUserAuthorization({
      operation: operation as NonNullable<typeof operation>,
      approvedByUserId: "probe-user",
    });
    const consumingOutcome = await gatedPort.execute(
      "createProjectFile",
      CREATE_FILE_ARGUMENTS,
      "call-consume",
      new AbortController().signal,
    );
    expect(consumingOutcome.kind).toBe("success");
    expect(counter.count).toBe(1);

    // 重跑同一操作指纹 → 实测错误（这正是写任务卡死的形态）。
    const rerunOutcome = await gatedPort.execute(
      "createProjectFile",
      CREATE_FILE_ARGUMENTS,
      "call-rerun",
      new AbortController().signal,
    );
    expect(rerunOutcome.kind).toBe("error");
    if (rerunOutcome.kind === "error") {
      expect(rerunOutcome.errorCode).toBe("auth-scope-replay-rejected");
    }
    expect(counter.count).toBe(1);
  });

  it("重新登记后重跑应执行一次；再同指纹重放仍被拒（不得放宽重放保护）", async () => {
    const gate = buildGate();
    const counter = { count: 0 };
    const gatedPort = new ScopeGatedToolPort(buildCountingInnerPort(counter), gate);
    const operation = describeToolOperation("createProjectFile", CREATE_FILE_ARGUMENTS);
    expect(operation).not.toBeNull();
    const typedOperation = operation as NonNullable<typeof operation>;

    // 第 1 次授权被"被拒那次"消费。
    await gate.grantUserAuthorization({ operation: typedOperation, approvedByUserId: "probe-user" });
    await gatedPort.execute("createProjectFile", CREATE_FILE_ARGUMENTS, "call-consume", new AbortController().signal);
    expect(counter.count).toBe(1);

    // allow-once 后**重新登记**（修复点）：重跑成为首次真实执行。
    await gate.grantUserAuthorization({ operation: typedOperation, approvedByUserId: "probe-user" });
    const rerunOutcome = await gatedPort.execute(
      "createProjectFile",
      CREATE_FILE_ARGUMENTS,
      "call-rerun",
      new AbortController().signal,
    );
    expect(rerunOutcome.kind).toBe("success");
    expect(counter.count).toBe(2);

    // 同一指纹再来一次 = 重放 → 必须被拒且不再执行。
    const replayOutcome = await gatedPort.execute(
      "createProjectFile",
      CREATE_FILE_ARGUMENTS,
      "call-replay",
      new AbortController().signal,
    );
    expect(replayOutcome.kind).toBe("error");
    if (replayOutcome.kind === "error") {
      expect(replayOutcome.errorCode).toBe("auth-scope-replay-rejected");
    }
    expect(counter.count).toBe(2);
  });
});
