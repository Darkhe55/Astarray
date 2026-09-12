/**
 * E2E-01-02 切片 7：纵向闭环运行器的公共入口（workflow run）。
 * 验收：场景 A（只读分析：提案→侦察→摘要→主 Agent 只读摘要，不注入项目全文）；
 * 场景 B（代码任务：任命实现/测试/验收三身份→验收裁决→受控合并门禁→主 Agent 摘要）；
 * 作者不能自验（同一身份任命必须被拒绝）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeWorkflowScenarioCommand } from "../../../packages/tui/src/cli/commands.js";

class ProcessExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super("process.exit:" + exitCode);
  }
}

let stateDirectory: string;
let stdoutBuffer: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-e2e01-workflow-"));
  stdoutBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutBuffer.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code ?? 0);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function writeDigestFile(): Promise<string> {
  const fixtureContent = await fs.readFile(
    path.join(process.cwd(), "tests/fixtures/e2e01/project/task-chain.json"),
    "utf8",
  );
  const digestPath = path.join(stateDirectory, "digest.json");
  await fs.writeFile(
    digestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        digestId: "digest-workflow-1",
        reconnaissanceAgentInstanceId: "agent-tertiary-recon-1",
        scanningScope: "mission-workflow",
        keyEntryPoints: ["project/src/summarize-tasks.mjs"],
        stableContracts: ["summarizeTaskChain(tasks) -> summary"],
        relevantFileReferences: [
          {
            filePath: "tests/fixtures/e2e01/project/task-chain.json",
            contentFingerprint:
              "sha256:" + createHash("sha256").update(fixtureContent).digest("hex"),
          },
        ],
        dependencyRelations: [],
        testEntryPoints: ["project/test/run-tests.mjs"],
        openQuestions: [],
        conflicts: [],
        sources: ["local-project"],
        isStale: false,
        tokenBudget: 2000,
        contentHash: "sha256:" + "b".repeat(64),
        createdAtIso: new Date().toISOString(),
        revision: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
  return digestPath;
}

describe("E2E-01-02 切片 7：workflow run 公共入口", () => {
  it("场景 A：只读分析闭环，摘要受控且不向主 Agent 注入项目全文", async () => {
    const digestFilePath = await writeDigestFile();
    const exitCode = await executeWorkflowScenarioCommand({
      stateDirectory,
      scenario: "readonly-analysis",
      missionIdentifier: "mission-workflow",
      scopeQuery: "fixture 项目结构与测试入口",
      digestFilePath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdoutBuffer.join("")) as {
      scenario: string;
      steps: Array<{ step: string; status: string }>;
      digestReference: string;
      mainAgentContextInjected: boolean;
    };
    expect(result.scenario).toBe("readonly-analysis");
    expect(result.steps.every((step) => step.status === "passed")).toBe(true);
    expect(result.digestReference).toBe("digest-workflow-1");
    expect(result.mainAgentContextInjected).toBe(false);
  });

  it("场景 B：三身份任命 → 验收裁决 → 受控合并门禁满足", async () => {
    const exitCode = await executeWorkflowScenarioCommand({
      stateDirectory,
      scenario: "small-coding",
      taskIdentifier: "task-workflow",
      taskRevision: 1,
      appointmentId: "appointment-1",
      implementationAgentInstanceId: "agent-impl-1",
      testingAgentInstanceId: "agent-test-1",
      acceptanceAgentInstanceId: "agent-accept-1",
      contributionCommitHash: "c".repeat(40),
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdoutBuffer.join("")) as {
      scenario: string;
      appointmentId: string;
      verdict: string | null;
      isMergeReady: boolean;
      steps: Array<{ step: string; status: string }>;
    };
    expect(result.scenario).toBe("small-coding");
    expect(result.appointmentId).toBe("appointment-1");
    expect(result.verdict).toBe("merge-ready");
    expect(result.isMergeReady).toBe(true);
    expect(result.steps.every((step) => step.status === "passed")).toBe(true);
  });

  it("场景 B：实现者与验收者同一身份时必须被拒绝（作者不能自验）", async () => {
    await expect(
      executeWorkflowScenarioCommand({
        stateDirectory,
        scenario: "small-coding",
        taskIdentifier: "task-self-verify",
        appointmentId: "appointment-self",
        implementationAgentInstanceId: "agent-same",
        testingAgentInstanceId: "agent-test-1",
        acceptanceAgentInstanceId: "agent-same",
        contributionCommitHash: "d".repeat(40),
        isJsonOutput: true,
      }),
    ).rejects.toThrow("process.exit:1");
  });
});
