/**
 * GUIDE 增量：指导变更的产品入口（追加/修订/新建任务；复用 GUIDE 接收回执）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guide-change-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
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
  return facade;
}

function changeInput(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    instructionText: "追加一条验收要求",
    changeIntent: "append" as const,
    requestedTaskSequenceRevision: 1,
    ...overrides,
  };
}

describe("GUIDE 增量 产品入口", () => {
  it("追加：生成新 revision、保留历史、旧完成声明失效，并复用 GUIDE 接收回执", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.submitGuidanceChange(changeInput());
      expect(result.status).toBe("accepted");
      expect(result.changeIntent).toBe("append");
      expect(result.newTaskSequenceRevision).toBe(2);

      const history = await facade.queryGuidanceChangeHistory("task-1");
      expect(history).toHaveLength(1);
      expect(history[0]?.taskSequenceRevision).toBe(2);

      expect(
        await facade.isTaskCompletionDeclarationStillValid({
          taskIdentifier: "task-1",
          declaredTaskSequenceRevision: 1,
        }),
      ).toBe(false);
      expect(
        await facade.isTaskCompletionDeclarationStillValid({
          taskIdentifier: "task-1",
          declaredTaskSequenceRevision: 2,
        }),
      ).toBe(true);

      // 复用 GUIDE-01 接收回执：变更指导进入控制队列（受理 ≠ 已应用）
      const guidanceStatus = await facade.queryGuidanceStatus();
      expect(guidanceStatus.length).toBe(1);
      expect(guidanceStatus[0]?.status).toBe("queued");
      expect(result.guidanceIdentifier.startsWith("guide-change-")).toBe(true);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("未明确意图 → 澄清且不入队、不改 revision", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.submitGuidanceChange(
        changeInput({ changeIntent: null }),
      );
      expect(result.status).toBe("needs-clarification");
      expect(result.clarificationQuestion).toBeTruthy();
      expect(result.newTaskSequenceRevision).toBeNull();
      expect(await facade.queryGuidanceChangeHistory("task-1")).toEqual([]);
      expect(await facade.queryGuidanceStatus()).toEqual([]);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("修订必须指明受影响证据；指明后仅这些证据失效并保留历史", async () => {
    const facade = await createFacade();
    try {
      const unclear = await facade.submitGuidanceChange(
        changeInput({ changeIntent: "revise" }),
      );
      expect(unclear.status).toBe("needs-clarification");

      const revised = await facade.submitGuidanceChange(
        changeInput({
          changeIntent: "revise",
          requestedTaskSequenceRevision: 1,
          instructionText: "修订要求 A",
          invalidatedArtifactIdentifiers: ["artifact-1"],
          invalidatedAcceptanceEntryIdentifiers: ["entry-2"],
        }),
      );
      expect(revised.status).toBe("accepted");
      expect(revised.newTaskSequenceRevision).toBe(2);
      expect(revised.invalidatedArtifactIdentifiers).toEqual(["artifact-1"]);
      expect(revised.invalidatedAcceptanceEntryIdentifiers).toEqual(["entry-2"]);
      expect(await facade.queryGuidanceChangeHistory("task-1")).toHaveLength(1);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("并发变更（观察 revision 落后）→ 拒绝且不改状态", async () => {
    const facade = await createFacade();
    try {
      await facade.submitGuidanceChange(changeInput());
      const stale = await facade.submitGuidanceChange(
        changeInput({ requestedTaskSequenceRevision: 1, instructionText: "落后观察" }),
      );
      expect(stale.status).toBe("rejected");
      expect(stale.reasons.join(" ")).toContain("stale-task-sequence-revision");
      expect(await facade.queryGuidanceChangeHistory("task-1")).toHaveLength(1);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);

  it("新建无关任务：不改变既有任务 revision，独立登记", async () => {
    const facade = await createFacade();
    try {
      await facade.submitGuidanceChange(changeInput());
      const newTask = await facade.submitGuidanceChange(
        changeInput({
          changeIntent: "new-task",
          taskIdentifier: null,
          newTaskIdentifier: "task-unrelated",
          derivedTaskPriorityTier: 0,
        }),
      );
      expect(newTask.status).toBe("accepted");
      expect(newTask.newTaskSequenceRevision).toBeNull();
      expect(await facade.queryGuidanceChangeHistory("task-1")).toHaveLength(1);
      expect(await facade.queryGuidanceChangeHistory("task-unrelated")).toEqual([]);
    } finally {
      await facade.shutdown();
    }
  }, 90_000);
});
