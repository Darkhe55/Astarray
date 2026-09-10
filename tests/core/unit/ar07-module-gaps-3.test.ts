/**
 * AR-07 批次3：中等缺口关键模块分支补测。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CurrentPermissionSelectionStore } from "../../../packages/core/src/tools/current-permission-selection.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { LocalSensitiveOperationClassifier } from "../../../packages/core/src/tools/local-sensitive-operation-classifier.js";
import { AgentRunWatchdog } from "../../../packages/core/src/orchestration/agent-run-watchdog.js";
import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";
import {
  CanonicalResourceIdentityResolver,
  ReadSuppressionLedger,
} from "../../../packages/core/src/tools/read-suppression-ledger.js";
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
const ISO = "2026-09-10T00:00:00.000Z";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ar07c-"));
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

describe("AR-07 批次3：CurrentPermissionSelectionStore", () => {
  it("非法选择文档 fail-closed；陈旧 revision 切换被拒绝", async () => {
    const store = new CurrentPermissionSelectionStore({ baseDirectory: temporaryDirectory });
    const settingsDirectory = path.join(temporaryDirectory, "settings");
    await fs.mkdir(settingsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(settingsDirectory, "permission-profile-current.json"),
      JSON.stringify({
        schemaVersion: 1,
        selectedReference: { kind: "bogus", profileId: "x" },
        revision: 1,
        updatedAtIso: ISO,
      }),
      "utf8",
    );
    await expect(store.readSelection()).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
    await fs.writeFile(
      path.join(settingsDirectory, "permission-profile-current.json"),
      JSON.stringify({
        schemaVersion: 1,
        selectedReference: { kind: "builtin", profileId: "assist" },
        revision: 1,
        updatedAtIso: ISO,
      }),
      "utf8",
    );
    await expect(
      store.switchSelection({
        selectedReference: { kind: "builtin", profileId: "assist" },
        expectedRevision: 5,
      } as never),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });
});

describe("AR-07 批次3：PermissionCapabilityCatalog", () => {
  it("能力 ID 可枚举；未映射工具拒绝执行与注册", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.getCapabilityIds().length).toBeGreaterThan(0);
    expect(
      catalog.evaluateToolPermission({ toolName: "no-such-tool", capabilityDecisions: {} }),
    ).toBe("deny");
    expect(() => catalog.assertToolMapped({ name: "no-such-tool" } as never)).toThrow();
  });
});

describe("AR-07 批次3：LocalSensitiveOperationClassifier", () => {
  it("未知工具但声明破坏性 mutationKind → file-mutation", () => {
    const classifier = new LocalSensitiveOperationClassifier();
    const classification = classifier.classifyOperation({
      toolName: "custom-mutator",
      mutationKind: "overwrite",
    });
    expect(classification.operationClass).toBe("file-mutation");
    expect(classification.isProvablyReadOnly).toBe(false);
  });
});

describe("AR-07 批次3：AgentRunWatchdog 默认值与工具进展", () => {
  it("默认检查间隔与运行中工具视为有效进展", () => {
    const defaultWatchdog = new AgentRunWatchdog();
    expect(defaultWatchdog.getCheckIntervalMilliseconds()).toBe(5_000);

    const stalledWithTool = new AgentRunWatchdog({
      nowUnixMilliseconds: () => 10_000,
      latestStreamEventUnixMilliseconds: () => 0,
      latestTaskRevisionChangeUnixMilliseconds: () => 0,
      hasRunningToolCall: () => true,
      modelNoProgressTimeoutMilliseconds: 10,
    });
    const assessment = stalledWithTool.assess();
    expect(assessment.status).toBe("healthy");
    expect(assessment.reason).toContain("工具");
  });
});

describe("AR-07 批次3：UnboundedAgentInstanceRegistry 边界", () => {
  it("未登记实例准入/回收报错；回收后存活计数下降", () => {
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 2,
      maxQueueLength: 2,
      currentOccupiedSlots: () => 0,
      canRecycle: () => true,
    });
    expect(() => registry.requestAdmission("missing-agent")).toThrow();
    expect(() => registry.recycleInstance("missing-agent")).toThrow();
    const instance = registry.createInstance({ agentRole: "tertiary", missionId: "mission-1" });
    expect(registry.getLiveInstanceCount()).toBe(1);
    registry.recycleInstance(instance.agentInstanceId);
    expect(registry.getLiveInstanceCount()).toBe(0);
  });
});

describe("AR-07 批次3：ReadSuppressionLedger", () => {
  it("空账本计数为 0；目录路径指纹读取安全返回 null", async () => {
    const ledger = new ReadSuppressionLedger();
    expect(ledger.getEntryCount()).toBe(0);
    const resolver = new CanonicalResourceIdentityResolver();
    expect(await resolver.currentFingerprint(temporaryDirectory)).toBeNull();
  });
});

describe("AR-07 批次3：PolicyWrapper 决策与无实现工具", () => {
  it("引擎 deny → tool-permission-denied；引擎 allow → 正常执行", async () => {
    const reference = {
      permissionProfileId: "builtin:assist",
      displayName: "assist",
      isBuiltin: true,
      revision: 1,
      catalogVersion: 1,
    };
    const denyWrapper = buildWrapper({
      configurablePermissionPolicyEngine: { decide: async () => ({ decision: "deny" }) } as never,
      currentPermissionProfileReference: reference,
    });
    const denied = await denyWrapper.execute(
      "readFile",
      JSON.stringify({ filePath: path.join(temporaryDirectory, "x.txt") }),
      "call-deny",
      new AbortController().signal,
    );
    expect(denied).toMatchObject({ errorCode: "tool-permission-denied" });

    const targetPath = path.join(temporaryDirectory, "ok.txt");
    await fs.writeFile(targetPath, "内容", "utf8");
    const allowWrapper = buildWrapper({
      configurablePermissionPolicyEngine: { decide: async () => ({ decision: "allow" }) } as never,
      currentPermissionProfileReference: reference,
    });
    const allowed = await allowWrapper.execute(
      "readFile",
      JSON.stringify({ filePath: targetPath }),
      "call-allow",
      new AbortController().signal,
    );
    expect(allowed.kind).toBe("success");
  });
});
