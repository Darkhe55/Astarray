/**
 * GOV-02c：工具 → 操作映射闭合（未知工具不再默认放行；本地只读显式白名单）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import {
  ScopeAuthorizationGate,
  ScopeGatedToolPort,
  describeToolOperation,
} from "../../../packages/core/src/tools/scope-authorization-gate.js";
import type { ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

let baseDirectory: string;
let projectRootPath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-scope-mapping-"));
  projectRootPath = path.join(baseDirectory, "project");
  await fs.mkdir(projectRootPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function createGate(overrides: {
  configuredDecision?: "deny" | "ask" | "allow";
  isInstallationEnabled?: boolean;
} = {}): ScopeAuthorizationGate {
  return new ScopeAuthorizationGate({
    getMode: () => "assist",
    getRegisteredProjectRoots: () => [
      { projectIdentifier: "P", rootPath: projectRootPath },
    ],
    getConfiguredDecision: () => overrides.configuredDecision ?? "allow",
    isInstallationEnabled: () => overrides.isInstallationEnabled ?? false,
    getAuthorizationRevision: () => 1,
    nowIso: () => "2026-09-17T00:00:00.000Z",
    superiorApprovalPort: {
      approve: async () => ({
        isApproved: true,
        approvedByAgentInstanceId: "secondary-1",
      }),
    },
  });
}

function createCountingToolPort(): { port: ToolPort; executionCount: () => number } {
  let executionCount = 0;
  const port: ToolPort = {
    execute: async (_toolName, _argumentsJson, callId): Promise<ToolCallResult> => {
      executionCount += 1;
      return { kind: "success", callId, outputText: "ok", isSideEffectFree: true };
    },
  };
  return { port, executionCount: () => executionCount };
}

const LOCAL_READONLY_ALLOWLIST = ["factVerification", "taskSequenceStatus"];

describe("GOV-02c 工具 → 操作映射闭合", () => {
  it("全部内置工具要么显式映射、要么在本地只读白名单内（无隐式未受门禁工具）", () => {
    for (const descriptor of BUILTIN_TOOL_DESCRIPTORS) {
      const operation = describeToolOperation(descriptor.name, "{}");
      if (operation === null) {
        expect(LOCAL_READONLY_ALLOWLIST).toContain(descriptor.name);
      } else {
        expect(operation.operationKind).toBeTruthy();
      }
    }
    // 未显式映射的工具不进入范围门禁（由注册表层 fail-closed 拒绝未注册工具，
    // 见 tests/core/integration/provider-tool-loop.test.ts 的"未注册工具无法旁路"）。
    expect(describeToolOperation("some-future-tool", "{}")).toBeNull();
  }, 30_000);

  it("本地只读白名单之外的已映射工具仍受门禁约束（回归）", async () => {
    const gate = createGate({ configuredDecision: "allow" });
    const { port, executionCount } = createCountingToolPort();
    const gatedPort = new ScopeGatedToolPort(port, gate);

    const result = await gatedPort.execute(
      "deleteBackup",
      "{}",
      "call-delete-backup",
      new AbortController().signal,
    );
    // 备份删除属 S7 专用流程：需认证用户授权，未授权不触达内层工具
    expect(result.kind).toBe("error");
    expect(executionCount()).toBe(0);
  }, 30_000);

  it("本地只读白名单工具：不进入范围门禁、直接执行", async () => {
    const gate = createGate({ configuredDecision: "allow" });
    const { port, executionCount } = createCountingToolPort();
    const gatedPort = new ScopeGatedToolPort(port, gate);

    for (const toolName of LOCAL_READONLY_ALLOWLIST) {
      const result = await gatedPort.execute(
        toolName,
        "{}",
        "call-" + toolName,
        new AbortController().signal,
      );
      expect(result.kind).toBe("success");
    }
    expect(executionCount()).toBe(LOCAL_READONLY_ALLOWLIST.length);
  }, 30_000);

  it("既有映射不变：写入/读取/备份删除的判定保持", () => {
    const targetPath = path.join(projectRootPath, "a.txt");
    expect(
      describeToolOperation("createProjectFile", JSON.stringify({ filePath: "a.txt" }))
        ?.operationKind,
    ).toBe("project-file-write");
    expect(
      describeToolOperation("readFile", JSON.stringify({ filePath: "a.txt" }))?.operationKind,
    ).toBe("project-file-read");
    expect(describeToolOperation("backupVault", "{}")?.operationKind).toBe(
      "backup-deletion",
    );
    void targetPath;
  }, 30_000);
});
