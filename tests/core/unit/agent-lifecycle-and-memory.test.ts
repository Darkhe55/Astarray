/**
 * T08A 单测：默认控制流、个体记忆隔离与三级 Agent 生命周期（ADR-0022/0023）。
 * 覆盖：个体记忆域（角色级路径拒绝/owner 三处一致/观察带来源）、跨 Agent
 * 附件（脱敏/预算/哈希校验）、任务插入提案（来源/优先级/环/revision）、
 * 三级复用判定（条件逐项/原因可解释）、单链守卫（链外/禁止能力）、
 * 生命周期收口（阶段顺序/幂等/失败保留）、报告归档（只写不唤醒/只读选择）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentIndividualMemoryStore,
  AgentMemoryNamespacePolicy,
} from "../../../packages/core/src/orchestration/agent-individual-memory.js";
import { CrossAgentContextAttachmentController } from "../../../packages/core/src/orchestration/cross-agent-attachment-controller.js";
import { ConversationTaskInsertionController } from "../../../packages/core/src/orchestration/conversation-task-insertion-controller.js";
import {
  TertiaryAgentAssignmentPlanner,
  TertiarySingleChainExecutionGuard,
  TertiaryAgentLifecycleController,
} from "../../../packages/core/src/orchestration/tertiary-lifecycle.js";
import {
  MainAgentReportArchiveIngestor,
  MainAgentReportReader,
} from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import type { TertiaryTerminalReport } from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import type { AgentWorkArchiveEntry } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t08a-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("AgentMemoryNamespacePolicy / AgentIndividualMemoryStore", () => {
  it("角色级共享路径（main/secondary/tertiary/all-agents/shared）拒绝", () => {
    const policy = new AgentMemoryNamespacePolicy();
    for (const forbidden of ["main", "secondary", "tertiary", "all-agents", "shared"]) {
      expect(policy.isIndividualNamespaceDirectory(forbidden)).toBe(false);
    }
    expect(
      policy.isIndividualNamespaceDirectory("secondary-instance-1"),
    ).toBe(true);
    // 特殊字符 ID 的编码命名空间同样合法（decode ~XXXX 分支）
    expect(policy.isIndividualNamespaceDirectory("tertiary~003aold")).toBe(true);
    expect(policy.isIndividualNamespaceDirectory("tertiary-中文")).toBe(false);
  });

  it("非法命名空间追加观察拒绝；记忆根不存在时列表为空", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.appendObservation({
        runtimeAgentInstanceId: "shared",
        summary: "x",
        sourceAgentInstanceId: null,
        sourceAttachmentHash: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(await store.listMemoryNamespaceDirectories()).toEqual([]);
  });

  it("两个同级 Agent 相同任务文本下记忆完全隔离", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-a",
      summary: "观察 A",
      sourceAgentInstanceId: null,
      sourceAttachmentHash: null,
    });
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-b",
      summary: "观察 B",
      sourceAgentInstanceId: "tertiary-a",
      sourceAttachmentHash: "sha256:" + "a".repeat(64),
    });
    const memoryA = await store.readMemoryArchive("tertiary-a");
    const memoryB = await store.readMemoryArchive("tertiary-b");
    expect(memoryA?.observations.map((o) => o.summary)).toEqual(["观察 A"]);
    expect(memoryB?.observations.map((o) => o.summary)).toEqual(["观察 B"]);
    // B 的观察保留原始来源与附件哈希
    expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a");
    expect(memoryB?.observations[0]?.sourceAttachmentHash).toMatch(/^sha256:/);
    // 命名空间互不重叠
    const namespaces = await store.listMemoryNamespaceDirectories();
    expect(namespaces.length).toBe(2);
  });

  it("运行时身份与文档 owner 不一致拒绝", async () => {
    const store = new AgentIndividualMemoryStore({ baseDirectory: temporaryDirectory });
    await store.appendObservation({
      runtimeAgentInstanceId: "tertiary-a",
      summary: "x",
      sourceAgentInstanceId: null,
      sourceAttachmentHash: null,
    });
    // 篡改文档 owner 后读取 → 拒绝
    const memoryPath = path.join(
      temporaryDirectory,
      "agent-memory",
      "tertiary-a",
      "memory-archive.json",
    );
    const raw = JSON.parse(await fs.readFile(memoryPath, "utf8")) as {
      ownerAgentInstanceId: string;
    };
    raw.ownerAgentInstanceId = "tertiary-evil";
    await fs.writeFile(memoryPath, JSON.stringify(raw), "utf8");
    await expect(
      store.readMemoryArchive("tertiary-a"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });
});

describe("CrossAgentContextAttachmentController", () => {
  const controller = new CrossAgentContextAttachmentController();

  function makeEntry(summary: string): AgentWorkArchiveEntry {
    return {
      archiveEntryId: `entry-${summary}`,
      recordedAtIso: new Date().toISOString(),
      taskId: "T-001",
      entryType: "handoff",
      summary,
      artifactReferences: [],
    };
  }

  it("生成不可变附件（脱敏 + 哈希 + 预算）", () => {
    const attachment = controller.createAttachment({
      sourceAgentInstanceId: "tertiary-old",
      archiveRevision: 3,
      selectedArchiveEntries: [makeEntry("密钥是 sk-abcdefghijklmnopqrstuvwxyz123456")],
      selectionReason: "任务接手",
      tokenBudgetTokens: 1_000,
      redactionRules: [
        { pattern: /sk-[A-Za-z0-9]+/g, replacement: "[REDACTED]" },
      ],
    });
    expect(attachment.selectedArchiveEntries[0]?.summary).not.toContain("sk-");
    expect(attachment.selectedArchiveEntries[0]?.summary).toContain("[REDACTED]");
    expect(attachment.contentHash).toMatch(/^sha256:/);
    expect(controller.verifyAttachment({
      attachment,
      expectedSourceAgentInstanceId: "tertiary-old",
    })).toBe(true);
  });

  it("空选择拒绝；token 预算超限拒绝；来源不匹配校验失败", () => {
    expect(() =>
      controller.createAttachment({
        sourceAgentInstanceId: "a",
        archiveRevision: 1,
        selectedArchiveEntries: [],
        selectionReason: "r",
        tokenBudgetTokens: 100,
        redactionRules: [],
      }),
    ).toThrowError(/不能为空/);
    expect(() =>
      controller.createAttachment({
        sourceAgentInstanceId: "a",
        archiveRevision: 1,
        selectedArchiveEntries: [makeEntry("很长".repeat(500))],
        selectionReason: "r",
        tokenBudgetTokens: 10,
        redactionRules: [],
      }),
    ).toThrowError(/token 预算/);
    const attachment = controller.createAttachment({
      sourceAgentInstanceId: "a",
      archiveRevision: 1,
      selectedArchiveEntries: [makeEntry("内容")],
      selectionReason: "r",
      tokenBudgetTokens: 1_000,
      redactionRules: [],
    });
    expect(controller.verifyAttachment({
      attachment,
      expectedSourceAgentInstanceId: "b",
    })).toBe(false);
  });
});

describe("ConversationTaskInsertionController", () => {
  async function makeController() {
    const store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
    const manageController = new TaskSequenceManageController(store);
    await manageController.publishSequence({
      ownerAgentInstanceId: "secondary-target",
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "用户根任务", priorityTier: null, externalReference: null },
    });
    return new ConversationTaskInsertionController({
      manageController,
      authenticatedUserId: "user-1",
    });
  }

  it("用户来源提案插入（层级 0）；主 Agent 派生只能 ≥1", async () => {
    const controller = await makeController();
    await controller.submitProposal({
      proposalId: "proposal-1",
      targetSecondaryAgentInstanceId: "secondary-target",
      sequenceId: "seq-1",
      expectedRevision: 2,
      sourceKind: "user",
      sourceActorId: "user-1",
      task: { taskId: "t2", title: "用户新任务", priorityTier: null, externalReference: null },
      anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
      acceptanceCriteria: "完成即可",
      createdAtIso: new Date().toISOString(),
    });
    // 主 Agent 派生节点请求层级 0 → 拒绝
    await expect(
      controller.submitProposal({
        proposalId: "proposal-2",
        targetSecondaryAgentInstanceId: "secondary-target",
        sequenceId: "seq-1",
        expectedRevision: 4,
        sourceKind: "agent",
        sourceActorId: "main-agent-1",
        task: { taskId: "t3", title: "主 Agent 设计", priorityTier: 0, externalReference: null },
        anchor: { predecessorTaskIds: ["t2"], successorTaskIds: [] },
        acceptanceCriteria: "x",
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "task-priority-denied" });
  });

  it("伪造用户来源/未知锚点/陈旧 revision 拒绝", async () => {
    const controller = await makeController();
    await expect(
      controller.submitProposal({
        proposalId: "proposal-3",
        targetSecondaryAgentInstanceId: "secondary-target",
        sequenceId: "seq-1",
        expectedRevision: 2,
        sourceKind: "user",
        sourceActorId: "user-evil",
        task: { taskId: "t4", title: "x", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
        acceptanceCriteria: "x",
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await expect(
      controller.submitProposal({
        proposalId: "proposal-4",
        targetSecondaryAgentInstanceId: "secondary-target",
        sequenceId: "seq-1",
        expectedRevision: 2,
        sourceKind: "user",
        sourceActorId: "user-1",
        task: { taskId: "t5", title: "x", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["ghost"], successorTaskIds: [] },
        acceptanceCriteria: "x",
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "dependency-not-found" });
    await expect(
      controller.submitProposal({
        proposalId: "proposal-5",
        targetSecondaryAgentInstanceId: "secondary-target",
        sequenceId: "seq-1",
        expectedRevision: 99,
        sourceKind: "user",
        sourceActorId: "user-1",
        task: { taskId: "t6", title: "x", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
        acceptanceCriteria: "x",
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });
});

describe("TertiaryAgentAssignmentPlanner / SingleChainGuard / Lifecycle", () => {
  it("全部复用条件满足 → reuse-existing；任一不满足 → create-new（带原因）", () => {
    const planner = new TertiaryAgentAssignmentPlanner();
    const baseCandidate = {
      agentInstanceId: "tertiary-1",
      isAlive: true,
      isIdle: true,
      owningSecondaryAgentInstanceId: "secondary-1",
      isTaskMissionCompatible: true,
      isToolPermissionScopeCompatible: true,
      isWorktreeCompatible: true,
      hasUnconfirmedSideEffects: false,
      hasUnprocessedControlMessages: false,
      isContextBudgetAvailable: true,
      isMessageBudgetAvailable: true,
      doesHistoryConflictWithNewTask: false,
    };
    expect(planner.decideAssignment(baseCandidate)).toMatchObject({
      decision: "reuse-existing",
    });
    // 逐项触发全部拒绝原因
    const rejectionCases: Array<[Partial<typeof baseCandidate>, string]> = [
      [{ isAlive: false }, "不存活"],
      [{ isIdle: false }, "非空闲"],
      [{ owningSecondaryAgentInstanceId: "" }, "所属次级"],
      [{ isTaskMissionCompatible: false }, "任务/mission 不兼容"],
      [{ isToolPermissionScopeCompatible: false }, "工具/权限"],
      [{ isWorktreeCompatible: false }, "worktree"],
      [{ hasUnconfirmedSideEffects: true }, "未确认副作用"],
      [{ hasUnprocessedControlMessages: true }, "未处理控制消息"],
      [{ isContextBudgetAvailable: false }, "上下文预算"],
      [{ isMessageBudgetAvailable: false }, "消息预算"],
      [{ doesHistoryConflictWithNewTask: true }, "历史内容"],
    ];
    for (const [overrides, expectedReason] of rejectionCases) {
      const result = planner.decideAssignment({ ...baseCandidate, ...overrides });
      expect(result.decision).toBe("create-new");
      expect(result.reasons.join()).toContain(expectedReason);
    }
  });

  it("单链守卫：链外任务与禁止能力拒绝", () => {
    const guard = new TertiarySingleChainExecutionGuard();
    const binding = guard.bindActivation({
      agentInstanceId: "tertiary-1",
      taskBundleId: "bundle-1",
      chainTaskIds: ["T-001", "T-002"],
      publisherSecondaryAgentInstanceId: "secondary-1",
    });
    expect(binding.chainTaskIds).toEqual(["T-001", "T-002"]);
    expect(() => guard.assertTaskWithinChain(binding, "T-003")).toThrowError(/链外/);
    expect(() => guard.assertTaskWithinChain(binding, "T-001")).not.toThrow();
    for (const capability of [
      "github-project-control",
      "integration-branch-write",
      "agent-spawn-or-schedule",
    ]) {
      expect(() => guard.assertCapabilityAllowed(capability)).toThrowError(/禁止能力/);
    }
    expect(() => guard.assertCapabilityAllowed("readFile")).not.toThrow();
    expect(() =>
      guard.bindActivation({
        agentInstanceId: "tertiary-1",
        taskBundleId: "",
        chainTaskIds: ["T-001"],
        publisherSecondaryAgentInstanceId: "secondary-1",
      }),
    ).toThrowError(/taskBundleId/);
  });

  it("生命周期收口：固定阶段顺序、检查点/handoff 引用、终态 closed", async () => {
    const phasesSeen: string[] = [];
    const controller = new TertiaryAgentLifecycleController({
      stopDispatch: async () => {
        phasesSeen.push("stopping-dispatch");
      },
      drainUnconfirmedCalls: async () => {
        phasesSeen.push("draining-unconfirmed-calls");
      },
      persistCheckpoint: async () => {
        phasesSeen.push("persisting-checkpoint");
        return "checkpoint-1";
      },
      writeHandoff: async () => {
        phasesSeen.push("writing-handoff");
        return "handoff-1";
      },
      confirmFeedback: async () => {
        phasesSeen.push("confirming-feedback");
      },
      revokePermissionLease: async () => {
        phasesSeen.push("revoking-permission-lease");
      },
      unregisterMailbox: async () => {
        phasesSeen.push("unregistering-mailbox");
      },
      handleGitResources: async () => {
        phasesSeen.push("handling-git-resources");
      },
      terminateProcess: async () => {
        phasesSeen.push("terminating-process");
      },
    });
    const state = await controller.shutdown({ agentInstanceId: "tertiary-1" });
    expect(state.phase).toBe("closed");
    expect(state.checkpointId).toBe("checkpoint-1");
    expect(state.handoffReference).toBe("handoff-1");
    expect(state.closedAtIso).not.toBeNull();
    expect(phasesSeen).toEqual([
      "stopping-dispatch",
      "draining-unconfirmed-calls",
      "persisting-checkpoint",
      "writing-handoff",
      "confirming-feedback",
      "revoking-permission-lease",
      "unregistering-mailbox",
      "handling-git-resources",
      "terminating-process",
    ]);
  });

  it("生命周期阶段失败保留状态（不静默跳过，可重试）", async () => {
    const controller = new TertiaryAgentLifecycleController({
      revokePermissionLease: async () => {
        throw new Error("租约撤销失败");
      },
    });
    await expect(
      controller.shutdown({ agentInstanceId: "tertiary-1" }),
    ).rejects.toMatchObject({ errorCode: "tool-execution-failed" });
    expect(controller.getState()?.phase).toBe("revoking-permission-lease");
  });
});

describe("MainAgentReportArchiveIngestor / Reader", () => {
  function makeReport(overrides: Partial<TertiaryTerminalReport> = {}): TertiaryTerminalReport {
    return {
      reportId: `report-${Math.random().toString(36).slice(2, 8)}`,
      missionId: "mission-1",
      taskBundleId: "bundle-1",
      reportingAgentInstanceId: "tertiary-1",
      reportKind: "completed",
      summary: "任务链完成，测试通过",
      executedChecks: [{ command: "npm test", exitCode: 0 }],
      createdAtIso: new Date().toISOString(),
      contentHash: "",
      ...overrides,
    };
  }

  it("汇报只入档（写索引）；来源空拒绝；只读选择按任务引用与预算", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
    });
    const reportA = makeReport({ taskBundleId: "bundle-1" });
    const reportB = makeReport({ taskBundleId: "bundle-2", reportKind: "blocked" });
    await ingestor.ingestReport(reportA);
    await ingestor.ingestReport(reportB);
    await expect(
      ingestor.ingestReport({ ...makeReport(), reportingAgentInstanceId: "" }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    const reader = new MainAgentReportReader(ingestor, 10_000);
    const selected = await reader.selectReports({
      missionId: "mission-1",
      taskBundleIdFilter: "bundle-1",
      maxReports: 10,
    });
    expect(selected.map((report) => report.taskBundleId)).toEqual(["bundle-1"]);
    // token 预算截断
    const tinyReader = new MainAgentReportReader(ingestor, 1);
    const truncated = await tinyReader.selectReports({
      missionId: "mission-1",
      taskBundleIdFilter: null,
      maxReports: 10,
    });
    expect(truncated.length).toBeLessThanOrEqual(1);
    // 索引保留来源/任务引用/哈希
    const index = await ingestor.readIndex("mission-1");
    expect(index.length).toBe(2);
    expect(index[0]?.reportingAgentInstanceId).toBe("tertiary-1");
    expect(index[0]?.contentHash).toMatch(/^sha256:/);
  });

  it("报告内容被篡改 → journal-corrupted", async () => {
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
    });
    const report = makeReport();
    await ingestor.ingestReport(report);
    const reportFilePath = path.join(
      temporaryDirectory,
      "main-agent-reports",
      "mission-1",
      `${report.reportId}.json`,
    );
    const raw = JSON.parse(await fs.readFile(reportFilePath, "utf8")) as {
      summary: string;
    };
    raw.summary = "被篡改";
    await fs.writeFile(reportFilePath, JSON.stringify(raw), "utf8");
    await expect(ingestor.readReport("mission-1", report.reportId)).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
  });
});
