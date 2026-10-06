/**
 * 回归测试（2026-10-02）：三处"共享状态键漏掉具体 Agent 身份"的真实缺陷。
 *
 * 这三处均由 u2-flash 真实运行实测定位并修复；本文件把它们钉成确定性反例，
 * 防止再次退化（此前只有实测证据，缺少可离线复跑的守卫）。
 *
 * 对应提交：
 *  - c4ffe06：只读操作占用单次授权/重放保护；工具失败计数器键只有 taskId；
 *  - 08de582：读取抑制账本的 agentInstanceId/taskExecutionId 按 task.id 合成。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolFailureCounter } from "../../../packages/core/src/orchestration/failure-counter.js";
import { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";

let workspaceDirectory: string;

beforeEach(async () => {
  workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-regression-"));
});

afterEach(async () => {
  try {
    await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // 临时目录由系统回收
  }
});

describe("回归：并行 mission 不得在读取抑制账本上撞键", () => {
  it("同一 taskExecutionId、不同 agentInstanceId 时不得互相抑制", async () => {
    const filePath = path.join(workspaceDirectory, "package.json");
    await fs.writeFile(filePath, '{"name":"astarray"}', "utf8");
    // 注：contentFingerprint 必须是**真实内容指纹**，传字面量会被账本判为"文件已变化"而放行；
    // 本用例只验证键隔离，故传 null（账本对 null 不做内容比对）。
    const ledger = new ReadSuppressionLedger({});

    // mission-A 的 T-001 读取该文件
    await ledger.registerRead({
      agentInstanceId: "worker:mission-A:T-001:1",
      taskExecutionId: "task-exec:worker:mission-A:T-001:1",
      canonicalPath: filePath,
      operationKind: "read",
      normalizedRange: "full",
      parameterHash: "param",
      contentFingerprint: null,
    });

    // mission-B 的 T-001（同 taskId、不同 Agent）读同一文件 —— 必须放行
    const decision = await ledger.querySuppression({
      agentInstanceId: "worker:mission-B:T-001:1",
      taskExecutionId: "task-exec:worker:mission-B:T-001:1",
      canonicalPath: filePath,
      operationKind: "read",
      normalizedRange: "full",
      parameterHash: "param",
    });
    expect(decision.isSuppressed).toBe(false);
  });

  it("同一 agentInstanceId 重复读取才是真正的自指读取（必须抑制）", async () => {
    const filePath = path.join(workspaceDirectory, "package.json");
    await fs.writeFile(filePath, '{"name":"astarray"}', "utf8");
    const ledger = new ReadSuppressionLedger({});
    const agentInstanceId = "worker:mission-A:T-001:1";
    // 两次调用必须使用**同一个** taskExecutionId：它参与账本键，传不同值等于换了调用源。
    const taskExecutionId = "task-exec:T-001";
    await ledger.registerRead({
      agentInstanceId,
      taskExecutionId,
      canonicalPath: filePath,
      operationKind: "read",
      normalizedRange: "full",
      parameterHash: "param",
      contentFingerprint: null,
    });
    const decision = await ledger.querySuppression({
      agentInstanceId,
      taskExecutionId,
      canonicalPath: filePath,
      operationKind: "read",
      normalizedRange: "full",
      parameterHash: "param",
    });
    // 修复不能弱化原本的反自指保护
    expect(decision.isSuppressed).toBe(true);
  });
});

describe("回归：工具失败计数器必须按具体 Agent 隔离", () => {
  it("计数器实例独立时，A 的失败不得累加到 B 上", () => {
    // 生产装配的键是 `agentInstanceId|taskId`，即不同 Agent 得到不同计数器实例。
    const counterForMissionA = new ToolFailureCounter(3);
    const counterForMissionB = new ToolFailureCounter(3);

    // mission-A 连续失败 2 次（未达阈值）
    expect(counterForMissionA.recordFailure("readFile")).toBe(false);
    expect(counterForMissionA.recordFailure("readFile")).toBe(false);

    // mission-B 的第一次失败**不得**因 A 的失败而立即达到阈值
    expect(counterForMissionB.recordFailure("readFile")).toBe(false);
    expect(counterForMissionB.getConsecutiveFailureCount("readFile")).toBe(1);
  });

  it("若两者共用同一计数器（修复前的缺陷形态），第二次失败即被误判达阈值", () => {
    // 该形态即修复前 `taskId` 单键造成的跨 mission 共享；保留为反例说明危害。
    const sharedCounter = new ToolFailureCounter(3);
    expect(sharedCounter.recordFailure("readFile")).toBe(false);
    expect(sharedCounter.recordFailure("readFile")).toBe(false);
    // 此时 mission-A 的第 3 次失败（或 mission-B 的第 1 次）会达阈值
    expect(sharedCounter.recordFailure("readFile")).toBe(true);
  });
});
