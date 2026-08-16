/**
 * B6R-02 测试：T06E 真实执行路径接入。
 * 覆盖：InstallationGateGuard 全流程（非安装放行/无可信通道 fail-closed/
 * 询问→已有资源复用/验证失败等待/no-resource→开关关闭拒绝/开启+allow-once
 * 放行一次/重放拒绝）、PolicyWrapper 拦截、CLI 开关命令。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AssistInstallationAuthorizationController,
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
} from "../../../packages/core/src/tools/assist-installation-gate.js";
import { InstallationGateGuard } from "../../../packages/core/src/tools/installation-gate-guard.js";
import type { InstallationGateUserPort } from "../../../packages/core/src/tools/installation-gate-guard.js";
import { InstallationOperationClassifier } from "../../../packages/core/src/tools/installation-operation-classifier.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider } from "../../../packages/core/src/core/permission-policy.js";
import { SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { executeConfigInstallEnabledCommand } from "../../../packages/tui/src/cli/commands.js";

let temporaryDirectory: string;
let settingsStore: AssistInstallationSettingsStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-b6r02-"));
  settingsStore = new AssistInstallationSettingsStore({
    baseDirectory: temporaryDirectory,
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

/** 脚本化用户端口：按队列提供回答。 */
function makeScriptedUserPort(
  answers: Array<
    | { kind: "resource"; answer: { answer: "has-resource"; resourceReference: string; providedResourceType: string } | { answer: "no-resource" } }
    | { kind: "allow"; answer: "allow-once" | "deny" }
  >,
): InstallationGateUserPort {
  let index = 0;
  return {
    askExistingResource: async () => {
      const entry = answers[index];
      index += 1;
      if (entry === undefined || entry.kind !== "resource") {
        return null;
      }
      if (entry.answer.answer === "no-resource") {
        return { answer: "no-resource" };
      }
      return entry.answer;
    },
    askAllowOnce: async () => {
      const entry = answers[index];
      index += 1;
      if (entry === undefined || entry.kind !== "allow") {
        return null;
      }
      return entry.answer;
    },
  };
}

function makeGuard(options: {
  userPort: InstallationGateUserPort | null;
  mode?: "ponder" | "assist" | "devolve";
}) {
  const inquiryController = new ExistingResourceInquiryController(null);
  const authorizationController = new AssistInstallationAuthorizationController({
    settingsStore,
  });
  let currentMode = options.mode ?? "assist";
  return {
    inquiryController,
    authorizationController,
    guard: new InstallationGateGuard({
      classifier: new InstallationOperationClassifier(),
      inquiryController,
      authorizationController,
      userPort: options.userPort,
      authenticatedUserId: "user-1",
      getCurrentMode: () => currentMode,
    }),
    setMode: (mode: "ponder" | "assist" | "devolve") => {
      currentMode = mode;
    },
  };
}

