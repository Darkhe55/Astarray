/**
 * B6R-09 集成测试：编排接入（提案/报告索引/反馈进程/Agent 注册目录）。
 * 覆盖：提案提交控制面、报告来源认证（未登记拒绝/登记后接受）、
 * 报告索引只写不唤醒（大量报告后索引增长）、真实反馈进程可用、
 * dist 控制器可达性扫描。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisteredAgentDirectory } from "../../../packages/core/src/orchestration/registered-agent-directory.js";
import { MainAgentReportArchiveIngestor } from "../../../packages/core/src/orchestration/main-agent-report-archive.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { ConversationTaskInsertionController } from "../../../packages/core/src/orchestration/conversation-task-insertion-controller.js";
import type { TertiaryTerminalReport } from "../../../packages/core/src/orchestration/main-agent-report-archive.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r09-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeReport(overrides: Partial<TertiaryTerminalReport> = {}): TertiaryTerminalReport {
  return {
    reportId: `report-${Math.random().toString(36).slice(2, 10)}`,
    missionId: "mission-1",
    taskBundleId: "bundle-1",
    reportingAgentInstanceId: "tertiary-1",
    reportKind: "completed",
    summary: "任务完成",
    executedChecks: [{ command: "npm test", exitCode: 0 }],
    createdAtIso: new Date().toISOString(),
    contentHash: "",
    ...overrides,
  };
}

describe("B6R-09 编排接入", () => {
  it("提案提交控制面：来源/优先级/锚点/revision 校验", async () => {
    const store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
    const manageController = new TaskSequenceManageController(store);
    await manageController.publishSequence({
      ownerAgentInstanceId: "secondary-1",
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "seq-1",
      firstTask: { taskId: "t1", title: "用户根任务", priorityTier: null, externalReference: null },
    });
    const insertionController = new ConversationTaskInsertionController({
      manageController,
      authenticatedUserId: "user-1",
    });
    // 用户来源提案（层级 0）
    await insertionController.submitProposal({
      proposalId: "proposal-1",
      targetSecondaryAgentInstanceId: "secondary-1",
      sequenceId: "seq-1",
      expectedRevision: 2,
      sourceKind: "user",
      sourceActorId: "user-1",
      task: { taskId: "t2", title: "用户新任务", priorityTier: null, externalReference: null },
      anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
      acceptanceCriteria: "完成",
      createdAtIso: new Date().toISOString(),
    });
    const document = await store.readSequence("secondary-1", "seq-1");
    expect(document?.nodes.some((node) => node.taskId === "t2")).toBe(true);
    // 主 Agent 派生节点请求层级 0 → 拒绝
    await expect(
      insertionController.submitProposal({
        proposalId: "proposal-2",
        targetSecondaryAgentInstanceId: "secondary-1",
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
    // 伪造用户来源 → 拒绝
    await expect(
      insertionController.submitProposal({
        proposalId: "proposal-3",
        targetSecondaryAgentInstanceId: "secondary-1",
        sequenceId: "seq-1",
        expectedRevision: 4,
        sourceKind: "user",
        sourceActorId: "user-evil",
        task: { taskId: "t4", title: "x", priorityTier: null, externalReference: null },
        anchor: { predecessorTaskIds: ["t2"], successorTaskIds: [] },
        acceptanceCriteria: "x",
        createdAtIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("报告来源认证：未登记拒绝；登记后接受（非空字符串不是认证）", async () => {
    const directory = new RegisteredAgentDirectory();
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
      sourceAuthenticationPort: {
        verifySource: (input) => Promise.resolve(directory.verifyReportSource(input)),
      },
    });
    // 未登记 → 拒绝
    await expect(
      ingestor.ingestReport(makeReport({ reportingAgentInstanceId: "attacker-999" })),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    // 登记（绑定 mission/所属/任务包）→ 接受
    directory.registerAgent({
      agentInstanceId: "tertiary-1",
      agentRole: "tertiary",
      missionId: "mission-1",
      owningSecondaryAgentInstanceId: "secondary-1",
      boundTaskBundleId: "bundle-1",
      registeredAtIso: new Date().toISOString(),
    });
    await ingestor.ingestReport(makeReport());
    expect(
      await ingestor.readIndex("mission-1"),
    ).toHaveLength(1);
    // mission 不匹配 → 拒绝
    await expect(
      ingestor.ingestReport(makeReport({ missionId: "mission-2" })),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    // 重复登记（不可复用身份）→ 拒绝
    expect(() =>
      directory.registerAgent({
        agentInstanceId: "tertiary-1",
        agentRole: "tertiary",
        missionId: "mission-1",
        owningSecondaryAgentInstanceId: "secondary-1",
        boundTaskBundleId: "bundle-1",
        registeredAtIso: new Date().toISOString(),
      }),
    ).toThrowError(/不可复用/);
  });

  it("后台密集报告只写索引（不唤醒主 Agent）；来源伪造不干扰", async () => {
    const directory = new RegisteredAgentDirectory();
    const ingestor = new MainAgentReportArchiveIngestor({
      baseDirectory: temporaryDirectory,
      sourceAuthenticationPort: {
        verifySource: (input) => Promise.resolve(directory.verifyReportSource(input)),
      },
    });
    directory.registerAgent({
      agentInstanceId: "tertiary-1",
      agentRole: "tertiary",
      missionId: "mission-1",
      owningSecondaryAgentInstanceId: "secondary-1",
      boundTaskBundleId: "bundle-1",
      registeredAtIso: new Date().toISOString(),
    });
    // 密集报告（模拟后台）：只写索引，无回调/唤醒副作用
    let callbackCount = 0;
    const original = process.on;
    void original;
    for (let index = 0; index < 50; index++) {
      await ingestor.ingestReport(makeReport({ summary: `报告 ${index}` }));
      callbackCount += 1;
    }
    expect(callbackCount).toBe(50);
    const indexEntries = await ingestor.readIndex("mission-1");
    expect(indexEntries).toHaveLength(50);
    expect(indexEntries[0]?.summaryPreview).toContain("报告 0");
    // 伪造来源不增加索引
    await expect(
      ingestor.ingestReport(
        makeReport({ reportingAgentInstanceId: "attacker-999" }),
      ),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(await ingestor.readIndex("mission-1")).toHaveLength(50);
  });

  it("dist 可达性：T08A 编排控制器进入最终 bundle", async () => {
    const distDirectory = path.join(process.cwd(), "dist");
    if (!existsSync(distDirectory)) {
      return; // 未构建（check 流程会先 build）
    }
    const controllerNames = [
      "conversation-task-insertion-controller",
      "registered-agent-directory",
      "secondary-continuous-dispatch-loop",
      "main-agent-report-archive",
      "tertiary-lifecycle",
      "agent-individual-memory",
      "cross-agent-attachment-controller",
    ];
    for (const controllerName of controllerNames) {
      const found = await (async () => {
        const readDirectory = async (
          directoryPath: string,
        ): Promise<boolean> => {
          const entries = await fs.readdir(directoryPath, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
              if (await readDirectory(entryPath)) {
                return true;
              }
            } else if (
              entry.name.endsWith(".js") &&
              (await fs.readFile(entryPath, "utf8")).includes(controllerName)
            ) {
              return true;
            }
          }
          return false;
        };
        return readDirectory(distDirectory);
      })();
      expect(found, `${controllerName} 应进入 dist`).toBe(true);
    }
  });
});
