/**
 * GUIDE 增量 02b：新任务插入任务偏序集（复用 insertTask 与优先级规则）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guide-poset-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createFacadeAndPublishSequence(): Promise<{
  facade: AstarrayApplicationFacade;
  sequenceStore: AgentTaskSequenceStore;
  initialSequenceRevision: number;
}> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory: baseDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    streamOutput: () => {},
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  const facade = new AstarrayApplicationFacade(runtime, {
    statusPollIntervalMilliseconds: 20,
    stateDirectory: baseDirectory,
  });
  facade.createSession({ sessionId: "session-1", mode: "assist" });
  const publishedDocument =
    await runtime.taskSequenceManageController.publishSequence({
      ownerAgentInstanceId: "secondary-1",
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "seq-1",
      firstTask: {
        taskId: "task-existing",
        title: "既有任务",
        priorityTier: null,
        externalReference: null,
      },
    });
  return {
    facade,
    sequenceStore: new AgentTaskSequenceStore({ baseDirectory }),
    initialSequenceRevision: publishedDocument.revision,
  };
}

function insertionChangeInput(
  initialSequenceRevision: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: null,
    instructionText: "新建独立任务：补充回归测试",
    changeIntent: "new-task" as const,
    requestedTaskSequenceRevision: 1,
    newTaskIdentifier: "task-new",
    derivedTaskPriorityTier: 0,
    insertionTarget: {
      ownerAgentInstanceId: "secondary-1",
      sequenceId: "seq-1",
      expectedSequenceRevision: initialSequenceRevision,
      predecessorTaskIds: ["task-existing"],
      successorTaskIds: [],
    },
    ...overrides,
  };
}

describe("GUIDE 增量 02b 任务偏序集插入", () => {
  it("new-task：插入次级序列、用户层级 0、序列 revision +1", async () => {
    const { facade, sequenceStore, initialSequenceRevision } =
      await createFacadeAndPublishSequence();
    try {
      const result = await facade.submitGuidanceChange(
        insertionChangeInput(initialSequenceRevision),
      );
      expect(result.status).toBe("accepted");
      expect(result.insertedSequenceRevision).toBeGreaterThan(
        initialSequenceRevision,
      );

      const sequence = await sequenceStore.readSequence("secondary-1", "seq-1");
      expect(sequence?.revision).toBe(result.insertedSequenceRevision);
      const insertedNode = sequence?.nodes.find((node) => node.taskId === "task-new");
      expect(insertedNode?.priorityTier).toBe(0);
      expect(insertedNode?.dependsOn ?? []).toContain("task-existing");
    } finally {
      await facade.shutdown();
    }
  }, 120_000);

  it("new-task 缺少插入目标 → 澄清，且不插入、不改序列", async () => {
    const { facade, sequenceStore, initialSequenceRevision } =
      await createFacadeAndPublishSequence();
    try {
      const result = await facade.submitGuidanceChange(
        insertionChangeInput(initialSequenceRevision, { insertionTarget: null }),
      );
      expect(result.status).toBe("needs-clarification");
      expect(result.insertedSequenceRevision).toBeNull();
      expect(result.clarificationQuestion).toContain("agentInstanceId");
      const sequence = await sequenceStore.readSequence("secondary-1", "seq-1");
      expect(sequence?.revision).toBe(initialSequenceRevision);
      expect(sequence?.nodes.map((node) => node.taskId)).toEqual(["task-existing"]);
      expect(await facade.queryGuidanceChangeHistory("task-new")).toEqual([]);
    } finally {
      await facade.shutdown();
    }
  }, 120_000);

  it("并发序列 revision 落后 → 拒绝插入，且不登记变更意图", async () => {
    const { facade, sequenceStore, initialSequenceRevision } =
      await createFacadeAndPublishSequence();
    try {
      const result = await facade.submitGuidanceChange(
        insertionChangeInput(initialSequenceRevision, {
          insertionTarget: {
            ownerAgentInstanceId: "secondary-1",
            sequenceId: "seq-1",
            expectedSequenceRevision: initialSequenceRevision - 1,
          },
        }),
      );
      expect(result.status).toBe("rejected");
      expect(result.reasons.join(" ")).toContain("task-insertion-failed");
      const sequence = await sequenceStore.readSequence("secondary-1", "seq-1");
      expect(sequence?.revision).toBe(initialSequenceRevision);
      expect(await facade.queryGuidanceChangeHistory("task-new")).toEqual([]);
    } finally {
      await facade.shutdown();
    }
  }, 120_000);

  it("重复任务标识插入被拒绝，序列保持不变", async () => {
    const { facade, sequenceStore, initialSequenceRevision } =
      await createFacadeAndPublishSequence();
    try {
      const result = await facade.submitGuidanceChange(
        insertionChangeInput(initialSequenceRevision, {
          newTaskIdentifier: "task-existing",
        }),
      );
      expect(result.status).toBe("rejected");
      expect(result.reasons.join(" ")).toContain("task-insertion-failed");
      const sequence = await sequenceStore.readSequence("secondary-1", "seq-1");
      expect(sequence?.revision).toBe(initialSequenceRevision);
    } finally {
      await facade.shutdown();
    }
  }, 120_000);
});
