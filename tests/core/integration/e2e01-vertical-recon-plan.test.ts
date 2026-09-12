/**
 * E2E-01-02 切片 6：产品级 侦察 与 规划 进入纵向流程。
 *
 * - 侦察：只读侦察任务 + PROJECT_CONTEXT_DIGEST_V1 记录（来源必须已登记、
 *   文件引用不得涉敏感路径、同扫描范围旧摘要标记 stale）。
 * - 规划：主 Agent 任务插入提案（用户来源保持层级 0；Agent 来源不得占层级 0）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapCli } from "../../../packages/tui/src/cli/bootstrap.js";

let stateDirectory: string;
const RECON_AGENT = "agent-tertiary-recon-1";
const SECONDARY_AGENT = "agent-secondary-1";
const MISSION_ID = "mission-recon-plan";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-recon-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createRuntime() {
  return bootstrapCli({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
}

function sha256OfContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

describe("E2E-01-02 切片 6：产品级侦察与规划", () => {
  it("侦察：只读任务子集受控；已登记来源的 PROJECT_CONTEXT_DIGEST_V1 落盘且旧摘要转 stale", async () => {
    const runtime = await createRuntime();
    try {
      runtime.registeredAgentDirectory.registerAgent({
        agentInstanceId: RECON_AGENT,
        agentRole: "tertiary",
        missionId: MISSION_ID,
        owningSecondaryAgentInstanceId: SECONDARY_AGENT,
        boundTaskBundleId: null,
        registeredAtIso: new Date().toISOString(),
      });

      const reconTask = await runtime.reconnaissanceController.createReconnaissanceTask({
        task: {
          schemaVersion: 1,
          reconnaissanceTaskId: "recon-task-1",
          assigningSecondaryAgentInstanceId: SECONDARY_AGENT,
          scopeQuery: "E2E-01 fixture 项目结构与测试入口",
          allowedReadToolNames: ["project-read", "project-search", "project-status"],
          tokenBudget: 2000,
          createdAtIso: new Date().toISOString(),
        },
      });
      expect(reconTask.reconnaissanceTaskId).toBe("recon-task-1");

      // 非只读工具必须被拒绝（侦察只能获得最小读取子集）
      await expect(
        runtime.reconnaissanceController.createReconnaissanceTask({
          task: {
            schemaVersion: 1,
            reconnaissanceTaskId: "recon-task-evil",
            assigningSecondaryAgentInstanceId: SECONDARY_AGENT,
            scopeQuery: "越权侦察",
            allowedReadToolNames: ["project-read", "project-write"],
            tokenBudget: 2000,
            createdAtIso: new Date().toISOString(),
          },
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });

      const fixtureTaskChainPath = "tests/fixtures/e2e01/project/task-chain.json";
      const fixtureTaskChainContent = await fs.readFile(
        path.join(process.cwd(), fixtureTaskChainPath),
        "utf8",
      );
      const fingerprint = sha256OfContent(fixtureTaskChainContent);
      const digest = {
        schemaVersion: 1 as const,
        digestId: "digest-1",
        reconnaissanceAgentInstanceId: RECON_AGENT,
        scanningScope: MISSION_ID,
        keyEntryPoints: ["project/src/summarize-tasks.mjs"],
        stableContracts: ["summarizeTaskChain(tasks) -> summary"],
        relevantFileReferences: [
          { filePath: fixtureTaskChainPath, contentFingerprint: fingerprint },
        ],
        dependencyRelations: [],
        testEntryPoints: ["project/test/run-tests.mjs"],
        openQuestions: [],
        conflicts: [],
        sources: ["local-project"],
        isStale: false,
        tokenBudget: 2000,
        contentHash: sha256OfContent("EC2B1BD5-6BFF-4A9D-A6D8-4E4EFDC88E77"),
        createdAtIso: new Date().toISOString(),
        revision: 1,
      };
      await runtime.reconnaissanceController.recordDigest({ digest });

      const stored = await runtime.reconnaissanceController.listDigests();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.digestId).toBe("digest-1");
      expect(stored[0]?.reconnaissanceAgentInstanceId).toBe(RECON_AGENT);

      // 同一扫描范围的新 revision 摘要写入后，旧摘要标记 stale
      await runtime.reconnaissanceController.recordDigest({
        digest: {
          ...digest,
          digestId: "digest-2",
          revision: 2,
          createdAtIso: new Date().toISOString(),
        },
      });
      const afterSecondDigest = await runtime.reconnaissanceController.listDigests();
      const previous = afterSecondDigest.find((entry) => entry.digestId === "digest-1");
      expect(previous?.isStale).toBe(true);

      // 未登记来源必须被拒绝
      await expect(
        runtime.reconnaissanceController.recordDigest({
          digest: {
            ...digest,
            digestId: "digest-evil",
            reconnaissanceAgentInstanceId: "agent-unregistered",
          },
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });

      // 侦察来源认证必须按 mission 匹配：扫描范围与登记 mission 不一致时拒绝
      await expect(
        runtime.reconnaissanceController.recordDigest({
          digest: {
            ...digest,
            digestId: "digest-wrong-scope",
            scanningScope: "mission-other",
          },
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("规划：用户来源提案保持层级 0；Agent 来源不得占层级 0", async () => {
    const runtime = await createRuntime();
    try {
      // 先发布目标次级的任务序列（本地控制面入口），再提交插入提案
      await runtime.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: SECONDARY_AGENT,
        actor: { sourceKind: "user", actorId: "cli-user" },
        sequenceId: "sequence-1",
        firstTask: {
          taskId: "task-published-0",
          title: "既有任务",
          priorityTier: 0,
          externalReference: null,
        },
      });

      const baseProposal = {
        sequenceId: "sequence-1",
        expectedRevision: 2,
        targetSecondaryAgentInstanceId: SECONDARY_AGENT,
        task: {
          taskId: "task-planned-1",
          title: "实现 fixture 目标功能",
          priorityTier: 0,
          externalReference: null,
        },
        anchor: { predecessorTaskIds: ["task-published-0"], successorTaskIds: [] },
        acceptanceCriteria: "冻结测试通过且产物哈希与预期一致",
        createdAtIso: new Date().toISOString(),
      };

      await expect(
        runtime.controller.submitTaskInsertionProposal({
          ...baseProposal,
          proposalId: "proposal-user-1",
          sourceKind: "user",
          sourceActorId: "cli-user",
        }),
      ).resolves.toBeUndefined();

      // Agent 来源不得占层级 0（不得把模型派生节点伪装成用户层级）
      await expect(
        runtime.controller.submitTaskInsertionProposal({
          ...baseProposal,
          proposalId: "proposal-agent-evil",
          expectedRevision: 3,
          sourceKind: "agent",
          sourceActorId: "main-agent-cli",
        }),
      ).rejects.toThrow();
    } finally {
      await runtime.shutdown();
    }
  });
});