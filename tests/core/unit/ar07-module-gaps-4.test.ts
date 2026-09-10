/**
 * AR-07 批次3.1：剩余小缺口与防御分支补测。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CurrentPermissionSelectionStore } from "../../../packages/core/src/tools/current-permission-selection.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { AgentRunWatchdog } from "../../../packages/core/src/orchestration/agent-run-watchdog.js";
import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";
import { ReadSuppressionLedger } from "../../../packages/core/src/tools/read-suppression-ledger.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07d-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
});

function buildWrapper(overrides: Record<string, unknown> = {}): PolicyWrapper {
  const modeMachine = new ModeMachine("assist");
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
    registry,
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => 1_000_000,
    getCurrentMode: () => modeMachine.getCurrentMode(),
    protectedStoragePolicy: new ProtectedStoragePolicy({ stateDirectoryPath: temporaryDirectory }),
    ...overrides,
  });
}

const profileReference = {
  permissionProfileId: "builtin:assist",
  displayName: "assist",
  isBuiltin: true,
  revision: 1,
  catalogVersion: 1,
};

describe("AR-07 批次3.1：默认时钟与空表分支", () => {
  it("AgentRunWatchdog 默认构造后 assess 使用默认时钟且健康", () => {
    const watchdog = new AgentRunWatchdog();
    expect(watchdog.assess().status).toBe("healthy");
  });

  it("CurrentPermissionSelectionStore 空存储切换报 stale-revision（revision 0）", async () => {
    const store = new CurrentPermissionSelectionStore({ baseDirectory: temporaryDirectory });
    await expect(
      store.switchSelection({
        selectedReference: { kind: "builtin", profileId: "assist" },
        expectedRevision: 1,
      } as never),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("ReadSuppressionLedger 默认时钟查询与非法路径 fail-closed", async () => {
    const ledger = new ReadSuppressionLedger();
    const filePath = path.join(temporaryDirectory, "read.txt");
    await fs.writeFile(filePath, "内容", "utf8");
    const decision = await ledger.querySuppression({
      agentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      canonicalPath: filePath,
      operationKind: "read-file",
      normalizedRange: "full",
      parameterHash: "hash-1",
    } as never);
    expect(decision.isSuppressed).toBe(false);
    await expect(
      ledger.querySuppression({
        agentInstanceId: "agent-a",
        taskExecutionId: "task-1",
        canonicalPath: "C:\\bad\u0000name",
        operationKind: "read-file",
        normalizedRange: "full",
        parameterHash: "hash-2",
      } as never),
    ).rejects.toThrow();
  });

  it("PermissionCapabilityCatalog 已映射工具缺省决策为 deny", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.evaluateToolPermission({ toolName: "readFile", capabilityDecisions: {} })).toBe(
      "deny",
    );
  });

  it("UnboundedAgentInstanceRegistry 缺省回调与缺失状态", () => {
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 1,
      maxQueueLength: 0,
    });
    const instance = registry.createInstance({ agentRole: "tertiary", missionId: "mission-1" });
    expect(registry.requestAdmission(instance.agentInstanceId).state).toBeDefined();
    expect(registry.getState("missing-agent")).toBeNull();
    expect(() => registry.recycleInstance(instance.agentInstanceId)).toThrow();
  });
});

describe("AR-07 批次3.1：PolicyWrapper 防御分支", () => {
  it("已取消信号直接返回 provider-cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await buildWrapper().execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-abort",
      controller.signal,
    );
    expect(result).toMatchObject({ errorCode: "provider-cancelled" });
  });

  it("装配引擎与权限组引用时授予会话授权成功", async () => {
    const grantSessionAuthorization = vi.fn(async () => {});
    const wrapper = buildWrapper({
      configurablePermissionPolicyEngine: {
        decide: async () => ({ decision: "allow" }),
        grantSessionAuthorization,
      } as never,
      currentPermissionProfileReference: profileReference,
    });
    await wrapper.grantConfigurableSessionAuthorization({
      toolName: "project.read",
      argumentsJson: "{}",
    } as never);
    expect(grantSessionAuthorization).toHaveBeenCalledTimes(1);
  });

  it("装配审计通道时 ask 决策写入审计", async () => {
    const record = vi.fn();
    const wrapper = buildWrapper({
      configurablePermissionPolicyEngine: { decide: async () => ({ decision: "ask" }) } as never,
      currentPermissionProfileReference: profileReference,
      auditSink: record,
    });
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-ask",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "error", errorCode: "permission-ask-pending" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ decision: "ask", toolName: "readFile" });
  });

  it("已注册但非内置实现 → tool-execution-failed（防御分支）", async () => {
    const modeMachine = new ModeMachine("assist");
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const internals = registry as unknown as {
      descriptorsByName: Map<string, unknown>;
    };
    internals.descriptorsByName.set("notBuiltinTool", {
      name: "notBuiltinTool",
      category: "readonly",
      mutationKind: "none",
      description: "注册但无内置实现",
      inputSchemaJson: "{}",
      backupPolicy: "none",
      toolNames: [],
    });
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
      registry,
      workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => 1_000_000,
      getCurrentMode: () => modeMachine.getCurrentMode(),
      protectedStoragePolicy: new ProtectedStoragePolicy({ stateDirectoryPath: temporaryDirectory }),
    });
    const result = await wrapper.execute(
      "notBuiltinTool",
      "{}",
      "call-defensive",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ errorCode: "tool-execution-failed" });
  });
});
