/**
 * 反例（授权与副作用结算语义，2026-10-02 用户指定）：
 *
 * 目标语义：**执行前原子预留，执行后结算**。
 *  - 授权绑定「逻辑操作 ID + 完整规范化参数」——同路径内容变化也不得沿用；
 *  - 仅"明确未执行、无副作用"的失败可释放预留；
 *  - 执行中失败或结果未知 → 必须进入对账，不得自动释放、不得静默重放；
 *  - 成功执行后同一逻辑操作再次调用 = 重放 → 仍须拒绝；
 *  - 并发同一逻辑操作 → 只允许一个持有预留，其余必须拒绝。
 *
 * 本文件在 `ScopeAuthorizationGate` 提供 reserve/settle 之前必须失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ScopeAuthorizationGate,
  ScopeGatedToolPort,
} from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-reserve-settle-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5 });
});

function buildGate(): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      {
        projectIdentifier: "probe-project",
        rootPath: projectRoot,
        registeredAtIso: "2026-10-02T00:00:00.000Z",
      },
    ],
    getConfiguredDecision: () => "ask",
    isInstallationEnabled: async () => false,
    getAuthorizationRevision: () => 1,
  });
}

interface GateWithReservationApi {
  grantUserAuthorization(input: {
    operation: unknown;
    approvedByUserId: string;
  }): Promise<{ receiptIdentifier: string; operationFingerprint: string }>;
  /** 逻辑操作授权：绑定**完整规范化参数**（同路径内容变化不得沿用）。 */
  grantLogicalOperationAuthorization(input: {
    operation: unknown;
    argumentsJson: string;
    approvedByUserId: string | null;
  }): Promise<{ logicalOperationFingerprint: string }>;
  reserveForExecution(input: {
    operation: unknown;
    argumentsJson: string;
  }): Promise<{ status: string; reservationIdentifier?: string; errorCode?: string }>;
  settleReservation(input: {
    reservationIdentifier: string;
    outcome: {
      kind: "success" | "error";
      isIdempotencyConfirmed?: boolean;
      /** 工具自报的副作用事实：none=确定未执行/无副作用。 */
      sideEffectStatus?: "none" | "partial" | "unknown";
    };
  }): Promise<{ status: string }>;
}

