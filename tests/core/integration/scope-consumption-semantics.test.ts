/**
 * 反例（作用域记录与逻辑预留的消费语义收敛，2026-10-02）：
 *
 * 目标语义：
 *  - **被拒绝/未执行的尝试不得消费一次性授权**：用户 `allow-once` 之后，
 *    "首次执行因无副作用失败 → 重试成功"必须能走通（不得命中 `auth-scope-replay-rejected`）；
 *  - **成功执行后同一逻辑操作再次调用仍必须被拒**（重放保护不放宽）；
 *  - **结果未知/待对账不得自动释放**（必须进入对账）；
 *  - 并发同一逻辑操作只允许一个持有预留。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScopeAuthorizationGate } from "../../../packages/core/src/tools/scope-authorization-gate.js";
import { describeToolOperation } from "../../../packages/core/src/tools/scope-authorization-gate.js";

let projectRootPath: string;

beforeEach(async () => {
  projectRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-scope-consume-"));
});

afterEach(async () => {
  await fs.rm(projectRootPath, { recursive: true, force: true, maxRetries: 5 });
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

function operationFor(relativePath: string) {
  const operation = describeToolOperation(
    "createProjectFile",
    JSON.stringify({ filePath: relativePath, content: "# A\n" }),
  );
  if (operation === null) {
    throw new Error("测试前提失败：createProjectFile 不受范围门禁约束");
  }
  return operation;
}

describe("作用域一次性授权 × 逻辑预留：消费语义", () => {
  it("① 一次 allow-once 后：首次无副作用失败 → 重试必须能执行（不得 replay-rejected）", async () => {
    const gate = buildGate();
    const relativePath = "PROBE-RETRY.md";
    const operation = operationFor(relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# A\n" });
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
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
    expect(retry.errorCode).not.toBe("auth-scope-replay-rejected");
  });

  it("② 成功结算后同一逻辑操作再次调用 → 必须仍被拒（重放保护不放宽）", async () => {
    const gate = buildGate();
    const relativePath = "PROBE-REPLAY.md";
    const operation = operationFor(relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# A\n" });
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    const first = await gate.reserveForExecution({ operation, argumentsJson });
    await gate.settleReservation({
      reservationIdentifier: first.reservationIdentifier ?? "",
      outcome: { kind: "success" },
    });

    const replay = await gate.reserveForExecution({ operation, argumentsJson });
    expect(replay.status).toBe("replay-rejected");
    expect(replay.errorCode).toBe("auth-scope-replay-rejected");
  });

  it("③ 结果未知 → 进入对账，且不得自动放行", async () => {
    const gate = buildGate();
    const relativePath = "PROBE-UNKNOWN.md";
    const operation = operationFor(relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# A\n" });
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    const first = await gate.reserveForExecution({ operation, argumentsJson });
    const settled = await gate.settleReservation({
      reservationIdentifier: first.reservationIdentifier ?? "",
      outcome: { kind: "error", sideEffectStatus: "unknown" },
    });
    expect(settled.status).toBe("requires-reconciliation");

    const again = await gate.reserveForExecution({ operation, argumentsJson });
    expect(again.status).toBe("requires-reconciliation");
  });

  it("④ 并发同一逻辑操作：只允许一个持有预留", async () => {
    const gate = buildGate();
    const relativePath = "PROBE-CONCURRENT.md";
    const operation = operationFor(relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# A\n" });
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
    });

    const [first, second] = await Promise.all([
      gate.reserveForExecution({ operation, argumentsJson }),
      gate.reserveForExecution({ operation, argumentsJson }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["reserved", "reserved-in-flight"]);
  });

  it("⑤ 用户重新授权（同参数）→ 必须能再次执行（不得残留已消费状态）", async () => {
    const gate = buildGate();
    const relativePath = "PROBE-REGRANT.md";
    const operation = operationFor(relativePath);
    const argumentsJson = JSON.stringify({ filePath: relativePath, content: "# A\n" });
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
    });
    const first = await gate.reserveForExecution({ operation, argumentsJson });
    await gate.settleReservation({
      reservationIdentifier: first.reservationIdentifier ?? "",
      outcome: { kind: "success" },
    });
    // 成功后再授权（用户明确再批一次）→ 视为新的一次执行。
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "probe-user",
      argumentsJson,
    });
    const afterRegrant = await gate.reserveForExecution({ operation, argumentsJson });
    expect(afterRegrant.status).toBe("reserved");
  });
});
