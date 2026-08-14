/**
 * T07B 单测：反自指读取与通用活锁守卫（ADR-0017）。
 * 覆盖：重复读取时间锁（fake clock）、文件变化重读、路径别名/大小写/链接/
 * 硬链接旁路、不同 Agent 隔离、敏感优先、single-flight、环检测、无进展暂停、
 * 深度/扇出/节点上限、任务预算持久化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { SensitiveContentAccessPolicy } from "../../../packages/core/src/tools/sensitive-content-access-policy.js";
import {
  ReadSuppressionLedger,
  buildReadSuppressionDenial,
} from "../../../packages/core/src/tools/read-suppression-ledger.js";
import {
  LocalProgressAndCycleGuard,
  buildOutcomeSignature,
} from "../../../packages/core/src/tools/local-progress-and-cycle-guard.js";
import { DomainError } from "../../../packages/core/src/core/errors.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let clockMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07b-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  clockMilliseconds = 1_000_000;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function fakeClock(): number {
  return clockMilliseconds;
}

function advanceClock(milliseconds: number): void {
  clockMilliseconds += milliseconds;
}

function buildReadContext(overrides: Record<string, unknown> = {}) {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "agent-a",
    taskExecutionId: "task-1",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    sensitiveContentAccessPolicy: new SensitiveContentAccessPolicy(),
    readSuppressionLedger: new ReadSuppressionLedger({
      nowUnixMilliseconds: fakeClock,
    }),
    ...overrides,
  };
}

describe("ReadSuppressionLedger（重复读取时间锁）", () => {
  it("窗口内同源重复读取同一文件 → resource-already-read，含回执与重试间隔", async () => {
    const filePath = path.join(workspaceDirectory, "a.txt");
    await fs.writeFile(filePath, "v1", "utf8");
    const context = buildReadContext();
    const first = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      context,
    );
    expect(first.outputText).toBe("v1");
    const second = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      context,
    ).catch((error: unknown) => error as DomainError);
    expect(second).toBeInstanceOf(DomainError);
    expect((second as DomainError).errorCode).toBe("resource-already-read");
    const payload = JSON.parse((second as DomainError).message) as {
      readReceiptId: string;
      firstReadAtUnixMilliseconds: number;
      retryAfterMilliseconds: number;
    };
    expect(payload.readReceiptId).toMatch(/^receipt-/);
    expect(payload.firstReadAtUnixMilliseconds).toBe(1_000_000);
    expect(payload.retryAfterMilliseconds).toBeGreaterThan(0);
    expect(payload.retryAfterMilliseconds).toBeLessThanOrEqual(30_000);
  });

  it("30 秒后（或文件真实变化后）可重读", async () => {
    const filePath = path.join(workspaceDirectory, "a.txt");
    await fs.writeFile(filePath, "v1", "utf8");
    const context = buildReadContext();
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      context,
    );
    // 窗口内仍抑制
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "a.txt" }),
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "resource-already-read" });
    // 推进时钟超过窗口 → 可重读
    advanceClock(31_000);
    const afterWindow = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      context,
    );
    expect(afterWindow.outputText).toBe("v1");
    // 文件真实变化 → 立即重读
    await fs.writeFile(filePath, "v2", "utf8");
    const afterChange = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      context,
    );
    expect(afterChange.outputText).toBe("v2");
  });

  it("相对/绝对路径别名、大小写变体不能绕过时间锁", async () => {
    const filePath = path.join(workspaceDirectory, "DATA.TXT");
    await fs.writeFile(filePath, "内容", "utf8");
    const context = buildReadContext();
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "DATA.TXT" }),
      context,
    );
    // 相对路径 + 大小写变体
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: "./data.txt" }),
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "resource-already-read" });
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: filePath }),
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "resource-already-read" });
  });

  it("不同 Agent/任务读取同一文件互不误伤", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "a.txt"), "v1", "utf8");
    const contextA = buildReadContext({ requestingAgentInstanceId: "agent-a" });
    const contextB = buildReadContext({ requestingAgentInstanceId: "agent-b" });
    await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      contextA,
    );
    const forAgentB = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      contextB,
    );
    expect(forAgentB.outputText).toBe("v1");
  });

  it("敏感文件禁读优先于时间锁（不登记）", async () => {
    const filePath = path.join(workspaceDirectory, ".env");
    await fs.writeFile(filePath, "TOKEN=x", "utf8");
    const context = buildReadContext();
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: ".env" }),
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    // 重复请求仍是敏感拒绝（不是 resource-already-read）
    await expect(
      executeBuiltinTool(
        "readFile",
        JSON.stringify({ filePath: ".env" }),
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
  });

  it("buildReadSuppressionDenial 返回结构化拒绝", () => {
    const error = buildReadSuppressionDenial({
      readReceiptId: "receipt-abc",
      firstReadAtUnixMilliseconds: 123,
      retryAfterMilliseconds: 900,
    });
    expect(error.errorCode).toBe("resource-already-read");
    expect(JSON.parse(error.message)).toMatchObject({
      errorCode: "resource-already-read",
      readReceiptId: "receipt-abc",
      retryAfterMilliseconds: 900,
    });
  });
});

describe("LocalProgressAndCycleGuard", () => {
  it("直接自环 A→A 触发 self-loop", async () => {
    const guard = new LocalProgressAndCycleGuard();
    const violation = await guard.recordCallAndDetectViolation({
      callerKey: "A",
      calleeKey: "A",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(violation?.kind).toBe("self-loop");
    expect(violation?.cycleChain).toEqual(["A"]);
  });

  it("A→B→A 资源环触发 resource-cycle 并报告完整链", async () => {
    const guard = new LocalProgressAndCycleGuard();
    const first = await guard.recordCallAndDetectViolation({
      callerKey: "A",
      calleeKey: "B",
      nodeKind: "resource",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(first).toBeNull();
    guard.pushCallFrame("A");
    guard.pushCallFrame("B");
    const violation = await guard.recordCallAndDetectViolation({
      callerKey: "B",
      calleeKey: "A",
      nodeKind: "resource",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(violation?.kind).toBe("resource-cycle");
    expect(violation?.cycleChain).toEqual(["A", "B", "A"]);
  });

  it("连续 3 次无进展暂停路径；有进展时重置", async () => {
    const guard = new LocalProgressAndCycleGuard({
      consecutiveNoProgressLimit: 3,
    });
    const signature = buildOutcomeSignature(["相同结果"]);
    for (let index = 0; index < 2; index++) {
      const violation = await guard.recordCallAndDetectViolation({
        callerKey: "A",
        calleeKey: "B",
        nodeKind: "tool",
        taskExecutionId: null,
        outcomeSignature: signature,
        isNewProgress: false,
      });
      expect(violation).toBeNull();
    }
    const violation = await guard.recordCallAndDetectViolation({
      callerKey: "A",
      calleeKey: "B",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: signature,
      isNewProgress: false,
    });
    expect(violation?.kind).toBe("no-progress-limit");
  });

  it("深度/节点数/扇出上限触发对应守卫", async () => {
    const depthGuard = new LocalProgressAndCycleGuard({ maxCallDepth: 3 });
    for (let index = 0; index < 3; index++) {
      depthGuard.pushCallFrame(`frame-${index}`);
    }
    const depthViolation = await depthGuard.recordCallAndDetectViolation({
      callerKey: "x",
      calleeKey: "y",
      nodeKind: "tool",
      taskExecutionId: null,
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(depthViolation?.kind).toBe("call-depth-limit");

    const fanoutGuard = new LocalProgressAndCycleGuard({ maxFanout: 3 });
    for (const callee of ["b1", "b2", "b3", "b4"]) {
      const violation = await fanoutGuard.recordCallAndDetectViolation({
        callerKey: "hub",
        calleeKey: callee,
        nodeKind: "tool",
        taskExecutionId: null,
        outcomeSignature: null,
        isNewProgress: false,
      });
      if (callee === "b4") {
        expect(violation?.kind).toBe("fanout-limit");
      } else {
        expect(violation).toBeNull();
      }
    }
  });

  it("single-flight：相同在途调用合并", async () => {
    const guard = new LocalProgressAndCycleGuard();
    expect(guard.tryAcquireInFlightCall("read:a.txt")).toBe(false);
    expect(guard.tryAcquireInFlightCall("read:a.txt")).toBe(true);
    expect(guard.getInFlightCallCount()).toBe(1);
    guard.completeInFlightCall("read:a.txt");
    expect(guard.getInFlightCallCount()).toBe(0);
    expect(guard.tryAcquireInFlightCall("read:a.txt")).toBe(false);
  });

  it("任务总调用预算持久化（重启不清零）", async () => {
    const budgetByTask = new Map<string, number>();
    const guard = new LocalProgressAndCycleGuard({
      taskTotalCallBudget: 3,
      readTaskBudget: (taskExecutionId) => budgetByTask.get(taskExecutionId) ?? 0,
      writeTaskBudget: (taskExecutionId, count) => {
        budgetByTask.set(taskExecutionId, count);
      },
    });
    for (let index = 0; index < 3; index++) {
      const violation = await guard.recordCallAndDetectViolation({
        callerKey: "A",
        calleeKey: `call-${index}`,
        nodeKind: "tool",
        taskExecutionId: "task-9",
        outcomeSignature: null,
        isNewProgress: false,
      });
      expect(violation).toBeNull();
    }
    // 新 guard 实例（模拟进程重启）读取同一持久化预算
    const restartedGuard = new LocalProgressAndCycleGuard({
      taskTotalCallBudget: 3,
      readTaskBudget: (taskExecutionId) => budgetByTask.get(taskExecutionId) ?? 0,
      writeTaskBudget: (taskExecutionId, count) => {
        budgetByTask.set(taskExecutionId, count);
      },
    });
    const violation = await restartedGuard.recordCallAndDetectViolation({
      callerKey: "A",
      calleeKey: "call-4",
      nodeKind: "tool",
      taskExecutionId: "task-9",
      outcomeSignature: null,
      isNewProgress: false,
    });
    expect(violation?.kind).toBe("task-budget-exceeded");
  });

  it("buildOutcomeSignature 规范化相同结果签名", () => {
    const signatureA = buildOutcomeSignature(["结果", "错误码"]);
    const signatureB = buildOutcomeSignature(["结果", "错误码"]);
    expect(signatureA).toBe(signatureB);
    expect(signatureA).not.toBe(buildOutcomeSignature(["结果", "不同错误"]));
    expect(buildOutcomeSignature([null, ""])).toBeNull();
  });
});

describe("builtins 接入（T07B 端到端）", () => {
  it("readFile 重复读取返回 resource-already-read 且不返回正文", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "doc.txt"), "正文内容", "utf8");
    const context = buildReadContext();
    const first = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "doc.txt" }),
      context,
    );
    expect(first.outputText).toBe("正文内容");
    const second = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "doc.txt" }),
      context,
    ).catch((error: unknown) => error as DomainError);
    expect((second as DomainError).errorCode).toBe("resource-already-read");
    expect((second as DomainError).message).not.toContain("正文内容");
  });

  it("未装配账本时行为不变（不抑制）", async () => {
    await fs.writeFile(path.join(workspaceDirectory, "doc.txt"), "x", "utf8");
    const context = buildReadContext({ readSuppressionLedger: null });
    const first = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "doc.txt" }),
      context,
    );
    const second = await executeBuiltinTool(
      "readFile",
      JSON.stringify({ filePath: "doc.txt" }),
      context,
    );
    expect(first.outputText).toBe("x");
    expect(second.outputText).toBe("x");
  });
});
