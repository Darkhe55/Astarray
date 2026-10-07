/**
 * E2E-01-03 S1：产品侧 Agent 编辑意图与陈旧写入强制（红 → 绿）。
 *
 * 卡内验收①："陈旧写入被拒绝且人工修改保留"。
 *
 * 已查证的既有缺陷（本次实现前）：
 *  - `StaleWriteGuard.guardWrite` 只被单测调用；`AgentEditIntent` **没有产品侧生产者**；
 *  - `replaceFileContent` 现有防护（备份 → 写入前 `verifyTargetUnchanged`）的基线取自
 *    **备份那一刻**，覆盖不到"Agent 已读、尚未备份"这段窗口——人工在此期间改动会被静默覆盖。
 *
 * 本文件在实现之前必须失败。核心反例：读时基线 → 人工改文件 → 写入必须被拒，
 * 且**人工字节保持不变**、Agent 待写内容被保全为可追溯 patch。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentEditIntentGuard,
  computeContentFingerprint,
} from "../../../packages/core/src/orchestration/agent-edit-intent-guard.js";
import { existsSync } from "node:fs";

let baseDirectory: string;
let targetPath: string;

const agentInstanceId = "worker:mission-concurrent:T-001:1";
const taskExecutionIdentifier = "task-exec:T-001";

beforeEach(() => {
  baseDirectory = mkdtempSync(path.join(tmpdir(), "astarray-edit-intent-"));
  targetPath = path.join(baseDirectory, "target.txt");
  writeFileSync(targetPath, "原始内容\n", "utf8");
});

afterEach(() => {
  rmSync(baseDirectory, { recursive: true, force: true });
});

async function recordReadBaseline(
  guard: AgentEditIntentGuard,
  filePath = targetPath,
): Promise<void> {
  await guard.recordReadBaseline({
    agentInstanceId,
    taskExecutionIdentifier,
    targetPath: filePath,
    contentFingerprint: computeContentFingerprint(readFileSync(filePath, "utf8")),
    baseCommitIdentifier: "commit-base",
  });
}

describe("E2E-01-03 S1：陈旧写入被拒绝且人工修改保留", () => {
  it("① 读后人工修改同一文件 → 拒绝写入，人工字节不变，待写内容保全为 patch", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);

    // 人工在"已读、未写"窗口内修改同一文件。
    const humanContent = "人工修改的内容（必须被保留）\n";
    writeFileSync(targetPath, humanContent, "utf8");

    const outcome = await guard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "Agent 想写入的内容\n",
    });

    expect(outcome.kind).toBe("stale-rejected");
    if (outcome.kind !== "stale-rejected") {
      throw new Error("未拒绝陈旧写入");
    }
    // 人工字节必须逐字节保留。
    expect(readFileSync(targetPath, "utf8")).toBe(humanContent);
    // Agent 待写内容必须保全为可追溯 patch（不丢失）。
    expect(existsSync(outcome.preservedPatchPath)).toBe(true);
    const preservedPatch = readFileSync(outcome.preservedPatchPath, "utf8");
    expect(preservedPatch).toContain("Agent 想写入的内容");
    expect(preservedPatch).toContain("stale-human-change");
    expect(outcome.staleReason).toContain("stale-human-change");
  });

  it("② 读后无人工修改 → 允许写入", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);

    const outcome = await guard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "Agent 写入的内容\n",
    });

    expect(outcome.kind).toBe("allowed");
  });

  it("③ 从未读取过目标（盲覆盖）→ baseline-missing，不得误报为拒绝", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });

    const outcome = await guard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "盲覆盖内容\n",
    });

    expect(outcome.kind).toBe("baseline-missing");
  });

  it("④ Agent 自己写完 → 基线必须前移，否则下一次自身写入会被误判为陈旧", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);

    expect(
      (
        await guard.guardOverwrite({
          agentInstanceId,
          taskExecutionIdentifier,
          targetPath,
          pendingWriteContent: "第一版\n",
        })
      ).kind,
    ).toBe("allowed");

    writeFileSync(targetPath, "第一版\n", "utf8");
    await guard.recordOwnWrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      contentFingerprint: computeContentFingerprint("第一版\n"),
    });

    // 同一 Agent 的第二次写入不得被判为陈旧。
    expect(
      (
        await guard.guardOverwrite({
          agentInstanceId,
          taskExecutionIdentifier,
          targetPath,
          pendingWriteContent: "第二版\n",
        })
      ).kind,
    ).toBe("allowed");
  });

  it("⑤ 人工修改后再次读取 → 不得刷新基线（否则人工变更被吸收）", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);

    writeFileSync(targetPath, "人工改动\n", "utf8");
    // Agent 重新读取（拿到的是人工改后的内容）——基线**不得**因此刷新。
    await recordReadBaseline(guard);

    const outcome = await guard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "Agent 内容\n",
    });

    expect(outcome.kind).toBe("stale-rejected");
    expect(readFileSync(targetPath, "utf8")).toBe("人工改动\n");
  });

  it("⑥ 人工删除/重命名目标 → 拒绝（不得当作基线一致）", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);
    rmSync(targetPath, { force: true });

    const outcome = await guard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "Agent 内容\n",
    });

    expect(outcome.kind).toBe("stale-rejected");
  });

  it("⑦ 基线跨进程持久化：新实例仍拒绝陈旧写入（模拟中断后恢复）", async () => {
    const firstGuard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(firstGuard);
    writeFileSync(targetPath, "人工后来改的\n", "utf8");

    // 新实例 = 新进程（读同一状态目录）。
    const secondGuard = new AgentEditIntentGuard({ baseDirectory });
    const outcome = await secondGuard.guardOverwrite({
      agentInstanceId,
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "Agent 内容\n",
    });

    expect(outcome.kind).toBe("stale-rejected");
    expect(readFileSync(targetPath, "utf8")).toBe("人工后来改的\n");
  });

  it("⑧ 不同 Agent 的基线互不串用（个体隔离）", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    await recordReadBaseline(guard);
    writeFileSync(targetPath, "人工改动\n", "utf8");

    const otherAgentOutcome = await guard.guardOverwrite({
      agentInstanceId: "worker:mission-concurrent:T-001:2",
      taskExecutionIdentifier,
      targetPath,
      pendingWriteContent: "另一个 Agent 的内容\n",
    });

    expect(otherAgentOutcome.kind).toBe("baseline-missing");
  });
});