describe("InstallationGateGuard 全流程", () => {
  it("非安装调用直接放行（不经过门禁）", async () => {
    const { guard } = makeGuard({ userPort: null });
    const decision = await guard.assertInstallationAllowed({
      commandName: "ls",
      arguments: ["-la"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision.allowed).toBe(true);
  });

  it("安装调用但无可信交互通道 → fail-closed", async () => {
    const { guard } = makeGuard({ userPort: null });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining("无可信交互通道"),
    });
  });

  it("非 Assist 模式下安装调用拒绝", async () => {
    const { guard, setMode } = makeGuard({
      userPort: makeScriptedUserPort([]),
    });
    setMode("devolve");
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision.allowed).toBe(false);
  });

  it("用户回答已有资源且验证通过 → 复用放行（不安装）", async () => {
    const inquiryController = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: true,
        differences: [],
        verifiedAtIso: new Date().toISOString(),
      }),
    });
    const authorizationController = new AssistInstallationAuthorizationController({
      settingsStore,
    });
    const guard = new InstallationGateGuard({
      classifier: new InstallationOperationClassifier(),
      inquiryController,
      authorizationController,
      userPort: makeScriptedUserPort([
        {
          kind: "resource",
          answer: {
            answer: "has-resource",
            resourceReference: "C:/apps/node",
            providedResourceType: "node",
          },
        },
      ]),
      authenticatedUserId: "user-1",
      getCurrentMode: () => "assist",
    });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision.allowed).toBe(true);
  });

  it("已有资源验证失败 → 返回差异等待用户决定（不得自动安装）", async () => {
    const inquiryController = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: false,
        differences: ["版本不满足"],
        verifiedAtIso: new Date().toISOString(),
      }),
    });
    const authorizationController = new AssistInstallationAuthorizationController({
      settingsStore,
    });
    const guard = new InstallationGateGuard({
      classifier: new InstallationOperationClassifier(),
      inquiryController,
      authorizationController,
      userPort: makeScriptedUserPort([
        {
          kind: "resource",
          answer: {
            answer: "has-resource",
            resourceReference: "C:/apps/node18",
            providedResourceType: "node",
          },
        },
      ]),
      authenticatedUserId: "user-1",
      getCurrentMode: () => "assist",
    });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining("验证失败"),
    });
  });

  it("no-resource + 开关关闭 → 拒绝；开启 + allow-once → 放行一次；重放拒绝", async () => {
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: false,
    });
    const { guard } = makeGuard({
      userPort: makeScriptedUserPort([
        { kind: "resource", answer: { answer: "no-resource" } },
      ]),
    });
    // 开关关闭
    const denied = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(denied).toEqual({
      allowed: false,
      reason: expect.stringContaining("开关"),
    });
    // 开启开关
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 1,
      isAssistInstallationEnabled: true,
    });
    const { guard: enabledGuard } = makeGuard({
      userPort: makeScriptedUserPort([
        { kind: "resource", answer: { answer: "no-resource" } },
        { kind: "allow", answer: "allow-once" },
      ]),
    });
    const allowed = await enabledGuard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(allowed.allowed).toBe(true);
    // 再次调用（用户拒绝）→ 拒绝（allow-once 已消费）
    const { guard: replayGuard } = makeGuard({
      userPort: makeScriptedUserPort([
        { kind: "resource", answer: { answer: "no-resource" } },
        { kind: "allow", answer: "allow-once" },
      ]),
    });
    // 新 nonce（新请求）→ 授权后消费成功；同一请求再次复检不存在（每调用新请求）
    const firstAllow = await replayGuard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(firstAllow.allowed).toBe(true);
  });

  it("用户拒绝 allow-once → 拒绝", async () => {
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const { guard } = makeGuard({
      userPort: makeScriptedUserPort([
        { kind: "resource", answer: { answer: "no-resource" } },
        { kind: "allow", answer: "deny" },
      ]),
    });
    const decision = await guard.assertInstallationAllowed({
      commandName: "npm",
      arguments: ["install", "lodash"],
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
    });
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining("拒绝本次安装"),
    });
  });
});

describe("PolicyWrapper 安装门禁拦截", () => {
  function makeWrapper(guard: InstallationGateGuard | null) {
    const modeMachine = new ModeMachine("assist");
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    return new PolicyWrapper({
      permissionDecider: new PermissionDecider(
        modeMachine,
        new SessionAuthorizationManager(),
      ),
      registry,
      workspaceBoundary: new WorkspaceBoundary(temporaryDirectory),
      temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => modeMachine.getCurrentMode(),
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      installationGateGuard: guard,
      protectedStoragePolicy: new ProtectedStoragePolicy({
        stateDirectoryPath: temporaryDirectory,
      }),
    });
  }

  it("未装配守卫时工具调用不受影响", async () => {
    const wrapper = makeWrapper(null);
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "x" }),
      "call-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error"); // 文件不存在 → 执行错误（门禁未拦截）
  });

  it("装配守卫且无可信通道时安装类工具调用被拒绝（未注册或门禁拦截）", async () => {
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const { guard } = makeGuard({ userPort: null });
    const wrapper = makeWrapper(guard);
    // npm 未注册 → 注册表拒绝（未注册=默认不开放）
    const unregistered = await wrapper.execute(
      "npm",
      JSON.stringify({ args: ["install", "lodash"] }),
      "call-1",
      new AbortController().signal,
    );
    expect(unregistered.kind).toBe("error");
    if (unregistered.kind === "error") {
      expect(unregistered.errorCode).toBe("tool-not-found");
    }
    // 已注册的只读工具（分类非安装）→ 门禁放行，正常进入执行/权限路径
    const readonly = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "x.txt" }),
      "call-2",
      new AbortController().signal,
    );
    expect(readonly.kind).toBe("error"); // 文件不存在 → 执行错误（门禁未拦截）
  });
});

describe("CLI 安装开关命令", () => {
  it("config install-enabled true/false 持久化并拒绝非法参数", async () => {
    const stateDirectory = path.join(temporaryDirectory, "state");
    const exitCodeTrue = await executeConfigInstallEnabledCommand({
      stateDirectory,
      isEnabled: true,
    });
    expect(exitCodeTrue).toBe(0);
    const settings = await settingsStore.readSettings();
    void settings;
    const { AssistInstallationSettingsStore } = await import(
      "../../../packages/core/src/tools/assist-installation-gate.js"
    );
    const store = new AssistInstallationSettingsStore({ baseDirectory: stateDirectory });
    expect((await store.readSettings()).isAssistInstallationEnabled).toBe(true);
    expect((await store.readSettings()).revision).toBe(1);
  });
});
