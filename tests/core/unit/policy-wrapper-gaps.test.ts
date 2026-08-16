/**
 * B6R-11：PolicyWrapper 缺口分支（引擎未装配拒绝授予 232、
 * 注册但无实现工具 → tool-execution-failed 298）。
 */
import { describe, expect, it } from "vitest";

import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
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
});
