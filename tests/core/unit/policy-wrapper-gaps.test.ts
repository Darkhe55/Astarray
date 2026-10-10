/**
 * B6R-11：PolicyWrapper 缺口分支（引擎未装配拒绝授予 232、
 * 注册但无实现工具 → tool-execution-failed 298）。
 */
import { describe, expect, it } from "vitest";

import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider } from "../../../packages/core/src/core/permission-policy.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function makeWrapper(overrides: Partial<ConstructorParameters<typeof PolicyWrapper>[0]> = {}) {
  const modeMachine = new ModeMachine("assist");
  const registry = new ToolRegistry();
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(
      modeMachine,
      new SessionAuthorizationManager(),
    ),
    registry,
    workspaceBoundary: new WorkspaceBoundary(process.cwd()),
    temporaryDirectoryPath: ".tmp",
    workerAllowedToolNames: null,
    nowUnixSeconds: () => Math.floor(Date.now() / 1000),
    getCurrentMode: () => modeMachine.getCurrentMode(),
    requestingAgentInstanceId: "agent-a",
    taskExecutionId: "task-1",
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: ".astarray-test",
    }),
    ...overrides,
  });
}

describe("PolicyWrapper 缺口分支", () => {
  it("grantConfigurableSessionAuthorization：引擎未装配 → 拒绝（232）", async () => {
    const wrapper = makeWrapper();
    await expect(
      wrapper.grantConfigurableSessionAuthorization({
        toolName: "project.read",
        argumentsJson: "{}",
      }),
    ).rejects.toThrow(/未装配/);
  });

  it("引擎装配但 profile 引用缺失 → 拒绝（227-231）", async () => {
    const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-pw-"));
    const catalog = new PermissionCapabilityCatalog();
    const profileStore = new PermissionProfileStore({ baseDirectory, catalog });
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore,
      nowUnixSeconds: () => 1_000_000,
    });
    const wrapper = makeWrapper({
      configurablePermissionPolicyEngine: engine,
      currentPermissionProfileReference: null,
    });
    await expect(
      wrapper.grantConfigurableSessionAuthorization({
        toolName: "project.read",
        argumentsJson: "{}",
      }),
    ).rejects.toThrow(/未装配/);
    await fs.rm(baseDirectory, { recursive: true, force: true });
  });

  /**
   * RELIABILITY-01-02「提前拒绝结算」（2026-10-10 返修）：
   *
   * "提前拒绝"= 工具在**执行之前**就被拒（未注册 / 不在 Worker 子集 / 安装门禁拒绝）。
   * 这类拒绝**确定没有副作用**，必须报 `sideEffectStatus: "none"`，使范围门禁
   * **释放预留并恢复授权**，让用户修正后重跑可行。
   *
   * 缺陷：`isExecutionRefusalErrorCode` 漏掉了同样"从未执行"的 `tool-not-found`，
   * 于是未注册工具的调用被当成 `unknown` 结算 ⇒ 预留进入 `requires-reconciliation`
   * ⇒ 该逻辑操作**永久**无法重试，而实际从未发生任何副作用。
   */
  it("提前拒绝：tool-not-found（从未执行）必须报 sideEffectStatus=none，不得污染为 unknown", async () => {
    const wrapper = makeWrapper();
    const result = await wrapper.execute(
      "thisToolIsNotRegistered",
      "{}",
      "call-not-registered",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.errorCode).toBe("tool-not-found");
      // 从未进入副作用通道 ⇒ 必须允许门禁释放预留（否则永久 requires-reconciliation）
      expect(result.sideEffectStatus).toBe("none");
    }
  });

  it("提前拒绝：不在 Worker 子集（tool-permission-denied）同样必须报 none", async () => {
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    const wrapper = makeWrapper({
      registry,
      workerAllowedToolNames: new Set<string>(["someOtherTool"]),
    });
    const result = await wrapper.execute(
      "createProjectFile",
      JSON.stringify({ filePath: "x.md", content: "y" }),
      "call-outside-subset",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.errorCode).toBe("tool-permission-denied");
      expect(result.sideEffectStatus).toBe("none");
    }
  });
});
