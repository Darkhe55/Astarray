/**
 * T05D-03 测试：Agent 陈旧写入守卫与 patch 保全。
 * 验收：人工变化后 Agent 覆盖被拒（stale-human-change）；Agent 工作
 * 不丢失（patch 保全可追溯）；意图过期/路径越界/文件被删拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  StaleWriteGuard,
} from "../../../packages/core/src/orchestration/stale-write-guard.js";
import { Sha256FileFingerprinter } from "../../../packages/core/src/orchestration/human-worktree-observer.js";
import type { AgentEditIntent } from "../../../packages/core/src/orchestration/human-agent-concurrent-change-schemas.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t05d03-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function makeSetup(options: { targetContent?: string } = {}) {
  const targetPath = path.join(temporaryDirectory, "src", "a.ts");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, options.targetContent ?? "agent-baseline", "utf8");
  const fingerprinter = new Sha256FileFingerprinter();
  const baselineFingerprint =
    await fingerprinter.computeFingerprint(targetPath);
  const guard = new StaleWriteGuard({
    fingerprintPort: fingerprinter,
    patchVaultBaseDirectory: temporaryDirectory,
    nowUnixMilliseconds: () => 1_752_000_000_000,
  });
  const intent: AgentEditIntent = {
    schemaVersion: 1,
    editIntentIdentifier: "intent-1",
    agentInstanceId: "tertiary-impl-1",
    taskExecutionIdentifier: "task-exec-1",
    baseCommitIdentifier: "abc123",
    plannedReadPaths: [targetPath],
    allowedWritePaths: [targetPath],
    initialResourceFingerprintsByPath: { [targetPath]: baselineFingerprint },
    affectedContractIdentifiers: [],
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    revision: 1,
  };
  return { targetPath, guard, intent };
}

describe("StaleWriteGuard 基线一致通过", () => {
  it("目标指纹与基线一致 → 允许写入", async () => {
    const { targetPath, guard, intent } = await makeSetup();
    const result = await guard.guardWrite({
      intent,
      targetPath,
      pendingWriteContent: "agent-new-content",
    });
    expect(result).toEqual({ isAllowed: true });
  });
});

describe("StaleWriteGuard 人工变化拒绝与 patch 保全", () => {
  it("读取后人工修改同一文件 → 拒绝写入（stale-human-change），人工字节不变，patch 保全", async () => {
    const { targetPath, guard, intent } = await makeSetup();
    // 模拟人工在 Agent 读取后修改文件
    await fs.writeFile(targetPath, "human-changed-content", "utf8");
    const result = await guard.guardWrite({
      intent,
      targetPath,
      pendingWriteContent: "agent-patch-to-preserve",
    });
    expect(result.isAllowed).toBe(false);
    if (!result.isAllowed) {
      expect(result.staleReason).toContain("stale-human-change");
      // patch 保全（Agent 工作不丢失；可追溯）
      const preservedPatch = await fs.readFile(result.preservedPatchPath, "utf8");
      expect(preservedPatch).toContain("intent-1");
      expect(preservedPatch).toContain("agent-patch-to-preserve");
      // 人工字节保持不变（未被覆盖）
      expect(await fs.readFile(targetPath, "utf8")).toBe("human-changed-content");
    }
  });

  it("意图过期 → 拒绝并保全 patch", async () => {
    const { targetPath, guard, intent } = await makeSetup();
    const expiredIntent = { ...intent, expiresAtIso: "2020-01-01T00:00:00.000Z" };
    const result = await guard.guardWrite({
      intent: expiredIntent,
      targetPath,
      pendingWriteContent: "expired-patch",
    });
    expect(result.isAllowed).toBe(false);
    if (!result.isAllowed) {
      expect(result.staleReason).toContain("过期");
    }
  });

it("写入路径不在意图允许范围 → 拒绝（路径越界）", async () => {
    const { guard, intent } = await makeSetup();
    const outOfScopePath = path.join(temporaryDirectory, "other.ts");
    await fs.writeFile(outOfScopePath, "x", "utf8");
    const result = await guard.guardWrite({
      intent,
      targetPath: outOfScopePath,
      pendingWriteContent: "escape-patch",
    });
    expect(result.isAllowed).toBe(false);
    if (!result.isAllowed) {
      expect(result.staleReason).toContain("允许范围");
    }
  });

  it("目标文件被人工删除/重命名 → 拒绝", async () => {
    const { targetPath, guard, intent } = await makeSetup();
    await fs.rm(targetPath);
    const result = await guard.guardWrite({
      intent,
      targetPath,
      pendingWriteContent: "patch",
    });
    expect(result.isAllowed).toBe(false);
  });

it("目标不在意图基线指纹记录 → 拒绝", async () => {
    const { guard, intent } = await makeSetup();
    const otherPath = path.join(temporaryDirectory, "unrecorded.ts");
    await fs.writeFile(otherPath, "y", "utf8");
    const intentWithOtherPath = {
      ...intent,
      allowedWritePaths: [otherPath],
    };
    const result = await guard.guardWrite({
      intent: intentWithOtherPath,
      targetPath: otherPath,
      pendingWriteContent: "z",
    });
    expect(result.isAllowed).toBe(false);
    if (!result.isAllowed) {
      expect(result.staleReason).toContain("基线指纹记录");
    }
  });
});


