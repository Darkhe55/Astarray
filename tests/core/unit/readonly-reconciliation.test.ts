/**
 * T12A-03 测试：启动只读对账。
 * 验收：离线人工修改/分支变化/脏工作树/丢失 worktree 均明确分类；
 * 对账阶段只读确认；无差异时可继续恢复。
 */
import { describe, expect, it } from "vitest";

import { ReadonlyReconciliationService } from "../../../packages/core/src/orchestration/readonly-reconciliation-service.js";
import type {
  GitStatusPort,
  WorktreeExistencePort,
} from "../../../packages/core/src/orchestration/readonly-reconciliation-service.js";
import type { HumanChangeObservation } from "../../../packages/core/src/orchestration/human-agent-concurrent-change-schemas.js";

function makeService(options: {
  gitState?: {
    branchName: string;
    headCommitIdentifier: string;
    hasDirtyWorkingTree: boolean;
  };
  worktrees?: Record<string, boolean>;
  latestObservation?: HumanChangeObservation | null;
} = {}) {
  const gitStatusPort: GitStatusPort = {
    readStatus: async () =>
      options.gitState ?? {
        branchName: "main",
        headCommitIdentifier: "commit-1",
        hasDirtyWorkingTree: false,
      },
  };
  const worktreeExistencePort: WorktreeExistencePort = {
    doesWorktreeExist: async ({ worktreeIdentifier }) =>
      options.worktrees?.[worktreeIdentifier] ?? true,
  };
  const service = new ReadonlyReconciliationService({
    gitStatusPort,
    worktreeExistencePort,
    humanChangeObservationPort: {
      readLatestObservation: async () => options.latestObservation ?? null,
    },
  });
  return { service };
}

const baseCheckpointInput = {
  checkpointGitState: {
    targetBranchName: "main",
    targetHeadCommitIdentifier: "commit-1",
    expectedDirty: false,
  },
  checkpointHumanChangeObservationRevision: 1,
  expectedWorktreeIdentifiers: ["worker/task-1/impl"],
};

describe("ReadonlyReconciliationService 无差异", () => {
  it("全部一致 → isSafeToProceed + 只读确认", async () => {
    const { service } = makeService();
    const result = await service.reconcile(baseCheckpointInput);
    expect(result.isReadonlyConfirmed).toBe(true);
    expect(result.discrepancies).toEqual([]);
    expect(result.isSafeToProceed).toBe(true);
  });
});

describe("ReadonlyReconciliationService 差异分类", () => {
  it("离线人工修改 → offline-human-change（T05D 重对账；旧检查点不得覆盖）", async () => {
    const latestObservation: HumanChangeObservation = {
      schemaVersion: 1,
      observationIdentifier: "obs-2",
      authenticatedUserSourceIdentifier: "user-1",
      observedCommitIdentifier: "commit-2",
      changedPaths: ["src/a.ts"],
      changedResourceFingerprintsByPath: { "src/a.ts": `sha256:${"b".repeat(64)}` },
      observedAtIso: "2026-08-19T00:00:00.000Z",
      observationRevision: 2,
    };
    const { service } = makeService({ latestObservation });
    const result = await service.reconcile(baseCheckpointInput);
    expect(result.requiresHumanChangeReconciliation).toBe(true);
    expect(
      result.discrepancies.some((d) => d.type === "offline-human-change"),
    ).toBe(true);
    expect(result.isSafeToProceed).toBe(false);
  });

  it("分支/HEAD 变化 → branch-changed", async () => {
    const { service } = makeService({
      gitState: {
        branchName: "feature-x",
        headCommitIdentifier: "commit-9",
        hasDirtyWorkingTree: false,
      },
    });
    const result = await service.reconcile(baseCheckpointInput);
    expect(
      result.discrepancies.filter((d) => d.type === "branch-changed"),
    ).toHaveLength(2);
    expect(result.isSafeToProceed).toBe(false);
  });

  it("脏工作树（与检查点预期不一致）→ dirty-working-tree", async () => {
    const { service } = makeService({
      gitState: {
        branchName: "main",
        headCommitIdentifier: "commit-1",
        hasDirtyWorkingTree: true,
      },
    });
    const result = await service.reconcile(baseCheckpointInput);
    expect(
      result.discrepancies.some((d) => d.type === "dirty-working-tree"),
    ).toBe(true);
  });

  it("worktree 丢失 → worktree-missing", async () => {
    const { service } = makeService({
      worktrees: { "worker/task-1/impl": false },
    });
    const result = await service.reconcile(baseCheckpointInput);
    expect(
      result.discrepancies.some((d) => d.type === "worktree-missing"),
    ).toBe(true);
    expect(result.isSafeToProceed).toBe(false);
  });
});

describe("ReadonlyReconciliationService 只读确认", () => {
  it("对账结果始终声明只读（无写入副作用）", async () => {
    const { service } = makeService({
      gitState: {
        branchName: "other",
        headCommitIdentifier: "other-commit",
        hasDirtyWorkingTree: true,
      },
      worktrees: { "worker/task-1/impl": false },
    });
    const result = await service.reconcile(baseCheckpointInput);
    expect(result.isReadonlyConfirmed).toBe(true);
  });
});