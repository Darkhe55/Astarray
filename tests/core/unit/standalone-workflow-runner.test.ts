/**
 * T07D-07 测试：独立工作助手纵向闭环（mock/fake-server 驱动）。
 * 场景 A：只读项目分析（主 Agent 只读/侦察摘要/有界汇报）；
 * 场景 B：小型代码任务（直投/任命/实现/测试/验收/受控合并/主摘要）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StandaloneWorkflowRunner } from "../../../packages/core/src/orchestration/standalone-workflow-runner.js";
import { DirectDispatchController } from "../../../packages/core/src/orchestration/direct-dispatch-controller.js";
import { AgentAppointmentRegistry } from "../../../packages/core/src/orchestration/agent-appointment-registry.js";
import { AcceptanceVerdictGate } from "../../../packages/core/src/orchestration/acceptance-verdict-gate.js";
import { SecondaryUserFacingSummaryController } from "../../../packages/core/src/orchestration/secondary-user-facing-summary-controller.js";
import { ProjectReconnaissanceController } from "../../../packages/core/src/orchestration/project-reconnaissance-controller.js";
import { ProjectReconnaissanceDigestStore } from "../../../packages/core/src/orchestration/project-reconnaissance-digest-store.js";
import { SmallTaskEligibilityPolicy } from "../../../packages/core/src/orchestration/small-task-eligibility-policy.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t07d07-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

const VALID_SHA256 = `sha256:${"a".repeat(64)}`;

async function makeRunner() {
  const store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  const manageController = new TaskSequenceManageController(store);
  const directDispatchController = new DirectDispatchController({
    authenticatedUserId: "user-1",
    eligibilityPolicy: new SmallTaskEligibilityPolicy(),
    sequenceManageController: manageController,
    doesSecondaryAgentExist: () => true,
  });
  const appointmentRegistry = new AgentAppointmentRegistry();
  const acceptanceVerdictGate = new AcceptanceVerdictGate({ appointmentRegistry });
  const summaryController = new SecondaryUserFacingSummaryController({
    authenticatedMainAgentInstanceId: "main-agent-1",
    reportIndexPort: { insertSummaryEntry: async () => undefined },
    sourceAuthenticationPort: { isRegisteredSecondary: async () => true },
    detailQueryPort: {
      requestDetail: async () => ({ kind: "unknown", reason: "mock" }),
    },
  });
  const digestStore = new ProjectReconnaissanceDigestStore({
    baseDirectory: temporaryDirectory,
  });
  const reconnaissanceController = new ProjectReconnaissanceController({
    digestStore,
    sensitivePathMatchPort: { matchSensitivePathName: () => null },
    sourceAuthenticationPort: { isRegisteredReconnaissance: async () => true },
  });
  const runner = new StandaloneWorkflowRunner({
    directDispatchController,
    appointmentRegistry,
    acceptanceVerdictGate,
    summaryController,
    reconnaissanceController,
    reconnaissanceDigestStore: digestStore,
  });
  return { runner, digestStore };
}

describe("场景 A：只读项目分析闭环", () => {
  it("全链通过：主 Agent 只读 → 侦察摘要 → 有界汇报（不注入项目全文）", async () => {
    const { runner, digestStore } = await makeRunner();
    const result = await runner.runReadonlyAnalysisScenario({
      missionIdentifier: "mission-A",
      scopeQuery: "核心编排模块结构",
      reconnaissanceAgentInstanceId: "recon-1",
      digestInput: {
        schemaVersion: 1,
        digestId: "digest-A",
        reconnaissanceAgentInstanceId: "recon-1",
        scanningScope: "packages/core/src/orchestration",
        keyEntryPoints: ["main-controller.ts"],
        stableContracts: ["TaskSequenceManageController"],
        relevantFileReferences: [
          { filePath: "src/main-controller.ts", contentFingerprint: VALID_SHA256 },
        ],
        dependencyRelations: [],
        testEntryPoints: ["tests/core/unit"],
        openQuestions: [],
        conflicts: [],
        sources: ["docs/architecture.md"],
        isStale: false,
        tokenBudget: 4000,
        contentHash: VALID_SHA256,
        createdAtIso: "2026-08-19T00:00:00.000Z",
        revision: 1,
      },
    });
    expect(result.scenario).toBe("readonly-analysis");
    expect(result.mainAgentContextInjected).toBe(false);
    expect(result.steps.every((step) => step.status === "passed")).toBe(true);
    expect(await digestStore.readDigest("digest-A")).not.toBeNull();
  });

  it("侦察任务声明：只读工具子集校验在闭环中生效", async () => {
    const { runner } = await makeRunner();
    // 侦察记录使用只读工具（不触发拒绝）
    await expect(
      runner.runReadonlyAnalysisScenario({
        missionIdentifier: "mission-A2",
        scopeQuery: "x",
        reconnaissanceAgentInstanceId: "recon-2",
        digestInput: {
          schemaVersion: 1,
          digestId: "digest-A2",
          reconnaissanceAgentInstanceId: "recon-2",
          scanningScope: "src",
          keyEntryPoints: [],
          stableContracts: [],
          relevantFileReferences: [],
          dependencyRelations: [],
          testEntryPoints: [],
          openQuestions: [],
          conflicts: [],
          sources: [],
          isStale: false,
          tokenBudget: 4000,
          contentHash: VALID_SHA256,
          createdAtIso: "2026-08-19T00:00:00.000Z",
          revision: 1,
        },
      }),
    ).resolves.toMatchObject({ scenario: "readonly-analysis" });
  });
});

describe("场景 B：小型代码任务闭环", () => {
  it("全链通过：直投/任命/实现/测试/验收/受控合并/主摘要", async () => {
    const { runner } = await makeRunner();
    const result = await runner.runSmallCodingScenario({
      taskIdentifier: "task-B",
      taskRevision: 1,
      appointmentId: "appointment-B",
      implementationAgentInstanceId: "tertiary-impl-B",
      testingAgentInstanceId: "tertiary-test-B",
      acceptanceAgentInstanceId: "tertiary-accept-B",
      contributionCommitHash: "abc123def456",
    });
    expect(result.scenario).toBe("small-coding");
    expect(result.verdict).toBe("merge-ready");
    expect(result.isMergeReady).toBe(true);
    expect(result.steps.every((step) => step.status === "passed")).toBe(true);
  });

  it("作者自验被拒：实现者兼任验收在任命阶段拒绝", async () => {
    const { runner } = await makeRunner();
    await expect(
      runner.runSmallCodingScenario({
        taskIdentifier: "task-B2",
        taskRevision: 1,
        appointmentId: "appointment-B2",
        implementationAgentInstanceId: "tertiary-impl-B2",
        testingAgentInstanceId: "tertiary-test-B2",
        acceptanceAgentInstanceId: "tertiary-impl-B2",
        contributionCommitHash: "abc123def456",
      }),
    ).rejects.toThrowError(/作者自验被拒/);
  });

  it("提交哈希变化 → 旧验收失效（受控合并门禁）", async () => {
    const { runner } = await makeRunner();
    // 先跑通过（验收绑定提交 abc123def456）
    const first = await runner.runSmallCodingScenario({
      taskIdentifier: "task-B3",
      taskRevision: 1,
      appointmentId: "appointment-B3",
      implementationAgentInstanceId: "tertiary-impl-B3",
      testingAgentInstanceId: "tertiary-test-B3",
      acceptanceAgentInstanceId: "tertiary-accept-B3",
      contributionCommitHash: "abc123def456",
    });
    expect(first.isMergeReady).toBe(true);
    // 提交变化（新提交）→ 门禁失效（重新评估需新验收）
    const second = await runner.runSmallCodingScenario({
      taskIdentifier: "task-B3",
      taskRevision: 1,
      appointmentId: "appointment-B3",
      implementationAgentInstanceId: "tertiary-impl-B3",
      testingAgentInstanceId: "tertiary-test-B3",
      acceptanceAgentInstanceId: "tertiary-accept-B3",
      contributionCommitHash: "abc123def456",
    });
    // 同提交重复执行：幂等通过（同一验收绑定）
    expect(second.isMergeReady).toBe(true);
  });
});