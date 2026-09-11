/**
 * T12A-R1-02 测试：重启先只读对账（副作用与权限不自动延续）。
 * 验收：磁盘/分支/人工变化与检查点不一致 → 阻断恢复并给出可操作裁决项；
 * git 状态不可读时 fail-closed；旧一次性授权/临时提升不自动延续；
 * 已确认调用不二次执行；原任务历史保持。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { RecoveryCenterController } from "../../../packages/core/src/orchestration/recovery-center-controller.js";
import { RecoveryCheckpointStore } from "../../../packages/core/src/orchestration/recovery-checkpoint-store.js";
import type {
  GitStatusPort,
  HumanChangeObservationPort,
} from "../../../packages/core/src/orchestration/readonly-reconciliation-service.js";
import type { HumanChangeObservation } from "../../../packages/core/src/orchestration/human-agent-concurrent-change-schemas.js";
import { makeRecoveryCheckpoint } from "../../support/recovery-checkpoint-fixture.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t12ar1-02-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

const gitStateRecovery = {
  targetBranchName: "main",
  targetHeadCommitIdentifier: "commit-1",
  expectedDirty: false,
  expectedWorktreeIdentifiers: [],
};

function gitPort(state: {
  branchName: string;
  headCommitIdentifier: string;
  hasDirtyWorkingTree: boolean;
}): GitStatusPort {
  return { readStatus: async () => state };
}

function observationPort(
  latest: HumanChangeObservation | null,
): HumanChangeObservationPort {
  return { readLatestObservation: async () => latest };
}

async function seedBlockedMission(missionId: string): Promise<MissionManager> {
  const manager = new MissionManager(
    new TaskStore({ baseDirectory: stateDirectory }),
    stateDirectory,
  );
  await manager.createMission({
    missionId,
    mode: "assist",
    prompt: "对账探针",
    taskNodes: [
      {
        id: "T-001",
        description: "任务一",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ],
  });
  await manager.updateMissionStatus(missionId, "blocked");
  return manager;
}

async function writeCheckpoint(
  missionIdentifier: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const store = new RecoveryCheckpointStore({ baseDirectory: stateDirectory });
  await store.writeCheckpoint({
    checkpoint: makeRecoveryCheckpoint(missionIdentifier, overrides),
    writingProcessInstanceIdentifier: "process-1",
  });
}

describe("重启只读对账：分支/人工变化/工作树", () => {
  it("分支变化 → 阻断恢复并给出 branch-changed 裁决项，状态不变", async () => {
    const manager = await seedBlockedMission("mission-branch");
    await writeCheckpoint("mission-branch", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "feature-x",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
      },
    });

    const result = await controller.resumeMission("mission-branch");
    expect(result.resumed).toBe(false);
    expect(
      result.blockedDecisionItems.some(
        (item) => item.decision === "blocked-reconciliation-discrepancy",
      ),
    ).toBe(true);
    expect(
      result.reconciliation.discrepancies.map((item) => item.type),
    ).toContain("branch-changed");
    expect(
      (await manager.getMissionStatus("mission-branch")).summary?.status,
    ).toBe("blocked");
  });

  it("人工变化 revision 更新 → offline-human-change 阻断（旧检查点不得覆盖）", async () => {
    await seedBlockedMission("mission-human");
    await writeCheckpoint("mission-human", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
        humanChangeObservationPort: observationPort({
          schemaVersion: 1,
          observationIdentifier: "obs-2",
          authenticatedUserSourceIdentifier: "user-1",
          observedCommitIdentifier: "commit-1",
          changedPaths: ["src/a.ts"],
          changedResourceFingerprintsByPath: {},
          observedAtIso: "2026-08-19T00:00:00.000Z",
          observationRevision: 2,
        }),
      },
    });

    const result = await controller.resumeMission("mission-human");
    expect(result.resumed).toBe(false);
    expect(result.reconciliation.requiresHumanChangeReconciliation).toBe(true);
    expect(
      result.reconciliation.discrepancies.map((item) => item.type),
    ).toContain("offline-human-change");
  });

  it("git 状态不可读且检查点声明了 git 状态 → fail-closed 阻断", async () => {
    await seedBlockedMission("mission-no-git");
    await writeCheckpoint("mission-no-git", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
    });

    const result = await controller.resumeMission("mission-no-git");
    expect(result.resumed).toBe(false);
    expect(
      result.blockedDecisionItems.some(
        (item) => item.decision === "blocked-reconciliation-unavailable",
      ),
    ).toBe(true);
    expect(result.reconciliation.gitStateAvailable).toBe(false);
  });

  it("全部一致 → resumed 且 reconciliation 只读确认无差异", async () => {
    const manager = await seedBlockedMission("mission-clean");
    await writeCheckpoint("mission-clean", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
        worktreeExistencePort: { doesWorktreeExist: async () => true },
      },
    });

    const result = await controller.resumeMission("mission-clean");
    expect(result.resumed).toBe(true);
    expect(result.reconciliation.isReadonlyConfirmed).toBe(true);
    expect(result.reconciliation.isSafeToProceed).toBe(true);
    expect(result.reconciliation.discrepancies).toEqual([]);
    expect(
      (await manager.getMissionStatus("mission-clean")).summary?.status,
    ).toBe("running");
  });
});

describe("重启只读对账：默认本地端口", () => {
  it("worktree 目录缺失 → worktree-missing 阻断（真实文件系统）", async () => {
    await seedBlockedMission("mission-worktree");
    await writeCheckpoint("mission-worktree", {
      gitStateRecovery: {
        ...gitStateRecovery,
        expectedWorktreeIdentifiers: ["mission-worktree/T-001/tertiary-1"],
      },
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
      },
    });

    const result = await controller.resumeMission("mission-worktree");
    expect(result.resumed).toBe(false);
    expect(
      result.reconciliation.discrepancies.map((item) => item.type),
    ).toContain("worktree-missing");
  });

  it("worktree 目录存在 → 无 worktree-missing", async () => {
    await seedBlockedMission("mission-worktree-ok");
    await fs.mkdir(
      path.join(
        stateDirectory,
        "git-worktrees",
        "mission-worktree-ok",
        "T-001",
        "tertiary-1",
      ),
      { recursive: true },
    );
    await writeCheckpoint("mission-worktree-ok", {
      gitStateRecovery: {
        ...gitStateRecovery,
        expectedWorktreeIdentifiers: ["mission-worktree-ok/T-001/tertiary-1"],
      },
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
      },
    });

    const result = await controller.resumeMission("mission-worktree-ok");
    expect(result.resumed).toBe(true);
    expect(
      result.reconciliation.discrepancies.map((item) => item.type),
    ).not.toContain("worktree-missing");
  });

  it("检查点声明 git 状态但未注入端口时，list/show 标记需对账", async () => {
    await seedBlockedMission("mission-flag");
    await writeCheckpoint("mission-flag", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
    });
    const { view } = await controller.inspectMission("mission-flag");
    expect(view.reconciliationRequired).toBe(true);
  });
});

function cleanGitPort(): GitStatusPort {
  return gitPort({
    branchName: "main",
    headCommitIdentifier: "commit-1",
    hasDirtyWorkingTree: false,
  });
}

async function seedAndWrite(
  missionId: string,
  overrides: Record<string, unknown>,
): Promise<MissionManager> {
  const manager = await seedBlockedMission(missionId);
  await writeCheckpoint(missionId, overrides);
  return manager;
}

describe("五类中断点的产品恢复路径（重启先只读对账）", () => {
  it("before-task-write：无未决项 → 恢复并置 running", async () => {
    const manager = await seedAndWrite("mission-point-task-write", {
      gitStateRecovery,
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: { gitStatusPort: cleanGitPort() },
    });

    const result = await controller.resumeMission("mission-point-task-write");
    expect(result.resumed).toBe(true);
    expect(result.feedbackReplayEnqueueRange).toBeNull();
    expect(
      (await manager.getMissionStatus("mission-point-task-write")).summary
        ?.status,
    ).toBe("running");
  });

  it("after-tool-execution-before-persistence：非幂等未知 → blocked 且已确认调用复用不二次执行", async () => {
    await seedAndWrite("mission-point-tool", {
      gitStateRecovery,
      toolCalls: [
        {
          toolCallIdentifier: "tc-confirmed",
          toolName: "project.read",
          state: "confirmed-success",
          isIdempotent: true,
          completionAttemptIdentifier: "attempt-1",
        },
        {
          toolCallIdentifier: "tc-unknown",
          toolName: "network.post",
          state: "result-unknown",
          isIdempotent: false,
          completionAttemptIdentifier: null,
        },
      ],
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: { gitStatusPort: cleanGitPort() },
    });

    const result = await controller.resumeMission("mission-point-tool");
    expect(result.resumed).toBe(false);
    expect(result.recoveredSafeNodes).toEqual(["tc-confirmed"]);
    expect(
      result.blockedDecisionItems.map((item) => item.decision),
    ).toContain("blocked-uncertain-side-effect");
    // 已确认调用只复用，不出现在需裁决列表（不二次执行）
    expect(
      result.blockedDecisionItems.some((item) => item.item === "tc-confirmed"),
    ).toBe(false);
  });

  it("after-feedback-deliver-before-ack：只重放 ack 之后的范围", async () => {
    await seedAndWrite("mission-point-feedback", {
      gitStateRecovery,
      feedbackCursor: { enqueueCursor: 3, deliveryCursor: 3, ackCursor: 2 },
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: { gitStatusPort: cleanGitPort() },
    });

    const result = await controller.resumeMission("mission-point-feedback");
    expect(result.resumed).toBe(true);
    expect(result.feedbackReplayEnqueueRange).toEqual({
      fromEnqueueCursor: 3,
      toEnqueueCursor: 3,
    });
  });

  it("mid-provider-stream：停止未确认 → blocked（不并行）", async () => {
    await seedAndWrite("mission-point-provider", {
      gitStateRecovery,
      providerRequests: [
        {
          providerRequestPublicIdentifier: "provider-req-1",
          lastEventAtIso: "2026-08-19T00:00:00.000Z",
          isStopConfirmed: false,
          completionEventState: "none",
        },
      ],
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: { gitStatusPort: cleanGitPort() },
    });

    const result = await controller.resumeMission("mission-point-provider");
    expect(result.resumed).toBe(false);
    expect(
      result.blockedDecisionItems.map((item) => item.decision),
    ).toContain("blocked-provider-state-unknown");
  });

  it("before-git-merge：Git 状态漂移 → blocked（先只读对账）", async () => {
    await seedAndWrite("mission-point-git-merge", { gitStateRecovery });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-moved",
          hasDirtyWorkingTree: false,
        }),
      },
    });

    const result = await controller.resumeMission("mission-point-git-merge");
    expect(result.resumed).toBe(false);
    expect(
      result.blockedDecisionItems.map((item) => item.decision),
    ).toContain("blocked-reconciliation-discrepancy");
  });

  it("未决冲突 → blocked（旧检查点不得覆盖人工变化）", async () => {
    await seedAndWrite("mission-point-conflict", {
      gitStateRecovery,
      pendingConflictIdentifiers: ["conflict-1"],
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: { gitStatusPort: cleanGitPort() },
    });

    const result = await controller.resumeMission("mission-point-conflict");
    expect(result.resumed).toBe(false);
    expect(
      result.blockedDecisionItems.some(
        (item) => item.item === "pending-conflict-identifiers",
      ),
    ).toBe(true);
  });
});

describe("权限与历史不自动延续", () => {
  it("旧一次性授权/临时提升始终要求重新授权（不自动延续）", async () => {
    const manager = await seedBlockedMission("mission-permission");
    await writeCheckpoint("mission-permission", {
      permissionRecovery: [
        { permissionProfileReference: "assist", profileRevision: 3 },
      ],
    });
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
      reconciliationPorts: {
        gitStatusPort: gitPort({
          branchName: "main",
          headCommitIdentifier: "commit-1",
          hasDirtyWorkingTree: false,
        }),
      },
    });

    const result = await controller.resumeMission("mission-permission");
    expect(result.reauthorizationRequiredTypes).toContain("session-elevation");
    expect(result.reauthorizationRequiredTypes).toContain(
      "installation-allow-once",
    );
    expect(result.reauthorizationRequiredTypes).toContain("backup-deletion");
    // 已确认调用仍是安全节点（复用既有结果，不二次执行）
    expect(result.recoveredSafeNodes).toEqual([]);
    expect(
      (await manager.getMissionStatus("mission-permission")).summary?.status,
    ).toBe("running");
  });

  it("resume 与 abandon 都不删除任务链历史", async () => {
    const manager = await seedBlockedMission("mission-history");
    const taskChainPath = path.join(
      stateDirectory,
      "missions",
      "mission-history",
      "task-chain.json",
    );
    await writeCheckpoint("mission-history", {});
    const controller = new RecoveryCenterController({
      baseDirectory: stateDirectory,
    });
    await controller.resumeMission("mission-history");
    await controller.abandonMission("mission-history");
    expect(await fs.readFile(taskChainPath, "utf8")).not.toBe("");
    expect(
      (await manager.getMissionStatus("mission-history")).summary?.status,
    ).toBe("cancelled");
  });
});
