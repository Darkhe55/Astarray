/**
 * T05C 单测：任务序列存储与控制器（ADR-0013）。
 * 覆盖：持久化 revision 校验、损坏恢复、并发原子更新、
 * 优先级硬拒绝、越权改序/查看拒绝、任务包链校验、来源审计。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import {
  TaskSequenceManageController,
  TaskSequenceStatusController,
} from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "astarray-t05c-"),
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeControllers(): {
  store: AgentTaskSequenceStore;
  manageController: TaskSequenceManageController;
  statusController: TaskSequenceStatusController;
} {
  const store = new AgentTaskSequenceStore({
    baseDirectory: temporaryDirectory,
  });
  return {
    store,
    manageController: new TaskSequenceManageController(store),
    statusController: new TaskSequenceStatusController(store),
  };
}

const OWNER = "agent-instance-owner";
const OTHER_AGENT = "agent-instance-other";

describe("AgentTaskSequenceStore", () => {
  it("revision 不匹配拒绝写入（stale-revision）", async () => {
    const { store, manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    await expect(
      store.updateSequence(OWNER, "seq-1", 999, (current) => {
        return current!;
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("损坏主文件从备份恢复，不静默覆盖", async () => {
    const { store, manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-corrupt",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    const sequenceFilePath = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-instance-owner",
      "task-sequences",
      "seq-corrupt",
      "task-sequence.json",
    );
    await fs.writeFile(sequenceFilePath, "{ 损坏的 JSON", "utf8");
    const sequence = await store.readSequence(OWNER, "seq-corrupt");
    expect(sequence).not.toBeNull();
    expect(sequence?.nodes[0]?.taskId).toBe("t1");
  });

  it("序列文件存放在 agent-memory/<agentInstanceId>/task-sequences/ 下", async () => {
    const { manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    const expectedDirectory = path.join(
      temporaryDirectory,
      "agent-memory",
      "agent-instance-owner",
      "task-sequences",
      "seq-1",
    );
    await expect(fs.access(expectedDirectory)).resolves.toBeUndefined();
    const backupExists = await fs
      .access(path.join(expectedDirectory, "task-sequence.json.bak"))
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(true);
  });
});

describe("TaskSequenceManageController", () => {
  it("发布序列 → 插入前驱 → 状态迁移 → 取消全链路", async () => {
    const { manageController, statusController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "用户根任务", priorityTier: null, externalReference: null },
    });
    const sequence = await manageController.insertTask({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 2,
      task: { taskId: "t2", title: "派生任务", priorityTier: 1, externalReference: null },
      anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
    });
    expect(sequence.revision).toBe(4); // publish(1) + audit(2) + insert(3) + audit(4)
    const snapshot = await statusController.getSnapshot({
      ownerAgentInstanceId: OWNER,
      sequenceId: "seq-1",
      viewer: { sourceKind: "agent", actorId: OWNER },
    });
    expect(snapshot.readyTaskIds).toEqual(["t1"]);
    await manageController.transitionTaskStatus({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 4,
      taskId: "t1",
      nextStatus: "done",
      blockReason: null,
    });
    await manageController.transitionTaskStatus({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 6,
      taskId: "t2",
      nextStatus: "blocked",
      blockReason: "等待用户授权",
    });
    const afterBlockSnapshot = await statusController.getSnapshot({
      ownerAgentInstanceId: OWNER,
      sequenceId: "seq-1",
      viewer: { sourceKind: "agent", actorId: OWNER },
    });
    expect(afterBlockSnapshot.readyTaskIds).toEqual([]);
    const blockedExplanation = afterBlockSnapshot.orderExplanations.find(
      (entry) => entry.taskId === "t2",
    );
    expect(blockedExplanation?.explanation).toContain("等待用户授权");
    await manageController.cancelTask({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 8,
      taskId: "t2",
      cancelReason: "用户撤回",
    });
    const cancelledSnapshot = await statusController.getSnapshot({
      ownerAgentInstanceId: OWNER,
      sequenceId: "seq-1",
      viewer: { sourceKind: "agent", actorId: OWNER },
    });
    expect(
      cancelledSnapshot.nodes.find((node) => node.taskId === "t2")?.status,
    ).toBe("cancelled");
  });

  it("Agent/system/tool 请求层级 0 硬拒绝", async () => {
    const { manageController } = makeControllers();
    await expect(
      manageController.publishSequence({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        firstTask: { taskId: "t1", title: "冒名用户任务", priorityTier: 0, externalReference: null },
      }),
    ).rejects.toMatchObject({ errorCode: "task-priority-denied" });
  });

  it("其他 Agent 无法改序或查看他人的序列", async () => {
    const { manageController, statusController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    await expect(
      manageController.insertTask({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OTHER_AGENT },
        sequenceId: "seq-1",
        expectedRevision: 1,
        task: { taskId: "t2", title: "越权插入", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    await expect(
      statusController.getSnapshot({
        ownerAgentInstanceId: OWNER,
        sequenceId: "seq-1",
        viewer: { sourceKind: "agent", actorId: OTHER_AGENT },
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("任务包：非链任务拒绝、首节点非 pending 拒绝、状态推进", async () => {
    const { manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "链首", priorityTier: null, externalReference: null },
    });
    await manageController.insertTask({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 2,
      task: { taskId: "t2", title: "链中", priorityTier: 1, externalReference: null },
      anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
    });
    // 非链（t2 不依赖 t1 的相反方向）→ t1,t2 是链 [t1→t2]；[t2,t1] 不是链
    await expect(
      manageController.createTaskBundle({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        expectedRevision: 4,
        taskIds: ["t2", "t1"],
        boundAgentInstanceId: "agent-tertiary-1",
        requestedPriorityTier: 1,
      }),
    ).rejects.toMatchObject({ errorCode: "task-bundle-invalid" });
    // 合法链打包
    let sequence = await manageController.createTaskBundle({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 4,
      taskIds: ["t1", "t2"],
      boundAgentInstanceId: "agent-tertiary-1",
      requestedPriorityTier: 1,
    });
    expect(sequence.bundles).toHaveLength(1);
    expect(sequence.bundles[0]?.boundAgentInstanceId).toBe("agent-tertiary-1");
    // 打包后首节点完成 → 原链首不可再打包（非 pending）
    await manageController.transitionTaskStatus({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 6,
      taskId: "t1",
      nextStatus: "done",
      blockReason: null,
    });
    // 已完成的节点不可再打包（首节点非 pending）
    await expect(
      manageController.createTaskBundle({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        expectedRevision: 8,
        taskIds: ["t1"],
        boundAgentInstanceId: "agent-tertiary-1",
        requestedPriorityTier: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-bundle-invalid" });
    // 任务包状态推进
    sequence = await manageController.transitionBundleStatus({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 8,
      bundleId: sequence.bundles[0]!.bundleId,
      nextStatus: "active",
    });
    expect(sequence.bundles[0]?.status).toBe("active");
  });

  it("来源审计：每次变更追加认证来源条目", async () => {
    const { manageController } = makeControllers();
    const sequence = await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "用户任务", priorityTier: null, externalReference: null },
    });
    expect(sequence.auditEntries).toHaveLength(1);
    expect(sequence.auditEntries[0]).toMatchObject({
      actorSourceKind: "user",
      actorId: "user-1",
      mutationKind: "publish",
    });
    const afterInsert = await manageController.insertTask({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      expectedRevision: 2,
      task: { taskId: "t2", title: "子任务", priorityTier: 1, externalReference: null },
      anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
    });
    expect(
      afterInsert.auditEntries.find((entry) => entry.mutationKind === "insert"),
    ).toMatchObject({
      actorSourceKind: "agent",
      actorId: OWNER,
    });
  });

  it("stale revision 插入被拒绝", async () => {
    const { manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    await expect(
      manageController.insertTask({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        expectedRevision: 1,
        task: { taskId: "t2", title: "子任务", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("序列不存在时报 task-sequence-not-found", async () => {
    const { statusController } = makeControllers();
    await expect(
      statusController.getSnapshot({
        ownerAgentInstanceId: OWNER,
        sequenceId: "missing",
        viewer: { sourceKind: "agent", actorId: OWNER },
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
  });

  it("重复发布序列拒绝", async () => {
    const { manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    await expect(
      manageController.publishSequence({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        firstTask: { taskId: "t1b", title: "重复发布", priorityTier: null, externalReference: null },
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("未发布序列上插入/取消/打包报 task-sequence-not-found", async () => {
    const { manageController } = makeControllers();
    await expect(
      manageController.insertTask({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "never-published",
        expectedRevision: 0,
        task: { taskId: "t1", title: "子任务", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: [], successorTaskIds: [] },
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
    await expect(
      manageController.transitionTaskStatus({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "never-published",
        expectedRevision: 0,
        taskId: "t1",
        nextStatus: "done",
        blockReason: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
    await expect(
      manageController.createTaskBundle({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "never-published",
        expectedRevision: 0,
        taskIds: ["t1"],
        boundAgentInstanceId: "agent-tertiary-1",
        requestedPriorityTier: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
    await expect(
      manageController.transitionBundleStatus({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "never-published",
        expectedRevision: 0,
        bundleId: "bundle-ghost",
        nextStatus: "active",
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
  });

  it("任务包不存在时报 task-bundle-invalid", async () => {
    const { manageController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "agent", actorId: OWNER },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    await expect(
      manageController.transitionBundleStatus({
        ownerAgentInstanceId: OWNER,
        actor: { sourceKind: "agent", actorId: OWNER },
        sequenceId: "seq-1",
        expectedRevision: 2,
        bundleId: "bundle-ghost",
        nextStatus: "active",
      }),
    ).rejects.toMatchObject({ errorCode: "task-bundle-invalid" });
  });

  it("用户可查看任意序列（最终权威）", async () => {
    const { manageController, statusController } = makeControllers();
    await manageController.publishSequence({
      ownerAgentInstanceId: OWNER,
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    const snapshot = await statusController.getSnapshot({
      ownerAgentInstanceId: OWNER,
      sequenceId: "seq-1",
      viewer: { sourceKind: "user", actorId: "user-1" },
    });
    expect(snapshot.nodes).toHaveLength(1);
  });
});

describe("taskSequenceStatus 内置工具（harness 注入身份）", () => {
  it("Agent 经工具只能查看自己的序列快照", async () => {
    const store = new AgentTaskSequenceStore({
      baseDirectory: temporaryDirectory,
    });
    const manageController = new TaskSequenceManageController(store);
    const statusController = new TaskSequenceStatusController(store);
    await manageController.publishSequence({
      ownerAgentInstanceId: "agent-owner",
      actor: { sourceKind: "agent", actorId: "agent-owner" },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "首任务", priorityTier: null, externalReference: null },
    });
    const context = {
      workspaceBoundary: new WorkspaceBoundary(
        path.join(temporaryDirectory, "workspace"),
      ),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      requestingAgentInstanceId: "agent-owner",
      backupServicePort: null,
      vault: null,
      deletionController: null,
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: temporaryDirectory,
      }),
      taskSequenceStatusController: statusController,
    };
    const result = await executeBuiltinTool(
      "taskSequenceStatus",
      JSON.stringify({ sequenceId: "seq-1" }),
      context,
    );
    expect(result.isSideEffectFree).toBe(true);
    const snapshot = JSON.parse(result.outputText) as {
      readyTaskIds: string[];
      nodes: Array<{ taskId: string }>;
    };
    expect(snapshot.readyTaskIds).toEqual(["t1"]);
    // 未装配控制面时明确报错
    const unassembledContext = { ...context, taskSequenceStatusController: null };
    await expect(
      executeBuiltinTool(
        "taskSequenceStatus",
        JSON.stringify({ sequenceId: "seq-1" }),
        unassembledContext,
      ),
    ).rejects.toThrowError(/未装配/);
  });
});
