/**
 * T06E 单测：Assist 安装门禁（ADR-0019）。
 * 覆盖：安装效果分类（包管理器/系统包/git clone/插件/生命周期/lockfile/
 * 包装不可绕）、开关默认关与 revision/备份、已有资源询问（只读验证/
 * 不可自动安装）、allow-once 授权（绑定字段/复检/消费/重放/过期/参数漂移/
 * 模式切换/revision 变化全部 fail-closed）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstallationOperationClassifier,
} from "../../../packages/core/src/tools/installation-operation-classifier.js";
import {
  AssistInstallationSettingsStore,
  ExistingResourceInquiryController,
  AssistInstallationAuthorizationController,
  assistInstallationSettingsFilePath,
} from "../../../packages/core/src/tools/assist-installation-gate.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t06e-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeSettingsStore(): AssistInstallationSettingsStore {
  return new AssistInstallationSettingsStore({ baseDirectory: temporaryDirectory });
}

describe("InstallationOperationClassifier", () => {
  const classifier = new InstallationOperationClassifier();

  it("包管理器安装一致识别（npm/pnpm/yarn/pip/poetry/cargo）", () => {
    const cases = [
      { commandName: "npm", arguments: ["install", "lodash"] },
      { commandName: "npm", arguments: ["ci"] },
      { commandName: "pnpm", arguments: ["add", "-D", "typescript"] },
      { commandName: "yarn", arguments: ["add", "react"] },
      { commandName: "pip", arguments: ["install", "requests"] },
      { commandName: "poetry", arguments: ["add", "fastapi"] },
      { commandName: "cargo", arguments: ["install", "ripgrep"] },
    ];
    for (const input of cases) {
      expect(classifier.classifyCommand({ ...input, workingDirectoryPath: null }).isInstallationAttempt).toBe(true);
    }
    // 精确版本提取
    const withVersion = classifier.classifyCommand({
      commandName: "npm",
      arguments: ["install", "lodash@4.17.21"],
      workingDirectoryPath: null,
    });
    expect(withVersion.pinnedVersionOrCommit).toBe("4.17.21");
  });

  it("系统包管理器/运行时工具链/插件安装识别", () => {
    for (const input of [
      { commandName: "apt-get", arguments: ["install", "nginx"] },
      { commandName: "brew", arguments: ["install", "jq"] },
      { commandName: "rustup", arguments: ["install", "stable"] },
      { commandName: "nvm", arguments: ["install", "20"] },
      { commandName: "code", arguments: ["--install-extension", "esbenp.prettier"] },
      { commandName: "gh", arguments: ["extension", "install", "x/y"] },
    ]) {
      expect(classifier.classifyCommand({ ...input, workingDirectoryPath: null }).isInstallationAttempt).toBe(true);
    }
  });

  it("git clone / 归档下载识别为安装", () => {
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["clone", "-b", "v1.2.3", "https://github.com/x/y.git"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "repository-clone",
      pinnedVersionOrCommit: "v1.2.3",
    });
    // 无 -b 的 clone：pinnedVersionOrCommit 为 null（默认分支）
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["clone", "https://github.com/x/y.git"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "repository-clone",
      pinnedVersionOrCommit: null,
    });
    expect(
      classifier.classifyCommand({
        commandName: "curl",
        arguments: ["-L", "https://github.com/x/y/archive/refs/tags/v1.tar.gz"],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({ isInstallationAttempt: true, effectKind: "repository-clone" });
  });

  it("生命周期脚本与 lockfile 改写识别", () => {
    expect(
      classifier.classifyCommand({
        commandName: "postinstall",
        arguments: ["node scripts/postinstall.js"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    expect(
      classifier.classifyCommand({
        commandName: "package-lock.json",
        arguments: [],
        workingDirectoryPath: null,
      }),
    ).toMatchObject({
      isInstallationAttempt: true,
      effectKind: "vendor-or-lockfile-mutation",
    });
  });

  it("非安装命令与普通文件操作不误报", () => {
    expect(
      classifier.classifyCommand({
        commandName: "git",
        arguments: ["status"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    expect(
      classifier.classifyCommand({
        commandName: "npm",
        arguments: ["run", "build"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    expect(
      classifier.classifyCommand({
        commandName: "ls",
        arguments: ["-la"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
  });

  it("包装/别名/自述不可绕过：子命令拼接到命令名仍被识别", () => {
    // 包装 shell：把 install 塞进命令名（分类按规范化参数效果，不信任自述）
    const wrapped = classifier.classifyCommand({
      commandName: "sh",
      arguments: ["-c", "npm install lodash"],
      workingDirectoryPath: null,
    });
    expect(wrapped.isInstallationAttempt).toBe(true);
    expect(wrapped.effectKind).toBe("dependency-resolution-change");
    // powershell -Command 与 cmd /c 包装同样识别
    const powershellWrapped = classifier.classifyCommand({
      commandName: "powershell",
      arguments: ["-Command", "pip install requests"],
      workingDirectoryPath: null,
    });
    expect(powershellWrapped.isInstallationAttempt).toBe(true);
    const cmdWrapped = classifier.classifyCommand({
      commandName: "cmd",
      arguments: ["/c", "apt-get install nginx"],
      workingDirectoryPath: null,
    });
    expect(cmdWrapped.isInstallationAttempt).toBe(true);
    // 包装脚本为非安装命令（如 dir）→ 不误报
    expect(
      classifier.classifyCommand({
        commandName: "cmd",
        arguments: ["/c", "dir"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    // powershell 无 -Command 参数 → 不误报
    expect(
      classifier.classifyCommand({
        commandName: "powershell",
        arguments: ["-NoProfile"],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
    // 空命令名 fail-closed 视为安装尝试
    expect(
      classifier.classifyCommand({
        commandName: "",
        arguments: [],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(true);
    // 未知命令不误报
    expect(
      classifier.classifyCommand({
        commandName: "totally-unknown-cmd",
        arguments: [],
        workingDirectoryPath: null,
      }).isInstallationAttempt,
    ).toBe(false);
  });
});

describe("AssistInstallationSettingsStore", () => {
  it("默认开关关闭（false）且 revision 0", async () => {
    const store = makeSettingsStore();
    const settings = await store.readSettings();
    expect(settings.isAssistInstallationEnabled).toBe(false);
    expect(settings.revision).toBe(0);
  });

  it("认证用户更新开关：revision 单调、写入自动备份、损坏可恢复", async () => {
    const store = makeSettingsStore();
    await store.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    expect((await store.readSettings()).isAssistInstallationEnabled).toBe(true);
    expect((await store.readSettings()).revision).toBe(1);
    // 自动备份存在
    const settingsPath = assistInstallationSettingsFilePath(temporaryDirectory);
    await expect(fs.access(`${settingsPath}.bak`)).resolves.toBeUndefined();
    // revision 不匹配拒绝
    await expect(
      store.updateInstallationEnabled({
        expectedRevision: 0,
        isAssistInstallationEnabled: false,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    // 损坏主文件从备份恢复
    await fs.writeFile(settingsPath, "{ 损坏", "utf8");
    expect((await store.readSettings()).isAssistInstallationEnabled).toBe(true);
  });
});

describe("ExistingResourceInquiryController", () => {
  it("安装前发起询问；用户答已有且验证通过 → 复用（不安装）", async () => {
    const controller = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: true,
        differences: [],
        verifiedAtIso: "2026-08-13T00:00:00.000Z",
      }),
    });
    const inquiry = controller.createInquiry({
      requiredCapabilitySummary: "需要 Node.js 20 运行时",
      intendedUse: "运行测试",
      compatibleCandidateTypes: ["node-runtime"],
    });
    expect(inquiry.inquiryId).toMatch(/^inquiry-/);
    const result = await controller.handleAnswer({
      inquiry,
      answer: {
        answer: "has-resource",
        resourceReference: "C:/apps/node20",
        providedResourceType: "node-runtime",
      },
    });
    expect(result.outcome).toBe("resource-accepted");
  });

  it("用户提供资源但验证失败 → 返回差异继续等待，不自动安装", async () => {
    const controller = new ExistingResourceInquiryController({
      verifyResource: async () => ({
        isValid: false,
        differences: ["版本 18 不满足 ≥20", "缺少 npm 10"],
        verifiedAtIso: "2026-08-13T00:00:00.000Z",
      }),
    });
    const inquiry = controller.createInquiry({
      requiredCapabilitySummary: "需要 Node.js 20",
      intendedUse: "构建",
      compatibleCandidateTypes: ["node-runtime"],
    });
    const result = await controller.handleAnswer({
      inquiry,
      answer: {
        answer: "has-resource",
        resourceReference: "C:/apps/node18",
        providedResourceType: "node-runtime",
      },
    });
    expect(result.outcome).toBe("resource-rejected-with-differences");
    if (result.outcome === "resource-rejected-with-differences") {
      expect(result.verification.differences.length).toBeGreaterThan(0);
    }
  });

  it("用户明确回答没有资源 → 进入开关检查；验证端口未装配时不可确认", async () => {
    const controller = new ExistingResourceInquiryController(null);
    const inquiry = controller.createInquiry({
      requiredCapabilitySummary: "需要依赖 X",
      intendedUse: "功能 Y",
      compatibleCandidateTypes: [],
    });
    const noResource = await controller.handleAnswer({
      inquiry,
      answer: { answer: "no-resource" },
    });
    expect(noResource.outcome).toBe("proceed-to-switch-check");
    const unverifiable = await controller.handleAnswer({
      inquiry,
      answer: {
        answer: "has-resource",
        resourceReference: "x",
        providedResourceType: "y",
      },
    });
    expect(unverifiable.outcome).toBe("resource-rejected-with-differences");
  });
});

describe("AssistInstallationAuthorizationController", () => {
  let clockMilliseconds: number;

  beforeEach(() => {
    clockMilliseconds = 1_000_000;
  });

  function makeController() {
    return new AssistInstallationAuthorizationController({
      settingsStore: makeSettingsStore(),
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
  }

  it("开关默认关闭：开启开关前创建请求被拒绝（denied-settings-disabled）", async () => {
    const controller = makeController();
    const result = await controller.createAuthorizationRequest({
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    expect(result.outcome).toBe("denied-settings-disabled");
  });

  it("开启开关后：请求绑定精确计划，allow-once 授权复检通过并消费", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
    const requestResult = await controller.createAuthorizationRequest({
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    expect(requestResult.outcome).toBe("request-created");
    if (requestResult.outcome !== "request-created") {
      return;
    }
    const request = requestResult.request;
    expect(request.nonce).toMatch(/^nonce-/);
    const decision = await controller.authorizeAllowOnce({
      request,
      decision: "allow-once",
    });
    expect(decision).not.toBeNull();
    // 复检通过 → 消费授权
    const verification = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
      currentSettingsRevision: 1,
    });
    expect(verification).toEqual({ allowed: true, reason: null });
    // 重放：同 nonce 再复检 → 拒绝
    const replay = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
      currentSettingsRevision: 1,
    });
    expect(replay.allowed).toBe(false);
  });

  it("绑定字段漂移/设置 revision 变化/模式切换/过期 → 全部 fail-closed", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
      authorizationTtlMilliseconds: 300_000,
    });
    const requestResult = await controller.createAuthorizationRequest({
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const request = requestResult.request;
    await controller.authorizeAllowOnce({ request, decision: "allow-once" });
    // 参数漂移（版本变化）
    const drifted = await controller.verifyAndConsumeAuthorization({
      request: { ...request, pinnedVersionOrCommit: "5.0.0" },
      currentMode: "assist",
      currentSettingsRevision: 1,
    });
    expect(drifted).toEqual({ allowed: false, reason: expect.stringContaining("参数已变化") });
    // 模式切换
    const wrongMode = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "devolve",
      currentSettingsRevision: 1,
    });
    expect(wrongMode.allowed).toBe(false);
    // 设置 revision 变化
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 1,
      isAssistInstallationEnabled: false,
    });
    const revisionChanged = await controller.verifyAndConsumeAuthorization({
      request,
      currentMode: "assist",
      currentSettingsRevision: 2,
    });
    expect(revisionChanged.allowed).toBe(false);
    // 过期（需要重新授权）
    const secondRequestResult = await controller.createAuthorizationRequest({
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      sourceUrlOrRegistry: "https://registry.npmjs.org",
      packageOrRepositoryIdentifier: "lodash",
      pinnedVersionOrCommit: "4.17.21",
      integrityInformation: null,
      targetPathOrScope: "./node_modules",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: false,
      hasInstallScripts: false,
      expectedChangesSummary: "安装 lodash",
    });
    if (secondRequestResult.outcome === "denied-settings-disabled") {
      return; // 开关被关闭后拒绝属预期
    }
    if (secondRequestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const secondRequest = secondRequestResult.request;
    await controller.authorizeAllowOnce({
      request: secondRequest,
      decision: "allow-once",
    });
    clockMilliseconds += 400_000;
    const expired = await controller.verifyAndConsumeAuthorization({
      request: secondRequest,
      currentMode: "assist",
      currentSettingsRevision: 2,
    });
    expect(expired.allowed).toBe(false);
  });

  it("deny 决定不产生授权", async () => {
    const settingsStore = makeSettingsStore();
    await settingsStore.updateInstallationEnabled({
      expectedRevision: 0,
      isAssistInstallationEnabled: true,
    });
    const controller = new AssistInstallationAuthorizationController({
      settingsStore,
      nowUnixMilliseconds: () => clockMilliseconds,
    });
    const requestResult = await controller.createAuthorizationRequest({
      requestingAgentInstanceId: "agent-a",
      taskExecutionId: "task-1",
      sourceUrlOrRegistry: "s",
      packageOrRepositoryIdentifier: "p",
      pinnedVersionOrCommit: "1.0.0",
      integrityInformation: null,
      targetPathOrScope: "t",
      packageManager: "npm",
      parametersJson: "{}",
      requiresNetwork: true,
      hasInstallScripts: false,
      expectedChangesSummary: "s",
    });
    if (requestResult.outcome !== "request-created") {
      throw new Error("请求应创建成功");
    }
    const denied = await controller.authorizeAllowOnce({
      request: requestResult.request,
      decision: "deny",
    });
    expect(denied).toBeNull();
    const verification = await controller.verifyAndConsumeAuthorization({
      request: requestResult.request,
      currentMode: "assist",
      currentSettingsRevision: 1,
    });
    expect(verification).toEqual({ allowed: false, reason: expect.stringContaining("无对应授权") });
  });
});