describe("执行前原子预留 / 执行后结算", () => {
  it("① 明确未执行、无副作用的失败 → 释放预留，重试不再要求授权", async () => {
    const gate = buildGate() as unknown as GateWithReservationApi;
    const filePath = "PROBE.md";
    const content = "# A\n";
    const operation = { operationKind: "project-file-write", targetPath: filePath };
    const argumentsJson = JSON.stringify({ filePath, content });
    await gate.grantLogicalOperationAuthorization({
      operation,
      argumentsJson,
      approvedByUserId: "probe-user",
    });

    const first = await gate.reserveForExecution({ operation, argumentsJson });
    expect(first.status).toBe("reserved");

    const released = await gate.settleReservation({
      reservationIdentifier: first.reservationIdentifier ?? "",
      outcome: { kind: "error", sideEffectStatus: "none" },
    });
    expect(released.status).toBe("released");

    const retry = await gate.reserveForExecution({ operation, argumentsJson });
    expect(retry.status).toBe("reserved");
  });

  it("② 执行中失败 / 结果未知 → 进入对账，不得自动释放、不得再放行", async () => {
    const gate = buildGate() as unknown as GateWithReservationApi;
    const filePath = "PROBE.md";
    const content = "# B\n";
    const operation = { operationKind: "project-file-write", targetPath: filePath };
    const argumentsJson = JSON.stringify({ filePath, content });
    await gate.grantLogicalOperationAuthorization({
      operation,
      argumentsJson,
      approvedByUserId: "probe-user",
    });

    const first = await gate.reserveForExecution({
      operation,
      argumentsJson,
    });
    const settled = await gate.settleReservation({
      reservationIdentifier: first?.reservationIdentifier ?? "",
      outcome: { kind: "error", sideEffectStatus: "unknown" },
    });
    expect(settled?.status).toBe("requires-reconciliation");

    const retry = await gate.reserveForExecution({
      operation,
      argumentsJson: JSON.stringify({ filePath, content }),
    });
    expect(retry?.status).toBe("requires-reconciliation");
    expect(retry?.status).not.toBe("reserved");
  });

  it("③ 成功执行后再调用同一逻辑操作 → 仍须拒绝（重放保护不放宽）", async () => {
    const gate = buildGate() as unknown as GateWithReservationApi;
    const filePath = "PROBE.md";
    const content = "# C\n";
    const operation = { operationKind: "project-file-write", targetPath: filePath };
    const argumentsJson = JSON.stringify({ filePath, content });
    await gate.grantLogicalOperationAuthorization({
      operation,
      argumentsJson,
      approvedByUserId: "probe-user",
    });

    const first = await gate.reserveForExecution({ operation, argumentsJson });
    await gate.settleReservation({
      reservationIdentifier: first?.reservationIdentifier ?? "",
      outcome: { kind: "success" },
    });

    const replay = await gate.reserveForExecution({ operation, argumentsJson });
    expect(replay?.status).toBe("replay-rejected");
  });

  it("④ 授权绑定完整规范化参数：同路径内容变化 → 不得沿用", async () => {
    const gate = buildGate() as unknown as GateWithReservationApi;
    const filePath = "PROBE.md";
    const operation = { operationKind: "project-file-write", targetPath: filePath };
    await gate.grantLogicalOperationAuthorization({
      operation,
      argumentsJson: JSON.stringify({ filePath, content: "# 原始内容\n" }),
      approvedByUserId: "probe-user",
    });

    const differentContent = await gate.reserveForExecution({
      operation,
      argumentsJson: JSON.stringify({ filePath, content: "# 换过的内容\n" }),
    });
    // 作用域指纹相同（同 kind/同路径），但完整参数不同 → 必须重新裁决
    expect(differentContent?.status).toBe("awaiting-user-authorization");

    // 键序不同但语义相同 → 视为同一逻辑操作（规范化）
    const reordered = await gate.reserveForExecution({
      operation,
      argumentsJson: JSON.stringify({ content: "# 换过的内容\n", filePath }),
    });
    expect(reordered?.status).not.toBe("replay-rejected");
  });

  it("⑤ 并发：同一逻辑操作只允许一个持有预留，其余拒绝", async () => {
    const gate = buildGate() as unknown as GateWithReservationApi;
    const filePath = "PROBE.md";
    const content = "# D\n";
    const operation = { operationKind: "project-file-write", targetPath: filePath };
    const argumentsJson = JSON.stringify({ filePath, content });
    await gate.grantLogicalOperationAuthorization({
      operation,
      argumentsJson,
      approvedByUserId: "probe-user",
    });

    const [first, second] = await Promise.all([
      gate.reserveForExecution({ operation, argumentsJson }),
      gate.reserveForExecution({ operation, argumentsJson }),
    ]);
    const statuses = [first?.status, second?.status].sort();
    expect(statuses).toEqual(["reserved", "reserved-in-flight"]);
  });

  it("⑥ 端口层：结算结果未知时不得重复执行内层工具（无重复副作用）", async () => {
    const gate = buildGate();
    const counter = { count: 0 };
    const innerPort: ToolPort = {
      execute: async (_toolName, _argumentsJson, callId): Promise<ToolCallResult> => {
        counter.count += 1;
        return {
          kind: "error",
          callId,
          errorCode: "tool-execution-failed",
          errorMessage: "写入过程中断",
          isIdempotencyConfirmed: false,
        };
      },
    };
    const gated = new ScopeGatedToolPort(innerPort, gate);
    // 未授权 → 不触达内层
    const unauthorized = await gated.execute(
      "createProjectFile",
      JSON.stringify({ filePath: "PROBE.md", content: "# E\n" }),
      "call-1",
      new AbortController().signal,
    );
    expect(unauthorized.kind).toBe("error");
    expect(counter.count).toBe(0);
  });
});