/**
 * AUTH-SCOPE-03：工具执行前门禁、单次授权与重放零副作用、运行时接线。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  ScopeAuthorizationGate,
  ScopeGatedToolPort,
} from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { RegisteredProjectRoot } from "../../../packages/core/src/tools/scope-resolution.js";
import type { ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

const NOW = "2026-09-16T00:00:00.000Z";
let baseDirectory: string;
let projectRoot: RegisteredProjectRoot;
let outsideDirectoryPath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-scope-gate-"));
  await fs.mkdir(path.join(baseDirectory, "project"), { recursive: true });
  outsideDirectoryPath = path.join(baseDirectory, "outside");
  await fs.mkdir(outsideDirectoryPath, { recursive: true });
  projectRoot = {
    projectIdentifier: "P",
    rootPath: path.join(baseDirectory, "project"),
  };
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function createGate(overrides: {
  mode?: "ponder" | "assist" | "devolve";
  configuredDecision?: "deny" | "ask" | "allow";
  isInstallationEnabled?: boolean;
  superiorApproval?: (input: { scopeClass: string }) => Promise<{
    isApproved: boolean;
    approvedByAgentInstanceId: string | null;
  }>;
}) {
  const superiorCalls: string[] = [];
  const gate = new ScopeAuthorizationGate({
    getMode: () => overrides.mode ?? "assist",
    getRegisteredProjectRoots: () => [projectRoot],
    getConfiguredDecision: () => overrides.configuredDecision ?? "ask",
    isInstallationEnabled: () => overrides.isInstallationEnabled ?? false,
    getAuthorizationRevision: () => 1,
    nowIso: () => NOW,
    superiorApprovalPort: {
      approve: async (input) => {
        superiorCalls.push(input.scopeClass);
        if (overrides.superiorApproval !== undefined) {
          return overrides.superiorApproval(input);
        }
        return { isApproved: false, approvedByAgentInstanceId: null };
      },
    },
  });
  return { gate, superiorCalls };
}

function createCountingToolPort(): { port: ToolPort; executionCount: () => number } {
  let count = 0;
  return {
    executionCount: () => count,
    port: {
      async execute(): Promise<ToolCallResult> {
        count += 1;
        return {
          kind: "success",
          callId: "call-1",
          outputText: "written",
          isSideEffectFree: false,
        };
      },
    },
  };
}

describe("AUTH-SCOPE-03 范围授权门禁", () => {
  it("放权模式项目内写入默认无人工等待（不问上级）", async () => {
    const { gate, superiorCalls } = createGate({ mode: "devolve", configuredDecision: "allow" });
    const outcome = await gate.authorizeForExecution({
      operationKind: "project-file-write",
      targetPath: path.join(projectRoot.rootPath, "a.txt"),
    });
    expect(outcome.isAllowed).toBe(true);
    expect(outcome.resolution.scopeClass).toBe("S1-project-internal");
    expect(outcome.record?.adjudicator).toBe("local-readonly-policy");
    expect(superiorCalls).toEqual([]);
  });

  it("协同模式项目内写入由本地上级批准并留回执", async () => {
    const { gate, superiorCalls } = createGate({
      mode: "assist",
      configuredDecision: "ask",
      superiorApproval: async () => ({
        isApproved: true,
        approvedByAgentInstanceId: "secondary-1",
      }),
    });
    const outcome = await gate.authorizeForExecution({
      operationKind: "project-file-write",
      targetPath: path.join(projectRoot.rootPath, "a.txt"),
    });
    expect(outcome.isAllowed).toBe(true);
    expect(superiorCalls).toEqual(["S1-project-internal"]);
    expect(outcome.record).toMatchObject({
      adjudicator: "superior-agent",
      approvedByAgentInstanceId: "secondary-1",
    });
    expect(outcome.record?.consumedAtIso).not.toBeNull();
  });

  it("协同模式项目外写入等待认证用户授权（不执行）", async () => {
    const { gate, superiorCalls } = createGate({ mode: "assist", configuredDecision: "allow" });
    const outcome = await gate.authorizeForExecution({
      operationKind: "project-file-write",
      targetPath: path.join(outsideDirectoryPath, "b.txt"),
    });
    expect(outcome.isAllowed).toBe(false);
    expect(outcome.errorCode).toBe("auth-scope-awaiting-user-authorization");
    expect(outcome.resolution.scopeClass).toBe("S3-project-external");
    expect(superiorCalls).toEqual([]);
  });

  it("单次授权只生效一次；重放被拒绝且内层工具不被触达", async () => {
    const { gate } = createGate({ mode: "assist", configuredDecision: "allow" });
    const operation = {
      operationKind: "project-file-write" as const,
      targetPath: path.join(outsideDirectoryPath, "c.txt"),
    };
    await gate.grantUserAuthorization({ operation, approvedByUserId: "user-1" });
    const counting = createCountingToolPort();
    const gatedPort = new ScopeGatedToolPort(counting.port, gate);

    const first = await gatedPort.execute(
      "createProjectFile",
      JSON.stringify({ path: operation.targetPath, content: "x" }),
      "call-1",
      new AbortController().signal,
    );
    expect(first.kind).toBe("success");
    const second = await gatedPort.execute(
      "createProjectFile",
      JSON.stringify({ path: operation.targetPath, content: "x" }),
      "call-2",
      new AbortController().signal,
    );
    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      expect(second.errorCode).toBe("auth-scope-replay-rejected");
    }
    expect(counting.executionCount()).toBe(1);
  });

  it("过期授权被拒绝（auth-scope-authorization-expired）", async () => {
    const { gate } = createGate({ mode: "assist", configuredDecision: "allow" });
    const operation = {
      operationKind: "project-file-write" as const,
      targetPath: path.join(outsideDirectoryPath, "d.txt"),
    };
    await gate.grantUserAuthorization({
      operation,
      approvedByUserId: "user-1",
      expiresAtIso: "2026-09-15T23:59:59.000Z",
    });
    const outcome = await gate.authorizeForExecution(operation);
    expect(outcome.isAllowed).toBe(false);
    expect(outcome.errorCode).toBe("auth-scope-authorization-expired");
  });

  it("deny 优先：所有模式与范围一律拒绝且不触达内层工具", async () => {
    for (const mode of ["ponder", "assist", "devolve"] as const) {
      const { gate } = createGate({ mode, configuredDecision: "deny" });
      const counting = createCountingToolPort();
      const gatedPort = new ScopeGatedToolPort(counting.port, gate);
      const result = await gatedPort.execute(
        "createProjectFile",
        JSON.stringify({ path: path.join(projectRoot.rootPath, "e.txt") }),
        "call-1",
        new AbortController().signal,
      );
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.errorCode).toBe("auth-scope-denied");
      }
      expect(counting.executionCount()).toBe(0);
    }
  });

  it("思索模式：只读放行、写入拒绝", async () => {
    const { gate } = createGate({ mode: "ponder", configuredDecision: "allow" });
    const read = await gate.authorizeForExecution({
      operationKind: "project-file-read",
      targetPath: path.join(projectRoot.rootPath, "readme.md"),
    });
    expect(read.isAllowed).toBe(true);
    const write = await gate.authorizeForExecution({
      operationKind: "project-file-write",
      targetPath: path.join(projectRoot.rootPath, "f.txt"),
    });
    expect(write.isAllowed).toBe(false);
    expect(write.errorCode).toBe("auth-scope-denied");
  });

  it("未知范围与安装类：人工/开关约束生效", async () => {
    const { gate, superiorCalls } = createGate({ mode: "assist", configuredDecision: "allow" });
    const unknown = await gate.authorizeForExecution({
      operationKind: "project-file-write",
      targetPath: path.join(projectRoot.rootPath, "*.txt"),
    });
    expect(unknown.resolution.scopeClass).toBe("S4-unknown");
    expect(unknown.errorCode).toBe("auth-scope-awaiting-user-authorization");
    expect(superiorCalls).toEqual([]);

    const installOff = await gate.authorizeForExecution({
      operationKind: "dependency-install",
    });
    expect(installOff.errorCode).toBe("auth-scope-denied");

    const { gate: gateOn } = createGate({
      mode: "assist",
      configuredDecision: "allow",
      isInstallationEnabled: true,
    });
    const installOn = await gateOn.authorizeForExecution({
      operationKind: "dependency-install",
    });
    expect(installOn.errorCode).toBe("auth-scope-awaiting-user-authorization");
  });

  it("预演不消费授权、不写记录", async () => {
    const { gate } = createGate({ mode: "assist", configuredDecision: "ask" });
    const preview = await gate.previewDecision({
      operationKind: "project-file-write",
      targetPath: path.join(projectRoot.rootPath, "g.txt"),
    });
    expect(preview.decision).toBe("ask-superior");
    expect(gate.listDecisionRecords()).toEqual([]);
  });

  it("运行时接线：登记工程根取代 cwd，公共入口可预演与授权", async () => {
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
      workspaceRootPath: projectRoot.rootPath,
      projectIdentifier: "P",
    });
    const facade = new AstarrayApplicationFacade(runtime, {
      statusPollIntervalMilliseconds: 20,
      stateDirectory: baseDirectory,
    });
    facade.createSession({ sessionId: "session-1", mode: "assist" });
    try {
      // 登记根与 cwd 不同：范围判定必须用登记根。
      expect(facade.listRegisteredProjectRoots()).toEqual([
        { projectIdentifier: "P", rootPath: path.join(baseDirectory, "project") },
      ]);
      expect(process.cwd()).not.toBe(path.join(baseDirectory, "project"));

      const inside = await facade.evaluateOperationScope({
        operationKind: "project-file-write",
        targetPath: path.join(projectRoot.rootPath, "h.txt"),
      });
      expect(inside.scopeClass).toBe("S1-project-internal");
      expect(inside.projectIdentifier).toBe("P");

      const outside = await facade.evaluateOperationScope({
        operationKind: "project-file-write",
        targetPath: path.join(outsideDirectoryPath, "i.txt"),
      });
      expect(outside.scopeClass).toBe("S3-project-external");
      expect(outside.decision).toBe("ask-user");

      const grant = await facade.grantScopeAuthorization({
        operationKind: "project-file-write",
        targetPath: path.join(outsideDirectoryPath, "i.txt"),
        approvedByUserId: "user-1",
      });
      expect(grant.operationFingerprint).toBe(outside.operationFingerprint);
      expect(facade.queryScopeAuthorizations()).toHaveLength(1);
    } finally {
      await facade.shutdown();
    }
  }, 60_000);
});
