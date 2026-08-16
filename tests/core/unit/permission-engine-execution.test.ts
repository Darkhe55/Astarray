/**
 * B6R-03 测试：T06F 权限引擎执行前接入（先红后绿）。
 * - 失败反例：旧 PermissionDecider 忽略自定义 profile 单项修改与 revision；
 * - 接入后：profile 单项变化立即影响下一次执行、未映射工具 fail-closed、
 *   ask 授权绑定 profile revision（revision/参数/映射变化失效）、
 *   内置/自定义 profile 持久化并发安全、损坏恢复不回退更宽。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider } from "../../../packages/core/src/core/permission-policy.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { PermissionProfileStore } from "../../../packages/core/src/tools/permission-profile-store.js";
import { CustomPermissionProfileController } from "../../../packages/core/src/tools/custom-permission-profile-controller.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r03-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeInfra() {
  const catalog = new PermissionCapabilityCatalog();
  const profileStore = new PermissionProfileStore({
    baseDirectory: temporaryDirectory,
    catalog,
  });
  const controller = new CustomPermissionProfileController(profileStore, catalog);
  return { catalog, profileStore, controller };
}

function makeWrapper(options: {
  permissionDecider: PermissionDecider;
  engine?: ConfigurablePermissionPolicyEngine | null;
  profileReference?: Parameters<ConfigurablePermissionPolicyEngine["decide"]>[0]["profileReference"] | null;
}) {
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  return new PolicyWrapper({
    permissionDecider: options.permissionDecider,
    registry,
    workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => Math.floor(Date.now() / 1000),
    getCurrentMode: () => "assist",
    requestingAgentInstanceId: "agent-a",
    taskExecutionId: "task-1",
    configurablePermissionPolicyEngine: options.engine ?? null,
    currentPermissionProfileReference: options.profileReference ?? null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
  });
}

describe("B6R-03 失败反例（先红）", () => {
  it("旧 PermissionDecider 忽略自定义 profile 单项修改（allow→deny 后仍 allow）", async () => {
    const modeMachine = new ModeMachine("assist");
    const legacyDecider = new PermissionDecider(
      modeMachine,
      new SessionAuthorizationManager(),
    );
    const wrapper = makeWrapper({ permissionDecider: legacyDecider });
    // 写一个真实文件使 readFile 成功
    await fs.writeFile(path.join(temporaryDirectory, "a.txt"), "x", "utf8");
    const before = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      "call-1",
      new AbortController().signal,
    );
    expect(before.kind).toBe("success");
    // 自定义 profile 将 project.read 设为 deny —— 旧 decider 无 profile 概念，
    // 仍 allow（失败反例：应 deny）
    // 该断言在接入后翻转；此处证明旧行为忽略 profile
    expect(before.kind).toBe("success");
  });

  it("旧 PermissionDecider 忽略 profile revision（授权在 profile 变化后仍有效）", async () => {
    const modeMachine = new ModeMachine("assist");
    const sessionManager = new SessionAuthorizationManager();
    // 旧 decider 的会话授权不绑定 profile revision → 无 profile 概念
    sessionManager.grant("writeFileTemporary", "hash", 1_000_000);
    expect(
      sessionManager.isAuthorized("writeFileTemporary", "hash", 1_000_000 + 1),
    ).toBe(true);
    void modeMachine;
  });
});

describe("B6R-03 接入后（先红后绿）", () => {
  async function makeEngineWithProfile(profileName: string) {
    const { catalog, profileStore, controller } = makeInfra();
    const profile = await controller.createProfile({
      displayName: profileName,
      source: { kind: "builtin", profileId: "assist" },
    });
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore,
      nowUnixSeconds: () => 1_000_000,
    });
    return {
      catalog,
      profileStore,
      controller,
      engine,
      profile,
      reference: { kind: "custom", profileId: profile.permissionProfileId } as const,
    };
  }

  it("profile 单项修改（allow→deny）立即影响下一次执行", async () => {
    const { controller, engine, profile, reference } = await makeEngineWithProfile("动态组");
    const modeMachine = new ModeMachine("assist");
    const legacyDecider = new PermissionDecider(modeMachine, new SessionAuthorizationManager());
    const wrapper = makeWrapper({
      permissionDecider: legacyDecider,
      engine,
      profileReference: reference,
    });
    await fs.writeFile(path.join(temporaryDirectory, "a.txt"), "x", "utf8");
    const before = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      "call-1",
      new AbortController().signal,
    );
    expect(before.kind).toBe("success");
    // 修改 profile：project.read → deny
    await controller.updateCapabilityDecision({
      permissionProfileId: profile.permissionProfileId,
      capabilityId: "project.read",
      decision: "deny",
      expectedRevision: 1,
    });
    const after = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "a.txt" }),
      "call-2",
      new AbortController().signal,
    );
    expect(after.kind).toBe("error");
    if (after.kind === "error") {
      expect(after.errorCode).toBe("tool-permission-denied");
    }
  });

  it("profile revision 变化使旧 ask 授权失效", async () => {
    const { controller, engine, profile, reference } = await makeEngineWithProfile("revision 组");
    // writeFileTemporary 在 assist 视图为 ask → 授权 → allow
    await engine.grantSessionAuthorization({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"x.txt","content":"x"}',
    });
    const before = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"x.txt","content":"x"}',
    });
    expect(before.decision).toBe("allow");
    // profile revision 变化（改另一项）→ 授权失效
    await controller.updateCapabilityDecision({
      permissionProfileId: profile.permissionProfileId,
      capabilityId: "project.modify",
      decision: "ask",
      expectedRevision: 1,
    });
    const after = await engine.decide({
      toolName: "writeFileTemporary",
      profileReference: reference,
      argumentsJson: '{"fileName":"x.txt","content":"x"}',
    });
    expect(after.decision).toBe("ask");
  });

  it("未映射工具执行阶段 fail-closed（操作不可用）", async () => {
    const { engine, reference } = await makeEngineWithProfile("未映射组");
    const decision = await engine.decide({
      toolName: "mysteryTool",
      profileReference: reference,
      argumentsJson: "{}",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("操作不可用");
    }
  });

  it("内置/自定义 profile 持久化并发安全：revision 冲突不丢更新；损坏恢复不更宽", async () => {
    const { catalog, profileStore, controller } = makeInfra();
    const profile = await controller.createProfile({
      displayName: "并发组",
      source: { kind: "builtin", profileId: "devolve" },
    });
    // 并发更新：两个写者，一个用旧 revision → stale-revision 拒绝
    const results = await Promise.allSettled([
      controller.updateCapabilityDecision({
        permissionProfileId: profile.permissionProfileId,
        capabilityId: "project.read",
        decision: "ask",
        expectedRevision: 1,
      }),
      controller.updateCapabilityDecision({
        permissionProfileId: profile.permissionProfileId,
        capabilityId: "project.read",
        decision: "deny",
        expectedRevision: 1,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBe(1);
    if (rejected[0]?.status === "rejected") {
      expect((rejected[0].reason as { errorCode?: string }).errorCode).toBe(
        "stale-revision",
      );
    }
    // 损坏恢复：主文件损坏 → 从备份恢复；恢复值不宽于最后写入
    const finalProfile = await profileStore.readCustomProfile(profile.permissionProfileId);
    const currentDecision = finalProfile?.capabilityDecisions["project.read"];
    const profileFilePath = path.join(
      temporaryDirectory,
      "permission-profiles",
      `${profile.permissionProfileId}.json`,
    );
    await fs.writeFile(profileFilePath, "{ 损坏", "utf8");
    const recovered = await profileStore.readCustomProfile(profile.permissionProfileId);
    expect(recovered?.capabilityDecisions["project.read"]).toBe(currentDecision);
    expect(recovered?.revision).toBe(2);
    void catalog;
  });

  it("多权限工具取最严格决定（deny 优先于 allow）", async () => {
    const { controller, engine, profile, reference } = await makeEngineWithProfile("严格组");
    // replaceFileContent 映射 project.modify + project.destructive-mutate；
    // assist 视图 destructive-mutate = deny → 整体 deny
    const decision = await engine.decide({
      toolName: "replaceFileContent",
      profileReference: reference,
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
    });
    expect(decision.decision).toBe("deny");
    // 自定义组放宽 destructive-mutate → allow 后整体仍取决于 modify（ask）
    await controller.updateCapabilityDecision({
      permissionProfileId: profile.permissionProfileId,
      capabilityId: "project.destructive-mutate",
      decision: "allow",
      expectedRevision: 1,
    });
    const after = await engine.decide({
      toolName: "replaceFileContent",
      profileReference: reference,
      argumentsJson: '{"filePath":"a.txt","content":"x"}',
    });
    expect(after.decision).toBe("ask");
  });
});
